import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRun, readRunEvents, recoverAttempt, resumeRun, runWorkflow, validateWorkflow } from "../src/index.ts";
import type { LedgerEvent, MockAttemptScript, StepDefinition } from "../src/index.ts";
import { LedgerWriter } from "../src/ledger/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { finishedRun, GONE_PID, ledgerFile, lockFile, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, implementOf, rateLimited, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

/** An attempt that does the work, after which its adapter can no longer say how it ended. */
const helloLost: MockAttemptScript = { ...hello, loseContact: true };

/** The content of every run's ledger in `repo`, by run ID. */
function ledgersOf(repo: string): Record<string, string> {
  const runs = join(repo, ".git", "ahp", "runs");
  return Object.fromEntries(readdirSync(runs).map((runId) => [runId, readFileSync(join(runs, runId, "ledger.jsonl"), "utf8")]));
}

describe("an attempt whose adapter lost contact with its agent", () => {
  it("is unknown and never retried: its step needs recovery, a report is written, and the run stops for a decision", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(retryWorkflow([helloLost, hello]), { repo });

    expect(state.state).toBe("needs_recovery");
    const step = implementOf(state);
    expect(step.state).toBe("needs_recovery");
    expect(step.attempts).toHaveLength(1);
    const attempt = step.attempts[0]!;
    expect(attempt.state).toBe("unknown");
    expect(attempt.recovery).toMatchObject({ reason: "lost_contact", decision: null });
    const report = attempt.recovery!.report!;
    expect(report).toMatchObject({
      workspace: { path: attempt.workspace, exists: true, changed: [{ path: "greeting.txt", change: "added" }], error: null },
      refs: { changed: [], error: null },
      toolCallLog: null,
    });
    expect(report.undetermined).toMatch(/^Host and external effects are undetermined/);
    expect(report.lastEvents.map((event) => event.type).slice(-3)).toEqual(["ref_snapshot_taken", "attempt_dispatching", "attempt_running"]);

    const events = await readRunEvents({ repo, runId });
    expect(events.slice(-3).map((event) => event.type)).toEqual(["attempt_unknown", "recovery_report_written", "recovery_awaited"]);
    expect(existsSync(lockFile(repo, runId))).toBe(false);
  });
});

/** Runs `attempts` until the first one's adapter loses contact, so that attempt awaits recovery. */
async function awaitingRecovery(attempts: MockAttemptScript[], step: Partial<StepDefinition> = {}) {
  const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  const { runId, state } = await runWorkflow(retryWorkflow(attempts, step), { repo });
  expect(state.state).toBe("needs_recovery");
  return { repo, runId, attemptId: implementOf(state).attempts[0]!.id };
}

const typesOf = (events: readonly { type: string }[]) => events.map((event) => event.type);

describe("resuming a run whose process stopped", () => {
  /** A finished one-step run cut after the `nth` event of `type`, as if its process had stopped right there. */
  async function stoppedAfter(type: string, attempts: MockAttemptScript[] = [hello], nth = 1) {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const { runId } = await runWorkflow(retryWorkflow(attempts), { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, type, nth);
    return { repo, runId };
  }

  const dispatchesOf = (events: readonly LedgerEvent[], attemptId: string) =>
    events.filter((event) => event.type === "attempt_dispatching" && event.attemptId === attemptId).length;

  it.each(["attempt_dispatching", "attempt_running"])(
    "never dispatches an attempt again that has a dispatching record: stopped after %s, it is unknown",
    async (type) => {
      const { repo, runId } = await stoppedAfter(type);

      const { state, resumed } = await resumeRun({ repo, runId });

      expect(resumed).toBe(true);
      expect(state.state).toBe("needs_recovery");
      const attempt = implementOf(state).attempts[0]!;
      expect(implementOf(state).attempts).toHaveLength(1);
      expect(attempt).toMatchObject({ state: "unknown", recovery: { reason: "no_terminal_record", awaited: true } });
      const events = await readRunEvents({ repo, runId });
      expect(dispatchesOf(events, attempt.id)).toBe(1);
      expect(typesOf(events.slice(events.findIndex((event) => event.type === "run_resumed")))).toEqual([
        "run_resumed",
        "attempt_unknown",
        "recovery_report_written",
        "recovery_awaited",
      ]);
    },
  );

  it("dispatches an attempt that was created and never dispatched, in a workspace made afresh", async () => {
    const { repo, runId } = await stoppedAfter("attempt_created");

    const { state } = await resumeRun({ repo, runId });

    expect(state.state).toBe("succeeded");
    const attempt = implementOf(state).attempts[0]!;
    expect(implementOf(state).attempts).toHaveLength(1);
    expect(dispatchesOf(await readRunEvents({ repo, runId }), attempt.id)).toBe(1);
  });

  it("takes up an attempt that exited where it stopped: the shared refs, its snapshot and its verification", async () => {
    const { repo, runId } = await stoppedAfter("attempt_exited");

    const { state } = await resumeRun({ repo, runId });

    expect(state.state).toBe("succeeded");
    expect(implementOf(state).attempts[0]).toMatchObject({ refs: { after: expect.any(Array) }, verification: { state: "pass" } });
  });

  it("counts a verification it stopped during as inconclusive, so the validator is run again", async () => {
    const { repo, runId } = await stoppedAfter("verification_started");

    const { state } = await resumeRun({ repo, runId });

    expect(state.state).toBe("succeeded");
    const attempt = implementOf(state).attempts[0]!;
    expect(attempt.earlierVerifications).toEqual([
      expect.objectContaining({
        state: "inconclusive",
        evidence: [{ kind: "validator_error", stage: "runtime_stopped", message: expect.stringContaining("never reached a verdict") }],
      }),
    ]);
    expect(attempt.verification).toMatchObject({ state: "pass" });
  });

  it("waits only for what is left of a retry's backoff", async () => {
    const { repo, runId } = await stoppedAfter("retry_scheduled", [rateLimited, hello]);
    const clock = fakeClock("2026-01-01T00:00:00.500Z");

    const { state } = await resumeRun({ repo, runId, clock });

    expect(state.state).toBe("succeeded");
    expect(clock.slept).toEqual([1500]);
  });

  it("takes over the stale lock of the process that stopped, and records whose it was", async () => {
    const { repo, runId } = await stoppedAfter("attempt_running");
    const stale = { host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(lockFile(repo, runId), `${JSON.stringify(stale)}\n`);

    const { state, takenOverFrom } = await resumeRun({ repo, runId });

    expect(takenOverFrom).toEqual(stale);
    expect(state.resumptions).toEqual([expect.objectContaining({ takenOverFrom: stale })]);
    expect(existsSync(lockFile(repo, runId))).toBe(false);
  });

  it("refuses a run that a running process holds, writing nothing", async () => {
    const { repo, runId } = await stoppedAfter("attempt_running");
    const before = ledgersOf(repo);
    const { writer } = await LedgerWriter.open(ledgerFile(repo, runId));

    try {
      await expect(resumeRun({ repo, runId })).rejects.toThrow(`lock held by PID ${process.pid}`);
    } finally {
      await writer.close();
    }
    expect(ledgersOf(repo)).toEqual(before);
  });

  it("writes nothing to a run that ended, and removes a stale lock its process left", async () => {
    const { repo, runId, state: ended } = await finishedRun();
    const before = ledgersOf(repo);
    writeFileSync(lockFile(repo, runId), `${JSON.stringify({ host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" })}\n`);

    const { state, resumed, takenOverFrom } = await resumeRun({ repo, runId });

    expect({ state, resumed }).toEqual({ state: ended, resumed: false });
    expect(takenOverFrom).toMatchObject({ pid: GONE_PID });
    expect(existsSync(lockFile(repo, runId))).toBe(false);
    expect(ledgersOf(repo)).toEqual(before);
  });

  it("writes nothing to a run that awaits a decision", async () => {
    const { repo, runId } = await awaitingRecovery([helloLost]);
    const before = ledgersOf(repo);

    const { state, resumed } = await resumeRun({ repo, runId });

    expect({ state: state.state, resumed }).toEqual({ state: "needs_recovery", resumed: false });
    expect(ledgersOf(repo)).toEqual(before);
  });
});

describe("a step's recovery policy", () => {
  it("adopt verifies the workspace of an unknown attempt at once, so the run never stops for a person", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(retryWorkflow([helloLost], { recovery: "adopt" }), { repo });

    expect(state.state).toBe("succeeded");
    expect(implementOf(state).attempts[0]).toMatchObject({
      state: "unknown",
      verification: { state: "pass" },
      recovery: { reason: "lost_contact", awaited: false, decision: { policy: "adopt", decidedBy: "step_policy", user: null } },
    });
    const types = typesOf(await readRunEvents({ repo, runId }));
    expect(types).toContain("recovery_report_written");
    expect(types).not.toContain("recovery_awaited");
  });

  it("abort ends the step of an unknown attempt at once, and the run fails", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(retryWorkflow([helloLost, hello], { recovery: "abort" }), { repo });

    expect(state.state).toBe("failed");
    expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "unknown" });
    expect(implementOf(state).attempts).toHaveLength(1);
  });

  it.each([
    ["discard_and_retry", "`recovery`: `discard_and_retry` is deferred past release 1: its only safety check"],
    ["retry", "`recovery` must be one of manual, adopt, abort"],
  ])("must be manual, adopt or abort: %s is refused", (recovery, message) => {
    const problems = validateWorkflow({ ...retryWorkflow([hello]), steps: [{ ...retryWorkflow([hello]).steps[0], recovery }] });

    expect(problems).toEqual([expect.stringContaining(`step "implement": ${message}`)]);
  });
});

describe("deciding an attempt that awaits recovery", () => {
  it("adopt verifies its workspace as the attempt's result, without dispatching it again, and the run goes on", async () => {
    const { repo, runId, attemptId } = await awaitingRecovery([helloLost, hello]);

    const { state } = await recoverAttempt({ repo, attemptId, policy: "adopt" });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    expect(step.state).toBe("succeeded");
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]).toMatchObject({
      state: "unknown",
      verification: { state: "pass" },
      recovery: { awaited: true, decision: { policy: "adopt", decidedBy: "human", user: userInfo().username } },
    });
    const events = await readRunEvents({ repo, runId });
    expect(typesOf(events).filter((type) => type === "attempt_dispatching")).toHaveLength(1);
    expect(typesOf(events.slice(events.findIndex((event) => event.type === "recovery_awaited")))).toEqual([
      "recovery_awaited",
      "run_resumed",
      "recovery_decided",
      "workspace_snapshot_committed",
      "verification_started",
      "verification_verdict",
      "step_terminal",
      "run_terminal",
    ]);
    expect(state.resumptions).toEqual([{ seq: expect.any(Number), time: expect.any(String), takenOverFrom: null }]);
  });

  it("adopt treats a workspace that fails verification like any failed attempt: retried with the evidence", async () => {
    const { repo, attemptId } = await awaitingRecovery([{ ...goodbye, loseContact: true }, hello]);

    const { state } = await recoverAttempt({ repo, attemptId, policy: "adopt" });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    expect(step.attempts.map((attempt) => [attempt.state, attempt.failureClass])).toEqual([
      ["unknown", "verification_failed"],
      ["exited", null],
    ]);
    expect(step.handoffs.map((handoff) => handoff.revision)).toEqual([1, 2]);
  });

  it("abort ends the step as unknown, never retried although its budget is untouched, and the run fails", async () => {
    const { repo, attemptId } = await awaitingRecovery([helloLost, hello]);

    const { state } = await recoverAttempt({ repo, attemptId, policy: "abort" });

    expect(state.state).toBe("failed");
    const step = implementOf(state);
    expect(step).toMatchObject({ state: "failed", failureClass: "unknown", retryUsage: { retries: 0 } });
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]).toMatchObject({ failureClass: "unknown", verification: null, snapshot: null });
  });

  it.each([
    {
      name: "an attempt that exited",
      setUp: async () => {
        const { repo, state } = await finishedRun();
        return { repo, attemptId: implementOf(state).attempts[0]!.id };
      },
      says: /is not awaiting recovery: it exited \(ok\)/,
    },
    {
      name: "an attempt whose recovery was already decided",
      setUp: async () => {
        const { repo, attemptId } = await awaitingRecovery([helloLost]);
        await recoverAttempt({ repo, attemptId, policy: "abort" });
        return { repo, attemptId };
      },
      says: /is not awaiting recovery: its recovery was already decided \(abort, by /,
    },
    {
      name: "an attempt no run has",
      setUp: async () => ({ repo: (await finishedRun()).repo, attemptId: "att_0000000000000" }),
      says: /no attempt att_0000000000000 in /,
    },
  ])("refuses $name and leaves every ledger as it was", async ({ setUp, says }) => {
    const { repo, attemptId } = await setUp();
    const before = ledgersOf(repo);

    await expect(recoverAttempt({ repo, attemptId, policy: "adopt" })).rejects.toThrow(says);

    expect(ledgersOf(repo)).toEqual(before);
  });

  it("refuses to adopt a workspace that is gone, and can still abort", async () => {
    const { repo, runId, attemptId } = await awaitingRecovery([helloLost]);
    const workspace = implementOf(await readRun({ repo, runId })).attempts[0]!.workspace;
    git(repo, "worktree", "remove", "--force", workspace);

    await expect(recoverAttempt({ repo, attemptId, policy: "adopt" })).rejects.toThrow(
      `its workspace ${workspace} is gone, so there is no result to adopt`,
    );

    const { state } = await recoverAttempt({ repo, attemptId, policy: "abort" });
    expect(state.state).toBe("failed");
  });
});

describe("the shared repository's refs", () => {
  it("are recorded before and after each attempt, remote-tracking refs included and AHP's own left out", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", head);
    git(repo, "tag", "v1");

    const { runId, state } = await runWorkflow(retryWorkflow([goodbye, hello]), { repo });

    const events = await readRunEvents({ repo, runId });
    const refs = [
      { name: "refs/heads/main", oid: head },
      { name: "refs/remotes/origin/main", oid: head },
      { name: "refs/tags/v1", oid: head },
    ];
    // The second attempt runs after the first one's snapshot was pinned under refs/ahp/, which is left out.
    for (const attempt of state.steps[0]!.attempts) {
      const own = events.filter((event) => "attemptId" in event && event.attemptId === attempt.id);
      expect(own.map((event) => event.type).slice(0, 7)).toEqual([
        "attempt_created",
        "ref_snapshot_taken",
        "attempt_dispatching",
        "attempt_running",
        "attempt_exited",
        "ref_snapshot_taken",
        "workspace_snapshot_committed",
      ]);
      expect(own[1]).toMatchObject({ phase: "before", refs });
      expect(own[5]).toMatchObject({ phase: "after", refs });
    }
  });
});
