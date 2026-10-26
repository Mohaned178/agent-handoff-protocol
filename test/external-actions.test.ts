import { userInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { approveStep, readRun, readRunEvents, resumeRun, runWorkflow } from "../src/index.ts";
import type { RunView, WorkflowStepDefinition } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import {
  addBareRemote,
  BRANCH,
  fakePullRequests,
  mergeStep,
  openStep,
  publishingWorkflow,
  pushStep,
  remoteBranch,
  updatesOf,
} from "./helpers/external.ts";
import { appendLedgerEvent, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { implemented, implementStep, stepOf } from "./helpers/review.ts";

afterEach(removeTempRepos);

const typesOf = (events: readonly { type: string }[]) => events.map((event) => event.type);

/** The commit the gate approved: the implementing step's verified snapshot. */
const approvedCommit = (state: RunView) => stepOf(state, "implement").attempts.at(-1)!.snapshot!.commit;

/** A repository with a bare remote, and a run of `actions` after implement and the gate, stopped at the gate. */
async function atGate(...actions: WorkflowStepDefinition[]) {
  const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  const remote = addBareRemote(repo);
  const { runId, state } = await runWorkflow(publishingWorkflow(implementStep([implemented(1)]), ...actions), { repo, clock: fakeClock() });
  expect(state.state).toBe("waiting_approval");
  return { repo, remote, runId };
}

describe("pushing a branch after approval", () => {
  it("pushes the approved commit, as it is, to the remote branch, recording intent and a check first", async () => {
    const { repo, remote, runId } = await atGate(pushStep());
    expect(remoteBranch(remote)).toBeNull();

    const { state } = await approveStep({ repo, runId, stepId: "approve", pullRequests: fakePullRequests().provider });

    expect(state.state).toBe("succeeded");
    const push = stepOf(state, "push");
    expect([push.kind, push.state, push.failureClass]).toEqual(["external_action", "succeeded", null]);
    expect(remoteBranch(remote)).toBe(approvedCommit(state));
    expect(updatesOf(remote)).toBe(1);
    expect(push.action).toMatchObject({
      target: { kind: "push_branch", branch: BRANCH, remote: "origin", gateStepId: "approve", commit: approvedCommit(state) },
      checks: [{ done: false, observed: { kind: "remote_branch", commit: null } }],
      performed: { observed: { kind: "remote_branch", commit: approvedCommit(state) } },
      failure: null,
    });
    const types = typesOf(await readRunEvents({ repo, runId }));
    expect(types.slice(types.indexOf("approval_decided"))).toEqual([
      "approval_decided",
      "step_terminal",
      "step_ready",
      "external_action_intended",
      "external_action_checked",
      "external_action_performed",
      "step_terminal",
      "run_terminal",
    ]);
  });

  it("records a push already done, and does not push again, when a run stopped after its intent is resumed", async () => {
    const { repo, remote, runId } = await atGate(pushStep());
    await approveStep({ repo, runId, stepId: "approve" });
    // The process stopped after recording its intent, having pushed or not: here it had.
    truncateLedgerAfter(repo, runId, "external_action_intended");

    const { state, resumed } = await resumeRun({ repo, runId });

    expect([resumed, state.state]).toEqual([true, "succeeded"]);
    expect(updatesOf(remote)).toBe(1);
    expect(stepOf(state, "push").action).toMatchObject({
      checks: [{ done: true, observed: { kind: "remote_branch", commit: approvedCommit(state) } }],
      performed: null,
    });
  });

  it("pushes once when a run stopped after its intent is resumed and the push had not happened", async () => {
    const { repo, remote, runId } = await atGate(pushStep());
    await approveStep({ repo, runId, stepId: "approve" });
    truncateLedgerAfter(repo, runId, "external_action_intended");
    git(remote, "update-ref", "-d", `refs/heads/${BRANCH}`);

    const { state } = await resumeRun({ repo, runId });

    expect(state.state).toBe("succeeded");
    expect(remoteBranch(remote)).toBe(approvedCommit(state));
    expect(updatesOf(remote)).toBe(1);
    expect(stepOf(state, "push").action).toMatchObject({ checks: [{ done: false }], performed: { observed: { commit: approvedCommit(state) } } });
  });

  it("never forces: a branch the push would not fast-forward fails the step, which is not retried, and the run", async () => {
    const { repo, remote, runId } = await atGate(pushStep());
    // Someone else's work is on the branch already.
    git(repo, "commit", "--quiet", "--allow-empty", "--message", "elsewhere");
    git(repo, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
    const theirs = remoteBranch(remote);

    const { state } = await approveStep({ repo, runId, stepId: "approve" });

    expect(state.state).toBe("failed");
    const push = stepOf(state, "push");
    expect([push.state, push.failureClass]).toEqual(["failed", "external_action_failed"]);
    expect(push.action!.failure!.error).toMatch(/git push --quiet origin [0-9a-f]{40}:refs\/heads\/ahp\/greeting failed/);
    // Looked at before the push, and again after it failed: the remote did not have it either time.
    expect(push.action!.checks.map((c) => c.done)).toEqual([false, false]);
    expect(remoteBranch(remote)).toBe(theirs);
    expect(updatesOf(remote)).toBe(1);
  });

  it("fails the step when the remote cannot be reached to be checked", async () => {
    const { repo, runId } = await atGate(pushStep({ remote: "nowhere" }));

    const { state } = await approveStep({ repo, runId, stepId: "approve" });

    const push = stepOf(state, "push");
    expect([state.state, push.failureClass]).toEqual(["failed", "external_action_failed"]);
    expect(push.action!.failure!.error).toMatch(/^could not check the remote: git ls-remote nowhere/);
    expect(push.action!.checks).toEqual([]);
  });

  it("starts nothing once the run is cancelled: an action whose intent is recorded is checked, found not done, and cancelled", async () => {
    const { repo, remote, runId } = await atGate(pushStep());
    const controller = new AbortController();

    const { state } = await approveStep({
      repo,
      runId,
      stepId: "approve",
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "external_action_intended") controller.abort();
      },
    });

    expect(state.state).toBe("cancelled");
    const push = stepOf(state, "push");
    expect(push.state).toBe("cancelled");
    expect(push.action!.checks.map((c) => c.done)).toEqual([false]);
    expect(push.action!.performed).toBeNull();
    expect(remoteBranch(remote)).toBeNull();
  });
});

describe("a replayed ledger that breaks the external-action rules", () => {
  it("is refused when an action is performed again after it was done", async () => {
    const { repo, runId } = await atGate(pushStep());
    await approveStep({ repo, runId, stepId: "approve" });
    truncateLedgerAfter(repo, runId, "external_action_performed");

    appendLedgerEvent(repo, runId, { type: "external_action_performed", stepId: "push", observed: { kind: "remote_branch", commit: "0".repeat(40) } });

    await expect(readRun({ repo, runId })).rejects.toThrow('external action "push" already is done');
  });

  it("is refused when the intent names a commit other than the one approved", async () => {
    const { repo, runId } = await atGate(pushStep());
    await approveStep({ repo, runId, stepId: "approve" });
    truncateLedgerAfter(repo, runId, "step_ready", 3);
    const target = { kind: "push_branch", branch: BRANCH, remote: "origin", gateStepId: "approve", commit: (await readRun({ repo, runId })).baseCommit };

    appendLedgerEvent(repo, runId, { type: "external_action_intended", stepId: "push", target });

    await expect(readRun({ repo, runId })).rejects.toThrow('step "push" does not publish the commit approved at the gate before it');
  });
});

describe("opening and merging a pull request after approval", () => {
  it("opens one pull request from the pushed branch and merges it while its head is the approved commit", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep(), mergeStep({ method: "squash" }));
    const host = fakePullRequests();

    const { state } = await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider, clock: fakeClock("2026-03-04T05:06:07.000Z") });

    expect(state.state).toBe("succeeded");
    const commit = approvedCommit(state);
    expect(host.calls).toMatchObject({ open: 1, merge: 1 });
    expect(host.pulls).toEqual([
      expect.objectContaining({ number: 1, state: "merged", headCommit: commit, base: "main", branch: BRANCH, title: "Add a greeting", method: "squash" }),
    ]);
    // The body says where the pull request came from: the run, the commit and who approved it.
    expect(host.pulls[0]!.body).toBe(
      `Opened by AHP from run ${runId}. Commit ${commit} passed verification and was approved at gate approve by ${userInfo().username} at 2026-03-04T05:06:07.000Z.`,
    );
    expect(stepOf(state, "open").action).toMatchObject({
      checks: [{ done: false, observed: { kind: "pull_request", pullRequest: null } }],
      performed: { observed: { pullRequest: { number: 1, state: "open", headCommit: commit } } },
    });
    expect(stepOf(state, "merge").action).toMatchObject({
      target: { kind: "merge_pr", method: "squash", commit },
      checks: [{ done: false, observed: { pullRequest: { number: 1, state: "open" } } }],
      performed: { observed: { pullRequest: { number: 1, state: "merged" } } },
    });
  });

  it("finds the pull request it opened when a run stopped after the intent is resumed, and opens no second one", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep());
    const host = fakePullRequests();
    await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider });
    truncateLedgerAfter(repo, runId, "external_action_intended", 2);

    const { state } = await resumeRun({ repo, runId, pullRequests: host.provider });

    expect(state.state).toBe("succeeded");
    expect(host.calls.open).toBe(1);
    expect(host.pulls).toHaveLength(1);
    expect(stepOf(state, "open").action).toMatchObject({ checks: [{ done: true, observed: { pullRequest: { number: 1 } } }], performed: null });
  });

  it("does not merge twice when a run stopped after the merge's intent is resumed", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep(), mergeStep());
    const host = fakePullRequests();
    await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider });
    truncateLedgerAfter(repo, runId, "external_action_intended", 3);

    const { state } = await resumeRun({ repo, runId, pullRequests: host.provider });

    expect(state.state).toBe("succeeded");
    expect(host.calls.merge).toBe(1);
    expect(stepOf(state, "merge").action).toMatchObject({ checks: [{ done: true, observed: { pullRequest: { state: "merged" } } }] });
  });

  it("fails the step, without retrying, when the pull request cannot be opened", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep());
    const host = fakePullRequests({ failOpen: "gh: not logged in to any hosts" });

    const { state } = await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider });

    expect(state.state).toBe("failed");
    const open = stepOf(state, "open");
    expect([open.state, open.failureClass]).toEqual(["failed", "external_action_failed"]);
    expect(open.action!.failure!.error).toBe("gh: not logged in to any hosts");
    expect(host.calls.open).toBe(1);
    // The push before it stands: it was done.
    expect(stepOf(state, "push").state).toBe("succeeded");
  });

  it("opens its own pull request when the only open one from the branch goes into another base", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep());
    const host = fakePullRequests();
    await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider });
    truncateLedgerAfter(repo, runId, "external_action_intended", 2);
    host.pulls[0]!.base = "release";

    const { state } = await resumeRun({ repo, runId, pullRequests: host.provider });

    expect(state.state).toBe("succeeded");
    expect(host.pulls.map((pr) => [pr.number, pr.base, pr.state])).toEqual([
      [1, "release", "open"],
      [2, "main", "open"],
    ]);
  });

  it("ends the step cancelled, not failed, when a cancel stops the pull request being opened", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep());
    const controller = new AbortController();
    // A console Ctrl+C reaches gh as well as AHP: gh fails because of the cancel.
    const host = fakePullRequests({ onOpen: () => controller.abort(), failOpen: "gh: interrupted" });

    const { state } = await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider, signal: controller.signal });

    expect(state.state).toBe("cancelled");
    const open = stepOf(state, "open");
    expect([open.state, open.failureClass]).toEqual(["cancelled", null]);
    // Before it, after the failure, and once more as the step was cancelled: never found done.
    expect(open.action!.checks.map((c) => c.done)).toEqual([false, false, false]);
    expect(open.action!.failure).toBeNull();
    expect(stepOf(state, "push").state).toBe("succeeded");
  });

  it("fails a merge when there is no open pull request from the branch", async () => {
    const { repo, runId } = await atGate(pushStep(), openStep(), mergeStep());
    const host = fakePullRequests();
    await approveStep({ repo, runId, stepId: "approve", pullRequests: host.provider });
    truncateLedgerAfter(repo, runId, "external_action_intended", 3);
    // Someone closed it in between.
    host.pulls[0]!.state = "closed";

    const { state } = await resumeRun({ repo, runId, pullRequests: host.provider });

    expect(state.state).toBe("failed");
    expect(stepOf(state, "merge").action!.failure!.error).toBe(`there is no open pull request from branch ${BRANCH} to merge`);
  });
});
