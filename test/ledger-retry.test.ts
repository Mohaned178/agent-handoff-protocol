import { afterEach, describe, expect, it } from "vitest";
import { readRun, runWorkflow } from "../src/index.ts";
import type { MockAttemptScript } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { appendLedgerEvent } from "./helpers/ledger.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { failing, goodbye, hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

const rateLimited: MockAttemptScript = { exitCode: 1, error: { kind: "transient", message: "429" } };

describe("replaying retries from the ledger", () => {
  /** A finished run whose step failed once as an agent error and then passed. */
  async function retriedRun() {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const { runId, state } = await runWorkflow(retryWorkflow([failing, hello]), { repo, clock: fakeClock() });
    const step = implementOf(state);
    return { repo, runId, step, failed: step.attempts[0]!, passed: step.attempts[1]! };
  }

  it("counts what a step spent of its budgets from the ledger alone, so a restart sees what is left", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const { runId, state } = await runWorkflow(retryWorkflow([rateLimited, failing, goodbye, rateLimited, hello]), {
      repo,
      clock: fakeClock(),
    });

    const replayed = await readRun({ repo, runId });

    expect(replayed).toEqual(state);
    expect(implementOf(replayed).retryUsage).toEqual({ retries: 2, transientRetries: 2, transientWaitMs: 2000 + 4000, rerouted: false });
  });

  it("refuses a ledger that reuses an attempt ID, since (handoff, revision, attempt) is the idempotency key", async () => {
    const { repo, runId, step, passed } = await retriedRun();

    appendLedgerEvent(repo, runId, {
      type: "attempt_created",
      stepId: "implement",
      attemptId: passed.id,
      handoffId: step.handoffs[0]!.handoffId,
      handoffRevision: 1,
      adapter: "mock",
      mock: true,
      requestedModel: null,
      workspace: "/nowhere",
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(/already exists/);
  });

  it("refuses an attempt on a step that is not ready for one: only a scheduled retry makes it ready again", async () => {
    const { repo, runId, step } = await retriedRun();

    appendLedgerEvent(repo, runId, {
      type: "attempt_created",
      stepId: "implement",
      attemptId: "att_extra",
      handoffId: step.handoffs[0]!.handoffId,
      handoffRevision: 1,
      adapter: "mock",
      mock: true,
      requestedModel: null,
      workspace: "/nowhere",
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(/not ready for an attempt/);
  });

  it("refuses a failure class the attempt's own record contradicts", async () => {
    const { repo, runId, passed } = await retriedRun();

    // The attempt exited ok and passed verification; it cannot have failed as an agent error or a failed verification.
    appendLedgerEvent(repo, runId, { type: "attempt_failed", attemptId: passed.id, failureClass: "agent_error" });

    await expect(readRun({ repo, runId })).rejects.toThrow(/cannot have failed as agent_error/);
  });

  it("refuses to classify an attempt twice", async () => {
    const { repo, runId, failed } = await retriedRun();

    appendLedgerEvent(repo, runId, { type: "attempt_failed", attemptId: failed.id, failureClass: "agent_error" });

    await expect(readRun({ repo, runId })).rejects.toThrow(/already classified agent_error/);
  });

  it("refuses to schedule a retry for a step that already ended", async () => {
    const { repo, runId, failed } = await retriedRun();

    appendLedgerEvent(repo, runId, {
      type: "retry_scheduled",
      stepId: "implement",
      attemptId: failed.id,
      failureClass: "agent_error",
      change: "none",
      delayMs: 0,
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(/already succeeded/);
  });

  it("refuses a second verification of an attempt whose verification was conclusive", async () => {
    const { repo, runId, passed } = await retriedRun();

    appendLedgerEvent(repo, runId, {
      type: "verification_started",
      attemptId: passed.id,
      verificationId: "ver_again",
      command: null,
      worktree: null,
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(/already verified \(pass\)/);
  });

  it("refuses a second re-run of a verification that stayed inconclusive: the validator is re-run once", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });
    const alwaysBroken = { command: 'node -e "process.exit(127)"' };
    const { runId, state } = await runWorkflow(retryWorkflow([hello], { verification: alwaysBroken }), { repo, clock: fakeClock() });
    const attempt = implementOf(state).attempts[0]!;
    expect(attempt.earlierVerifications).toHaveLength(1);

    appendLedgerEvent(repo, runId, {
      type: "verification_started",
      attemptId: attempt.id,
      verificationId: "ver_third",
      command: null,
      worktree: null,
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(/already verified \(inconclusive\)/);
  });
});
