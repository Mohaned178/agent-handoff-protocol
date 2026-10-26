import { existsSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalRefusedError,
  defineWorkflow,
  approveStep,
  inspectRun,
  readRun,
  readRunEvents,
  rejectStep,
  resumeRun,
  runWorkflow,
} from "../src/index.ts";
import type { LedgerEvent, RunView } from "../src/index.ts";
import { LedgerLockedError, LedgerWriter } from "../src/ledger/index.ts";
import { afterGateStep, gatedWorkflow, gateStep } from "./helpers/approval.ts";
import { fakeClock } from "./helpers/clock.ts";
import { appendLedgerEvent, GONE_PID, ledgerFile, lockFile, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye } from "./helpers/retry.ts";
import { approved, implemented, implementStep, reviewStep, stepOf } from "./helpers/review.ts";

afterEach(removeTempRepos);

const fixture = () => createTempRepo({ "verify.mjs": VERIFY_GREETING });

const typesOf = (events: readonly { type: string }[]) => events.map((event) => event.type);

/** Runs the gated workflow up to the gate, where it stops. */
async function waitingAtGate(...args: Parameters<typeof gatedWorkflow>) {
  const repo = fixture();
  const { runId, state } = await runWorkflow(gatedWorkflow(...args), { repo, clock: fakeClock() });
  expect(state.state).toBe("waiting_approval");
  return { repo, runId, state };
}

describe("a run that reaches an approval gate", () => {
  it("stops in waiting_approval with no agent for the gate, binds the request to the verified result, and releases the ledger", async () => {
    const repo = fixture();

    const { runId, state } = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock() });

    expect(state.state).toBe("waiting_approval");
    expect(state.endedAt).toBeNull();
    const implement = stepOf(state, "implement");
    const gate = stepOf(state, "approve");
    expect([implement.state, gate.state]).toEqual(["succeeded", "waiting_approval"]);
    // A gate has no coding agent: no handoff, no attempt.
    expect([gate.handoffs, gate.attempts]).toEqual([[], []]);

    // The request names the attempt and snapshot that were verified, and what they changed against the run's base.
    const verified = implement.attempts[0]!;
    expect(gate.approvals).toHaveLength(1);
    expect(gate.approvals[0]).toMatchObject({
      attemptId: verified.id,
      base: state.baseCommit,
      commit: verified.snapshot!.commit,
      changed: [
        { path: "greeting.txt", change: "added" },
        { path: "round.txt", change: "added" },
      ],
      truncated: false,
      decision: null,
    });

    const events = await readRunEvents({ repo, runId });
    expect(events.at(-1)).toMatchObject({ type: "approval_requested", stepId: "approve", attemptId: verified.id });
    expect(events.some((e) => e.type === "run_terminal")).toBe(false);
    // The runtime process is done with the run: nobody holds its lock, and a reader sees it free.
    expect(existsSync(lockFile(repo, runId))).toBe(false);
    expect((await inspectRun({ repo, runId })).lock.state).toBe("free");
  });

  it("shows the person what they approve: the diff of the verified snapshot against the run's base", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));

    const { approval, state } = await inspectRun({ repo, runId });

    expect(approval).toMatchObject({ stepId: "approve", diffTruncated: false, diffError: null });
    expect(approval!.diff).toBe(git(repo, "diff", "--no-color", state.baseCommit, stepOf(state, "implement").attempts[0]!.snapshot!.commit));
    expect(approval!.diff).toContain("+hello");
    expect(approval!.diff).toContain("+round 1");
  });

  it("shows nothing to approve once the run is not waiting", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    await approveStep({ repo, runId, stepId: "approve" });

    expect((await inspectRun({ repo, runId })).approval).toBeNull();
  });
});

describe("approving", () => {
  it("records who and when, resumes the run, and the run succeeds", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    const clock = fakeClock("2026-02-03T04:05:06.000Z");

    const result = await approveStep({ repo, runId, stepId: "approve", clock });

    expect(result.state.state).toBe("succeeded");
    expect(stepOf(result.state, "approve").state).toBe("succeeded");
    const gate = stepOf(await readRun({ repo, runId }), "approve");
    expect(gate.approvals[0]!.decision).toEqual({
      decision: "approved",
      reason: null,
      user: userInfo().username,
      time: "2026-02-03T04:05:06.000Z",
    });
    const events = await readRunEvents({ repo, runId });
    expect(typesOf(events).slice(-5)).toEqual(["approval_requested", "run_resumed", "approval_decided", "step_terminal", "run_terminal"]);
    expect(events.at(-3)).toMatchObject({ type: "approval_decided", stepId: "approve", decision: "approved", reason: null });
    // The process that approved released the ledger.
    expect(existsSync(lockFile(repo, runId))).toBe(false);
  });

  it("hands the next step the result of the step before the gate", async () => {
    const repo = fixture();
    const workflow = gatedWorkflow(implementStep([implemented(1)]), afterGateStep([{ outputFields: { summary: "published" } }]));
    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });
    expect(stepOf(state, "publish").state).toBe("blocked");

    const done = await approveStep({ repo, runId, stepId: "approve" });

    expect(done.state.state).toBe("succeeded");
    const implement = stepOf(done.state, "implement").attempts[0]!;
    const publish = stepOf(done.state, "publish");
    const [handoff] = publish.handoffs;
    expect(handoff!.handoff.from).toEqual({ stepId: "implement", attemptId: implement.id });
    expect(handoff!.handoff.base.commit).toBe(implement.snapshot!.commit);
    expect(handoff!.handoff.context.fields).toMatchObject({ summary: "implemented in round 1" });
    // Its workspace holds the verified result, and its verification (which wants the greeting) passed on it.
    expect(existsSync(`${publish.attempts[0]!.workspace}/greeting.txt`)).toBe(true);
    expect(publish.attempts[0]!.verification!.state).toBe("pass");
  });
});

describe("rejecting", () => {
  it("sends the step before the gate back under a new handoff revision with the reason, then asks again on the new result", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1), implemented(2)]));

    const rejected = await rejectStep({ repo, runId, stepId: "approve", reason: "use a constant for the greeting", clock: fakeClock() });

    expect(rejected.state.state).toBe("waiting_approval");
    const implement = stepOf(rejected.state, "implement");
    const gate = stepOf(rejected.state, "approve");
    expect(implement.attempts).toHaveLength(2);
    expect(implement.retryUsage.retries).toBe(1);
    expect(implement.handoffs.map((h) => [h.revision, h.supersedes, h.state])).toEqual([
      [1, null, "superseded"],
      [2, 1, "accepted"],
    ]);
    expect(implement.handoffs[1]!.handoff.evidence).toEqual([
      { kind: "approval_rejected", gateStepId: "approve", reason: "use a constant for the greeting" },
    ]);
    // The first attempt passed verification: the send-back, not a failure, is what happened to it.
    expect(implement.attempts[0]!.failureClass).toBeNull();
    expect(implement.attempts[0]!.sentBack).toMatchObject({
      kind: "approval",
      gateStepId: "approve",
      reason: "use a constant for the greeting",
      user: userInfo().username,
    });
    expect(implement.attempts[1]!.workspace).not.toBe(implement.attempts[0]!.workspace);
    expect(git(repo, "rev-parse", `${implement.attempts[1]!.snapshot!.commit}^`)).toBe(rejected.state.baseCommit);

    // The gate asks again, about the new attempt; the rejected request keeps its decision.
    expect(gate.approvals.map((a) => [a.attemptId, a.decision?.decision ?? null])).toEqual([
      [implement.attempts[0]!.id, "rejected"],
      [implement.attempts[1]!.id, null],
    ]);
    const types = typesOf(await readRunEvents({ repo, runId }));
    const decided = types.indexOf("approval_decided");
    expect(types.slice(decided - 1, decided + 6)).toEqual([
      "run_resumed",
      "approval_decided",
      "approval_sent_back",
      "handoff_issued",
      "handoff_accepted",
      "attempt_created",
      "ref_snapshot_taken",
    ]);

    // Approving the new result finishes the run.
    const done = await approveStep({ repo, runId, stepId: "approve" });
    expect(done.state.state).toBe("succeeded");
  });

  it("keeps the reason with the step if it then fails verification and is retried", async () => {
    const { repo, runId } = await waitingAtGate(
      implementStep([implemented(1), goodbye, implemented(3)], { verification: { command: "node verify.mjs" } }),
    );

    const { state } = await rejectStep({ repo, runId, stepId: "approve", reason: "rename it", clock: fakeClock() });

    expect(state.state).toBe("waiting_approval");
    const implement = stepOf(state, "implement");
    expect(implement.retryUsage.retries).toBe(2);
    const [, rejected, retried] = implement.handoffs.map((h) => h.handoff.evidence.map((e) => e.kind));
    expect(rejected).toEqual(["approval_rejected"]);
    expect(retried).toEqual(["approval_rejected", "test_output"]);
  });

  it("spends the preceding step's retry budget: with none left the gate fails and so does the run, and no agent runs", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1), implemented(2)], { retry: { budget: 0 } }));

    const { state } = await rejectStep({ repo, runId, stepId: "approve", reason: "no" });

    expect(state.state).toBe("failed");
    const gate = stepOf(state, "approve");
    expect([gate.state, gate.failureClass]).toEqual(["failed", "verification_failed"]);
    expect(gate.approvals[0]!.decision).toMatchObject({ decision: "rejected", reason: "no" });
    const implement = stepOf(state, "implement");
    expect(implement.state).toBe("succeeded");
    expect(implement.attempts).toHaveLength(1);
    expect(typesOf(await readRunEvents({ repo, runId })).slice(-4)).toEqual(["run_resumed", "approval_decided", "step_terminal", "run_terminal"]);
  });

  it("sends back the step immediately before the gate, which is the review when the gate follows one (ADR 0004)", async () => {
    const repo = fixture();
    const workflow = defineWorkflow({
      name: "reviewed-and-gated",
      steps: [implementStep([implemented(1)]), reviewStep([approved(), approved("fine on a second look")]), gateStep()],
    });
    const { runId } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    const { state } = await rejectStep({ repo, runId, stepId: "approve", reason: "the review missed the naming", clock: fakeClock() });

    expect(state.state).toBe("waiting_approval");
    expect(stepOf(state, "implement").attempts).toHaveLength(1);
    const review = stepOf(state, "review");
    expect(review.attempts).toHaveLength(2);
    expect(review.handoffs[1]!.handoff.evidence).toEqual([
      { kind: "approval_rejected", gateStepId: "approve", reason: "the review missed the naming" },
    ]);
  });
});

describe("a decision that is not one", () => {
  const eventsOf = async (repo: string, runId: string) => (await readRunEvents({ repo, runId })).length;

  it("refuses a second decision on the same request, writing nothing", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    await approveStep({ repo, runId, stepId: "approve" });
    const before = await eventsOf(repo, runId);

    const again = approveStep({ repo, runId, stepId: "approve" });
    const rejectAfter = rejectStep({ repo, runId, stepId: "approve", reason: "too late" });

    await expect(again).rejects.toThrow(ApprovalRefusedError);
    await expect(again).rejects.toThrow(/step approve is not waiting for approval: run run_[a-z0-9]+ already ended \(succeeded\)/);
    await expect(rejectAfter).rejects.toThrow(ApprovalRefusedError);
    expect(await eventsOf(repo, runId)).toBe(before);
  });

  it("refuses a step that is not an approval gate, or does not exist", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    const before = await eventsOf(repo, runId);

    await expect(approveStep({ repo, runId, stepId: "implement" })).rejects.toThrow("step implement is not waiting for approval: it is not an approval gate");
    await expect(approveStep({ repo, runId, stepId: "nope" })).rejects.toThrow(/no step nope in run run_[a-z0-9]+ \(its steps: implement, approve\)/);
    expect(await eventsOf(repo, runId)).toBe(before);
  });

  it("refuses a rejection without a reason, however blank", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    const before = await eventsOf(repo, runId);

    await expect(rejectStep({ repo, runId, stepId: "approve", reason: "" })).rejects.toThrow("a rejection needs a reason");
    await expect(rejectStep({ repo, runId, stepId: "approve", reason: " \n " })).rejects.toThrow(ApprovalRefusedError);
    expect(await eventsOf(repo, runId)).toBe(before);
    expect((await readRun({ repo, runId })).state).toBe("waiting_approval");
  });

  it("refuses a gate the run has not reached", async () => {
    const repo = fixture();
    const { runId, state } = await runWorkflow(
      defineWorkflow({ name: "failing", steps: [implementStep([implemented(1)], { retry: { budget: 0 }, verification: { command: "node -e process.exit(1)" } }), gateStep()] }),
      { repo, clock: fakeClock() },
    );
    expect(state.state).toBe("failed");

    await expect(approveStep({ repo, runId, stepId: "approve" })).rejects.toThrow(/step approve is not waiting for approval: run run_[a-z0-9]+ already ended \(failed\)/);
  });

  it("refuses while a process holds the run's ledger, writing nothing", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    const before = await eventsOf(repo, runId);
    const { writer } = await LedgerWriter.open(ledgerFile(repo, runId));

    try {
      await expect(approveStep({ repo, runId, stepId: "approve" })).rejects.toThrow(LedgerLockedError);
    } finally {
      await writer.close();
    }
    expect(await eventsOf(repo, runId)).toBe(before);
    expect((await readRun({ repo, runId })).state).toBe("waiting_approval");
  });

  it("lets only one of two decisions made at once through", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1), implemented(2)]));

    const outcomes = await Promise.allSettled([
      approveStep({ repo, runId, stepId: "approve" }),
      rejectStep({ repo, runId, stepId: "approve", reason: "no" }),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const decisions = (await readRunEvents({ repo, runId })).filter((e) => e.type === "approval_decided");
    expect(decisions).toHaveLength(1);
  });
});

describe("a process that stopped around a decision", () => {
  /** A run that was approved (or rejected) to its end, cut right after the decision was recorded: its process stopped there. */
  async function stoppedAfterDecision(decide: (repo: string, runId: string) => Promise<RunView>) {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1), implemented(2)]));
    await decide(repo, runId);
    truncateLedgerAfter(repo, runId, "approval_decided");
    return { repo, runId };
  }

  it("takes the approval to its end when the run is resumed, and the decision is not made again", async () => {
    const { repo, runId } = await stoppedAfterDecision(async (r, id) => (await approveStep({ repo: r, runId: id, stepId: "approve" })).state);
    expect((await readRun({ repo, runId })).state).toBe("running");

    await expect(approveStep({ repo, runId, stepId: "approve" })).rejects.toThrow(/was already approved by .* at .*`ahp recover run_[a-z0-9]+` continues the run/);
    const { state, resumed } = await resumeRun({ repo, runId });

    expect(resumed).toBe(true);
    expect(state.state).toBe("succeeded");
    expect(typesOf(await readRunEvents({ repo, runId })).filter((t) => t === "approval_decided")).toHaveLength(1);
  });

  it("sends the step back when a rejection's run is resumed", async () => {
    const { repo, runId } = await stoppedAfterDecision(
      async (r, id) => (await rejectStep({ repo: r, runId: id, stepId: "approve", reason: "no good", clock: fakeClock() })).state,
    );

    const { state } = await resumeRun({ repo, runId, clock: fakeClock() });

    expect(state.state).toBe("waiting_approval");
    const implement = stepOf(state, "implement");
    expect(implement.attempts).toHaveLength(2);
    expect(implement.handoffs[1]!.handoff.evidence).toEqual([{ kind: "approval_rejected", gateStepId: "approve", reason: "no good" }]);
  });

  it("takes over the stale lock of a process that stopped while the run waited, and records whose it was", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    const stale = { host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(lockFile(repo, runId), `${JSON.stringify(stale)}\n`);

    const { state } = await approveStep({ repo, runId, stepId: "approve" });

    expect(state.state).toBe("succeeded");
    expect(state.resumptions).toEqual([expect.objectContaining({ takenOverFrom: stale })]);
    expect(existsSync(lockFile(repo, runId))).toBe(false);
  });

  it("leaves a run waiting for approval alone when it is resumed", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    const before = await readRunEvents({ repo, runId });

    const { resumed, state } = await resumeRun({ repo, runId });

    expect([resumed, state.state]).toEqual([false, "waiting_approval"]);
    expect(await readRunEvents({ repo, runId })).toEqual(before satisfies LedgerEvent[]);
  });
});

describe("a replayed ledger that breaks the gate's rules", () => {
  it("is refused when a gate is approved without a request, or decided twice", async () => {
    const { repo, runId } = await waitingAtGate(implementStep([implemented(1)]));
    await approveStep({ repo, runId, stepId: "approve" });

    appendLedgerEvent(repo, runId, { type: "approval_decided", stepId: "approve", decision: "approved", reason: null, user: "x" });

    await expect(readRun({ repo, runId })).rejects.toThrow('step "approve" has no open request for approval');
  });
});
