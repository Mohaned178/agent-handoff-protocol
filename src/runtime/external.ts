import {
  DEFAULT_REMOTE,
  isExternalActionDone,
  type ExternalActionStepDefinition,
  type ExternalActionTarget,
  type ExternalObservation,
  type PullRequestRecord,
} from "../protocol/index.ts";
import { git } from "./git.ts";
import type { PullRequestTarget } from "./pull-requests.ts";
import type { RunContext } from "./run.ts";
import { messageOf } from "./verification.ts";

/** Git never asks for credentials on a terminal nobody is at: it fails instead, and the failure is recorded. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

/**
 * An external-action step, from its derived state: made ready, its intent recorded, then the remote checked and the
 * action performed only if the check found it not done. A process that stops anywhere in that leaves the step under
 * way, and the process that resumes the run checks again before it does anything, so the action happens once.
 */
export async function advanceExternalAction(step: ExternalActionStepDefinition, index: number, run: RunContext): Promise<void> {
  const view = run.state().steps[index]!;
  switch (view.state) {
    case "blocked":
      return run.record({ type: "step_ready", stepId: step.id });
    case "ready":
      return run.record({ type: "external_action_intended", stepId: step.id, target: targetOf(step, index, run) });
    case "in_progress": {
      const action = view.action!;
      if (isExternalActionDone(action)) return run.record({ type: "step_terminal", stepId: step.id, state: "succeeded", failureClass: null });
      if (action.failure) return run.record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: "external_action_failed" });
      return checkThenPerform(step, action.target, run);
    }
    default:
      throw new Error(`step "${step.id}" is ${view.state}, so there is nothing to advance`);
  }
}

/**
 * The external-action step in hand once the run is being cancelled: nothing is started. One already under way is
 * looked at, never performed: if the remote shows it done it succeeds, since a cancel cannot take it back, and
 * otherwise it ends `cancelled`.
 */
export async function advanceCancelledExternalAction(step: ExternalActionStepDefinition, index: number, run: RunContext): Promise<void> {
  const view = run.state().steps[index]!;
  const action = view.action;
  const cancelled = () => run.record({ type: "step_terminal", stepId: step.id, state: "cancelled", failureClass: null });
  if (view.state !== "in_progress" || !action) return cancelled();
  if (isExternalActionDone(action) || action.failure) return advanceExternalAction(step, index, run);
  if (await recordCheck(step, action.target, run)) return;
  // The check found it not done, and nothing will do it now.
  await cancelled();
}

/**
 * Looks at the remote and records what it shows, or that it could not be looked at (which fails the step). True
 * unless it recorded a check that found the action not done.
 */
async function recordCheck(step: ExternalActionStepDefinition, target: ExternalActionTarget, run: RunContext): Promise<boolean> {
  let observed: ExternalObservation;
  try {
    observed = await check(target, run);
  } catch (error) {
    await run.record({ type: "external_action_failed", stepId: step.id, error: `could not check the remote: ${messageOf(error)}` });
    return true;
  }
  const done = isDone(target, observed);
  await run.record({ type: "external_action_checked", stepId: step.id, done, observed });
  return done;
}

/**
 * What the step is to do, as recorded before anything is done: its action with the defaults filled in, and the
 * commit approved at the gate before it, past any other external actions. Validation put such a gate there.
 */
function targetOf(step: ExternalActionStepDefinition, index: number, run: RunContext): ExternalActionTarget {
  const state = run.state();
  let before = index - 1;
  while (before >= 0 && state.steps[before]!.kind === "external_action") before -= 1;
  const gate = state.steps[before];
  const approval = gate?.approvals.at(-1);
  if (gate?.kind !== "approval_gate" || approval?.decision?.decision !== "approved") {
    throw new Error(`external action "${step.id}" has no approved gate before it`);
  }
  const common = { remote: step.action.remote ?? DEFAULT_REMOTE, gateStepId: gate.id, commit: approval.commit };
  const { action } = step;
  switch (action.kind) {
    case "push_branch":
      return { kind: "push_branch", branch: action.branch, ...common };
    case "open_pr": {
      const { decision } = approval;
      const body =
        action.body ??
        `Opened by AHP from run ${state.runId}. Commit ${approval.commit} passed verification and was approved at gate ${gate.id} by ${decision.user} at ${decision.time}.`;
      return { kind: "open_pr", branch: action.branch, base: action.base, title: action.title, body, ...common };
    }
    case "merge_pr":
      return { kind: "merge_pr", branch: action.branch, method: action.method ?? "merge", ...common };
  }
}

/**
 * Looks at the remote and records what it shows; performs the action only when that is not done already, and not
 * after a cancel. A failure to perform it is looked at again before it is recorded: the remote may have it anyway.
 */
async function checkThenPerform(step: ExternalActionStepDefinition, target: ExternalActionTarget, run: RunContext): Promise<void> {
  const { record } = run;
  if (await recordCheck(step, target, run)) return;
  // Nothing starts after a cancel: the next turn records it, and ends the step.
  if (run.cancel.signal?.aborted) return;
  const observed = run.state().steps.find((s) => s.id === step.id)!.action!.checks.at(-1)!.observed;
  try {
    const result = await perform(target, observed, run);
    return record({ type: "external_action_performed", stepId: step.id, observed: result });
  } catch (error) {
    const again = await check(target, run).catch(() => null);
    if (again && isDone(target, again)) return record({ type: "external_action_checked", stepId: step.id, done: true, observed: again });
    return record({ type: "external_action_failed", stepId: step.id, error: messageOf(error) });
  }
}

const pullRequestTarget = (target: ExternalActionTarget, run: RunContext): PullRequestTarget => ({
  repo: run.location.repo,
  remote: target.remote,
  branch: target.branch,
});

/** What the remote shows that decides whether the action is done. */
async function check(target: ExternalActionTarget, run: RunContext): Promise<ExternalObservation> {
  if (target.kind === "push_branch") return { kind: "remote_branch", commit: await remoteBranchCommit(run.location.repo, target.remote, target.branch) };
  const found = await run.pullRequests.find(pullRequestTarget(target, run));
  // An open pull request decides; failing one, a merged one of the approved commit; failing that, the newest.
  const decisive =
    found.find((pr) => pr.state === "open") ?? found.find((pr) => pr.state === "merged" && pr.headCommit === target.commit) ?? found[0] ?? null;
  return { kind: "pull_request", pullRequest: decisive };
}

/**
 * Whether what the remote shows is the action done: the branch at the approved commit; an open pull request from
 * the branch, or one merged with the approved commit at its head (a pull request merged by hand was opened); a merged
 * one with the approved commit at its head.
 */
function isDone(target: ExternalActionTarget, observed: ExternalObservation): boolean {
  if (observed.kind === "remote_branch") return observed.commit === target.commit;
  const pr = observed.pullRequest;
  const mergedApproved = pr?.state === "merged" && pr.headCommit === target.commit;
  return target.kind === "open_pr" ? pr?.state === "open" || mergedApproved : mergedApproved;
}

async function perform(target: ExternalActionTarget, observed: ExternalObservation, run: RunContext): Promise<ExternalObservation> {
  const { repo } = run.location;
  switch (target.kind) {
    case "push_branch":
      // The approved commit as it is, never forced: a branch it would not fast-forward refuses it.
      await git(repo, ["push", "--quiet", target.remote, `${target.commit}:refs/heads/${target.branch}`], NO_PROMPT);
      return { kind: "remote_branch", commit: target.commit };
    case "open_pr": {
      const { base, title, body } = target;
      return { kind: "pull_request", pullRequest: await run.pullRequests.open(pullRequestTarget(target, run), { base, title, body }) };
    }
    case "merge_pr": {
      const open: PullRequestRecord | null = observed.kind === "pull_request" && observed.pullRequest?.state === "open" ? observed.pullRequest : null;
      if (!open) throw new Error(`there is no open pull request from branch ${target.branch} to merge`);
      const merged = await run.pullRequests.merge(pullRequestTarget(target, run), { number: open.number, method: target.method, headCommit: target.commit });
      return { kind: "pull_request", pullRequest: merged };
    }
  }
}

/** The commit the remote's branch points at, or null when the remote has no such branch. */
async function remoteBranchCommit(repo: string, remote: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const listed = await git(repo, ["ls-remote", remote, ref], NO_PROMPT);
  for (const line of listed.split("\n")) {
    const [oid, name] = line.split("\t");
    if (name === ref && oid) return oid;
  }
  return null;
}
