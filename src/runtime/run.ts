import { randomBytes } from "node:crypto";
import type { Adapter, AttemptExit, StartedAttempt } from "../adapters/index.ts";
import { applyEvent, LedgerWriter } from "../ledger/index.ts";
import {
  PROTOCOL_VERSION,
  type AgentRef,
  type AttemptView,
  type EvidenceItem,
  type FailureClass,
  type HandoffRevision,
  type LedgerEvent,
  type LedgerEventBody,
  type RetryChange,
  type RunView,
  type ScheduledRetry,
  type StepDefinition,
  type StepView,
  type ValidatorStage,
  type VerificationView,
  type WorkflowDefinition,
} from "../protocol/index.ts";
import { systemClock, type Clock } from "./clock.ts";
import { classifyAttempt, decideAfterFailure, resolveRetryPolicy, verdictFailure, type FailureDecision } from "./failure.ts";
import { git } from "./git.ts";
import { introduceHiddenTests } from "./hidden-tests.ts";
import { buildHandoff, retryEvidence, reviseHandoff, validateHandoffRevision } from "./handoff.ts";
import { ledgerPath, locateRepo, prepareWorktreeRoot, snapshotRef, worktreePath, type RepoLocation } from "./paths.ts";
import { buildRecoveryReport } from "./recovery.ts";
import { sharedRefs } from "./refs.ts";
import { changedPaths, checkProtectedPaths, diffScopeEvidence } from "./scope.ts";
import { checkRequiredOutputFields, installDependencies, runVerificationCommand, validatorError, verdictOf } from "./verification.ts";
import { addWorktree, discardWorktree, removeWorktree, snapshotWorktree } from "./workspace.ts";

export interface ExecuteRunOptions {
  /** Any directory inside the git repository to run against. */
  repo: string;
  adapters: ReadonlyMap<string, Adapter>;
  /** Called after each event is durably recorded, with the state derived so far. */
  onEvent?: (event: LedgerEvent, state: Readonly<RunView>) => void;
  /** Stamps ledger events and waits out a retry's backoff. Defaults to the system clock. */
  clock?: Clock;
}

export interface RunResult {
  runId: string;
  state: RunView;
}

/** Short, sortable, lowercase IDs that are safe in paths and git ref names. */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** What every part of the executor works with: where the run is, what it may use, and its ledger. */
export interface RunContext {
  runId: string;
  location: RepoLocation;
  worktreeRoot: string;
  adapters: ReadonlyMap<string, Adapter>;
  workflow: WorkflowDefinition;
  clock: Clock;
  /** The state derived from the ledger so far. */
  state: () => Readonly<RunView>;
  /** The ledger's events so far, in append order. */
  events: () => readonly LedgerEvent[];
  /** Records an event durably and derives the state after it. */
  record: (body: LedgerEventBody) => Promise<void>;
}

/** A run context over `ledger`, whose events so far are `recorded`; each event recorded is passed to `onEvent`. */
export function runContext(
  ledger: LedgerWriter,
  recorded: readonly LedgerEvent[],
  fields: Omit<RunContext, "state" | "events" | "record">,
  onEvent: ExecuteRunOptions["onEvent"],
): RunContext {
  const events = [...recorded];
  let state: RunView | undefined;
  for (const event of events) state = applyEvent(state, event);
  return {
    ...fields,
    state: () => state!,
    events: () => events,
    record: async (body) => {
      const event = await ledger.append(body);
      events.push(event);
      state = applyEvent(state, event);
      onEvent?.(event, state);
    },
  };
}

/**
 * Executes a validated workflow against a repository. Every event is recorded in the run's ledger
 * before the effect it announces happens, and the returned state is derived from those events alone.
 */
export async function executeRun(workflow: WorkflowDefinition, options: ExecuteRunOptions): Promise<RunResult> {
  const location = await locateRepo(options.repo);
  const baseCommit = await git(location.repo, ["rev-parse", "--verify", "HEAD^{commit}"]).catch((error) => {
    throw new Error(`${location.repo} has no commits to run against`, { cause: error });
  });
  const worktreeRoot = await prepareWorktreeRoot();
  const clock = options.clock ?? systemClock;
  const runId = newId("run");
  const ledger = await LedgerWriter.create(ledgerPath(location, runId), () => clock.now());
  const run = runContext(ledger, [], { runId, location, worktreeRoot, adapters: options.adapters, workflow, clock }, options.onEvent);
  try {
    await run.record({
      type: "run_created",
      runId,
      protocolVersion: PROTOCOL_VERSION,
      workflow,
      repo: location.repo,
      baseCommit,
    });
    await drive(run);
  } finally {
    await ledger.close();
  }
  return { runId, state: run.state() };
}

/**
 * Takes the run from wherever its ledger says it is to the next point where it stops: a terminal state, or one
 * that waits for a person. Each turn reads what to do next from the state derived so far and records at least one
 * event, so the run can be picked up at any point by a process that replays the same ledger.
 */
export async function drive(run: RunContext): Promise<void> {
  for (;;) {
    const state = run.state();
    if (state.state === "pending") {
      await run.record({ type: "run_started" });
      continue;
    }
    if (state.state !== "running") return;
    // Steps run in order, so the first that has not succeeded is the one in hand.
    const index = state.steps.findIndex((step) => step.state !== "succeeded");
    if (index === -1 || state.steps[index]!.state === "failed") {
      await run.record({ type: "run_terminal", state: index === -1 ? "succeeded" : "failed" });
      continue;
    }
    const recorded = run.events().length;
    await advanceStep(run.workflow.steps[index]!, index, run);
    // An advance that recorded nothing would find the same state again, and loop forever.
    if (run.events().length === recorded) throw new Error(`step "${state.steps[index]!.id}" made no progress`);
  }
}

function adapterFor(step: StepDefinition, agent: AgentRef, run: RunContext): Adapter {
  const adapter = run.adapters.get(agent.adapter);
  if (!adapter) throw new Error(`step "${step.id}" names unknown adapter "${agent.adapter}"`);
  return adapter;
}

const stepOf = (run: RunContext, index: number): StepView => run.state().steps[index]!;

/** The coding agent the step is with: its own, or its alternative once it was rerouted. */
const currentAgent = (step: StepDefinition, view: StepView): AgentRef => (view.retryUsage.rerouted ? step.reroute! : step.agent);

/**
 * The commit every attempt of the step starts from, retries included, so a failed attempt's files never leak: the
 * previous step's verified snapshot, which holds the work so far and every artifact it passes, or the run's base.
 */
function stepBase(index: number, run: RunContext): string {
  const state = run.state();
  const sender = index > 0 ? state.steps[index - 1]?.attempts.at(-1) : undefined;
  return sender?.snapshot?.commit ?? state.baseCommit;
}

/** How many times an attempt's verification ran, as the ledger shows it. */
const verificationRuns = (attempt: AttemptView) => attempt.earlierVerifications.length + (attempt.verification ? 1 : 0);

/** What the failure policy decides after a failure of the given class, from what the step has spent so far. */
function decide(step: StepDefinition, view: StepView, failureClass: FailureClass, validatorRuns: number): FailureDecision {
  return decideAfterFailure({
    failureClass,
    policy: resolveRetryPolicy(step.retry),
    usage: view.retryUsage,
    validatorRuns,
    reroute: step.reroute !== undefined,
  });
}

/**
 * Takes one step forward from its derived state: makes it ready, issues and validates its handoff, runs an
 * attempt, or works through an attempt that has ended (snapshot, verification, failure class, then what the
 * failure policy decides). Every retry is a new attempt in a new workspace made from the step's base commit; what
 * is left of the retry budgets is read from the ledger's replay, never kept in memory.
 */
async function advanceStep(step: StepDefinition, index: number, run: RunContext): Promise<void> {
  const view = stepOf(run, index);
  switch (view.state) {
    case "blocked":
      // Every agent the step may use must exist before anything is recorded for it.
      adapterFor(step, step.agent, run);
      if (step.reroute) adapterFor(step, step.reroute, run);
      return run.record({ type: "step_ready", stepId: step.id });
    case "ready":
      return advanceReadyStep(step, index, run);
    case "in_progress":
    case "verifying":
    case "needs_recovery":
      return advanceAttempt(step, index, run);
    default:
      throw new Error(`step "${step.id}" is ${view.state}, so there is nothing to advance`);
  }
}

/** A ready step needs a handoff its recipient accepted, then (after any backoff) an attempt. */
async function advanceReadyStep(step: StepDefinition, index: number, run: RunContext): Promise<void> {
  const view = stepOf(run, index);
  const handoff = view.handoffs.at(-1);
  if (!handoff) return issueHandoff(step, await firstHandoff(step, index, run), run);
  if (handoff.state === "issued") return decideHandoff(step, handoff.handoff, run);
  if (handoff.state === "rejected") {
    return run.record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: "rejected" });
  }
  const failed = view.attempts.at(-1);
  const retry = failed?.retry;
  // A retry whose input changed runs under a new revision, issued once for the attempt it follows.
  if (failed && retry && retry.change !== "none" && handoff.revision === failed.handoff.revision) {
    return issueHandoff(step, revisedHandoff(step, view, failed, retry.change), run);
  }
  if (retry) await waitOut(retry, run.clock);
  return executeAttempt(step, index, run);
}

/** Waits for what is left of a retry's backoff, which runs from when the retry was scheduled. */
async function waitOut(retry: ScheduledRetry, clock: Clock): Promise<void> {
  const left = Date.parse(retry.scheduledAt) + retry.delayMs - clock.now().getTime();
  if (left > 0) await clock.sleep(left);
}

/** Revision 1 of the step's handoff: the previous step's verified result, handed on. */
async function firstHandoff(step: StepDefinition, index: number, run: RunContext): Promise<HandoffRevision> {
  // The previous step has succeeded, so its last attempt is the verified one whose result is handed on.
  const senderAttempt = index > 0 ? run.state().steps[index - 1]?.attempts.at(-1) : undefined;
  return buildHandoff({
    repo: run.location.repo,
    runId: run.runId,
    handoffId: newId("hnd"),
    step,
    sender: senderAttempt
      ? { step: run.workflow.steps[index - 1]!, attemptId: senderAttempt.id, reportedOutput: senderAttempt.reportedOutput }
      : null,
    baseCommit: stepBase(index, run),
  });
}

/**
 * The next revision of the step's handoff, for a retry whose input changed. It carries what the failed
 * verification showed (an attempt that taught nothing leaves the evidence the step already had) and, on a reroute,
 * names the alternative agent, which starts on budgets of its own.
 */
function revisedHandoff(step: StepDefinition, view: StepView, failed: AttemptView, change: RetryChange): HandoffRevision {
  const accepted = view.handoffs.at(-1)!.handoff;
  const hiddenTests = (step.verification.hiddenTests ?? []).length > 0;
  const learned = retryEvidence(failed.verification?.evidence ?? [], { hiddenTests });
  const alternative = change === "reroute" ? step.reroute! : null;
  return reviseHandoff(accepted, {
    evidence: learned.length > 0 ? learned : accepted.evidence,
    to: alternative ? { adapter: alternative.adapter, requestedModel: alternative.model ?? null } : undefined,
  });
}

/** Records the issue of a handoff revision, then has it validated. */
async function issueHandoff(step: StepDefinition, handoff: HandoffRevision, run: RunContext): Promise<void> {
  await run.record({ type: "handoff_issued", handoff });
  await decideHandoff(step, handoff, run);
}

/**
 * Has an issued handoff revision validated as a recipient would receive it, and records the decision; a rejected
 * revision ends the step as `rejected`.
 */
async function decideHandoff(step: StepDefinition, handoff: HandoffRevision, run: RunContext): Promise<void> {
  // Validate the document as a recipient would receive it, not the object the runtime built.
  const validation = await validateHandoffRevision(JSON.parse(JSON.stringify(handoff)), run.location.repo);
  const { handoffId, revision } = handoff;
  if (!validation.accepted) {
    await run.record({ type: "handoff_rejected", handoffId, revision, reasons: validation.reasons });
    await run.record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass: "rejected" });
    return;
  }
  await run.record({ type: "handoff_accepted", handoffId, revision });
}

/**
 * One attempt up to its exit: a fresh workspace from the step's base commit and one coding-agent process, under
 * the handoff revision the step accepted last. An attempt an earlier process created and stopped before
 * dispatching ran no agent, since dispatching is recorded before the spawn: it is taken up here, in a workspace
 * made afresh.
 */
async function executeAttempt(step: StepDefinition, index: number, run: RunContext): Promise<void> {
  const { runId, worktreeRoot, location, record } = run;
  const view = stepOf(run, index);
  const agent = currentAgent(step, view);
  const adapter = adapterFor(step, agent, run);
  const base = stepBase(index, run);
  let attempt = view.attempts.at(-1);
  if (attempt?.state === "created") {
    await discardWorktree(location.repo, attempt.workspace);
    await addWorktree(location.repo, attempt.workspace, base, { force: true });
  } else {
    const accepted = view.handoffs.at(-1)!.handoff;
    const attemptId = newId("att");
    await record({
      type: "attempt_created",
      stepId: step.id,
      attemptId,
      handoffId: accepted.handoffId,
      handoffRevision: accepted.revision,
      adapter: adapter.declaration.name,
      mock: adapter.declaration.mock,
      requestedModel: agent.model ?? null,
      workspace: worktreePath(worktreeRoot, runId, attemptId),
    });
    attempt = stepOf(run, index).attempts.at(-1)!;
    await addWorktree(location.repo, attempt.workspace, base);
  }
  const { id: attemptId, workspace, number: attemptNumber } = attempt;
  const handoff = view.handoffs.find((h) => h.handoffId === attempt.handoff.id && h.revision === attempt.handoff.revision)!.handoff;

  await record({ type: "ref_snapshot_taken", attemptId, phase: "before", refs: await sharedRefs(location.repo) });
  // Recorded before the spawn: from here on an agent may be running, so a restart never dispatches this attempt again.
  await record({ type: "attempt_dispatching", attemptId });
  let started: StartedAttempt;
  try {
    started = await adapter.startAttempt({
      attemptId,
      attemptNumber,
      workspace,
      requestedModel: agent.model ?? null,
      handoff,
      options: agent.options,
    });
  } catch (error) {
    // The adapter cannot vouch that no process started, so whatever one may have done is unknown.
    return record({ type: "attempt_unknown", attemptId, reason: "lost_contact", detail: `the adapter could not start the agent: ${messageOf(error)}` });
  }
  await record({ type: "attempt_running", attemptId, pid: started.pid });
  let exit: AttemptExit;
  try {
    exit = await started.exited;
  } catch (error) {
    return record({ type: "attempt_unknown", attemptId, reason: "lost_contact", detail: `the adapter lost track of the agent: ${messageOf(error)}` });
  }
  // The agent ended cleanly exactly when its exit alone shows no failure. The attempt's failure class is a
  // separate record, made once the attempt is over, which may take its verification into account.
  const endedCleanly = classifyAttempt({ ...exit, verdict: null }) === null;
  await record({ type: "attempt_exited", attemptId, outcome: endedCleanly ? "ok" : "error", ...exit });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Works through the step's last attempt from wherever its record stops. */
async function advanceAttempt(step: StepDefinition, index: number, run: RunContext): Promise<void> {
  const attempt = stepOf(run, index).attempts.at(-1)!;
  switch (attempt.state) {
    case "created":
      return executeAttempt(step, index, run);
    case "dispatching":
    case "running": {
      // This process dispatches an attempt and sees it end in one go, so an attempt found dispatched with no end was
      // a stopped process's. Its agent may have run, and may still be running: it is never dispatched again.
      const pid = attempt.pid === null ? "" : ` (PID ${attempt.pid})`;
      const detail = `the runtime stopped while the attempt was ${attempt.state}${pid}, and nothing records how it ended`;
      return run.record({ type: "attempt_unknown", attemptId: attempt.id, reason: "no_terminal_record", detail });
    }
    case "exited":
      return advanceExitedAttempt(step, index, attempt, run);
    case "unknown":
      return advanceUnknownAttempt(step, index, attempt, run);
  }
}

/**
 * An attempt whose process has ended: the shared refs after it, a snapshot of its workspace, then, if the agent
 * ended cleanly, verification. An attempt whose agent did not end cleanly (non-zero exit, a stop reason that means
 * it gave up, an error its adapter reported) is not verified: it has no finished result to check.
 */
async function advanceExitedAttempt(step: StepDefinition, index: number, attempt: AttemptView, run: RunContext): Promise<void> {
  if (!attempt.refs.after) {
    const refs = await sharedRefs(run.location.repo);
    return run.record({ type: "ref_snapshot_taken", attemptId: attempt.id, phase: "after", refs });
  }
  return advanceResult(step, index, attempt, classifyAttempt({ ...attempt, verdict: null }), run);
}

/**
 * An attempt whose outcome is unknown: it is never retried. Its report is written first; then the step's policy
 * decides at once, or, under `manual` (or `adopt` with no workspace left to adopt), the run stops for a person.
 * Once decided, an adopted attempt's workspace is verified as its result, and an aborted one ends the step.
 */
async function advanceUnknownAttempt(step: StepDefinition, index: number, attempt: AttemptView, run: RunContext): Promise<void> {
  const { record } = run;
  const recovery = attempt.recovery!;
  if (!recovery.report) {
    const report = await buildRecoveryReport({ repo: run.location.repo, attempt, base: stepBase(index, run), events: run.events() });
    return record({ type: "recovery_report_written", attemptId: attempt.id, report });
  }
  if (!recovery.decision) {
    const policy = step.recovery ?? "manual";
    if (policy === "manual" || (policy === "adopt" && !recovery.report.workspace.exists)) {
      return record({ type: "recovery_awaited", attemptId: attempt.id });
    }
    return record({ type: "recovery_decided", attemptId: attempt.id, policy, decidedBy: "step_policy", user: null });
  }
  if (recovery.decision.policy === "abort") return concludeAttempt(step, index, attempt, "unknown", run);
  // Adopted: how its agent ended was never seen, so only the verdict can fail it.
  return advanceResult(step, index, attempt, null, run);
}

/**
 * An attempt whose result is in its workspace: a snapshot, then verification unless the agent already failed. A
 * verification that could not run is re-run once, as the failure policy says, before it counts as inconclusive.
 */
async function advanceResult(
  step: StepDefinition,
  index: number,
  attempt: AttemptView,
  agentFailure: FailureClass | null,
  run: RunContext,
): Promise<void> {
  if (!attempt.snapshot) return snapshotAttempt(step, attempt, run);
  if (agentFailure !== null) return concludeAttempt(step, index, attempt, agentFailure, run);

  const verification = attempt.verification;
  if (!verification) return verifyAttempt(step, index, attempt, run);
  if (verification.state === "pending") return recordInterruptedVerification(verification, run);
  const failureClass = verdictFailure(verification.state);
  if (failureClass === "inconclusive") {
    const decision = decide(step, stepOf(run, index), failureClass, verificationRuns(attempt));
    if (decision.action === "rerun_validator") return verifyAttempt(step, index, attempt, run);
  }
  return concludeAttempt(step, index, attempt, failureClass, run);
}

/**
 * Records the verdict of a verification an earlier process stopped during: it never reached one, so the validator
 * did not run to a result, which is inconclusive and re-run like any other. Whatever of its worktree is left is
 * removed if it can be; a verification command that outlived that process can still hold it on Windows.
 */
async function recordInterruptedVerification(verification: VerificationView, run: RunContext): Promise<void> {
  if (verification.worktree) await discardWorktree(run.location.repo, verification.worktree).catch(() => undefined);
  const message = "the runtime stopped during this verification, which never reached a verdict";
  await run.record({
    type: "verification_verdict",
    verificationId: verification.id,
    verdict: "inconclusive",
    evidence: [{ kind: "validator_error", stage: "runtime_stopped", message }],
  });
}

async function snapshotAttempt(step: StepDefinition, attempt: AttemptView, run: RunContext): Promise<void> {
  const ref = snapshotRef(run.runId, attempt.id);
  const commit = await snapshotWorktree(attempt.workspace, ref, `AHP snapshot of ${run.runId} step ${step.id} attempt ${attempt.id}`);
  await run.record({ type: "workspace_snapshot_committed", attemptId: attempt.id, commit, ref });
}

/**
 * Ends an attempt whose verdict, if it had one, is final: a pass ends the step; a failure is recorded with its
 * class, and then the failure policy decides whether the step is retried, rerouted or ends.
 */
async function concludeAttempt(
  step: StepDefinition,
  index: number,
  attempt: AttemptView,
  failureClass: FailureClass | null,
  run: RunContext,
): Promise<void> {
  const { record } = run;
  if (failureClass === null) {
    return record({ type: "step_terminal", stepId: step.id, state: "succeeded", failureClass: null });
  }
  if (attempt.failureClass === null) return record({ type: "attempt_failed", attemptId: attempt.id, failureClass });

  const decision = decide(step, stepOf(run, index), failureClass, verificationRuns(attempt));
  switch (decision.action) {
    case "stop":
      return record({ type: "step_terminal", stepId: step.id, state: "failed", failureClass });
    case "rerun_validator":
      // The validator is re-run before the attempt's failure is recorded, so a failure that reaches here is final.
      throw new Error(`step "${step.id}": a validator re-run was decided after its attempt ended`);
    case "retry":
    case "reroute": {
      const delayMs = decision.action === "retry" ? decision.delayMs : 0;
      const change: RetryChange =
        decision.action === "reroute" ? "reroute" : decision.input === "changed" ? "evidence" : "none";
      // Recorded before any wait and before the new revision or attempt begins.
      return record({ type: "retry_scheduled", stepId: step.id, attemptId: attempt.id, failureClass, change, delayMs });
    }
  }
}

/** Runs one verification of an attempt's snapshot and records it and its verdict. */
async function verifyAttempt(step: StepDefinition, index: number, attempt: AttemptView, run: RunContext): Promise<void> {
  const { runId, worktreeRoot, location, record } = run;
  const base = stepBase(index, run);
  const snapshot = attempt.snapshot!.commit;
  const verificationId = newId("ver");
  const evidence: EvidenceItem[] = [];
  // Whether the attempt stayed out of the protected paths is known before anything runs. A violation fails
  // verification whatever the command says, so the command, which would run the attempt's changes to the test
  // runner and scripts, is not run. If the check itself cannot be made, the command is not run either.
  const hiddenTests = step.verification.hiddenTests ?? [];
  const protectedPaths = [...new Set([...(step.verification.protectedPaths ?? []), ...hiddenTests.map((test) => test.path)])];
  let scopeClear = true;
  if (protectedPaths.length > 0) {
    try {
      const changed = await changedPaths(location.repo, base, snapshot);
      const check = checkProtectedPaths(changed, protectedPaths);
      evidence.push(diffScopeEvidence(changed), check);
      scopeClear = check.violations.length === 0;
    } catch (error) {
      evidence.push(validatorError("diff_scope", error));
      scopeClear = false;
    }
  }
  // A structural verification runs no command, so it needs no verification worktree.
  const command = step.verification.command;
  const commandRun =
    command === undefined || !scopeClear ? null : { command, worktree: worktreePath(worktreeRoot, runId, verificationId) };
  await record({
    type: "verification_started",
    attemptId: attempt.id,
    verificationId,
    command: command ?? null,
    worktree: commandRun?.worktree ?? null,
  });
  if (commandRun) {
    // Whatever breaks on AHP's side from here on is evidence that the validator could not run, not a verdict on
    // the attempt, and a verdict is always recorded.
    let stage: ValidatorStage = "verification_worktree";
    let created = false;
    try {
      await addWorktree(location.repo, commandRun.worktree, snapshot);
      created = true;
      if (step.verification.install !== undefined) {
        stage = "install";
        await installDependencies(step.verification.install, commandRun.worktree);
      }
      stage = "hidden_tests";
      await introduceHiddenTests(commandRun.worktree, hiddenTests);
      stage = "command";
      evidence.push(await runVerificationCommand(commandRun.command, commandRun.worktree));
    } catch (error) {
      evidence.push(validatorError(stage, error));
    } finally {
      if (created) await removeWorktree(location.repo, commandRun.worktree);
    }
  }
  const requiredFields = step.verification.requiredOutputFields ?? [];
  if (requiredFields.length > 0) evidence.push(checkRequiredOutputFields(requiredFields, attempt.reportedOutput));
  const verdict = verdictOf(evidence);
  await record({ type: "verification_verdict", verificationId, verdict, evidence });
}
