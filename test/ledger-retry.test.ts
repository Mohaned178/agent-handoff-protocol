import { afterEach, describe, expect, it } from "vitest";
import { readRun, runWorkflow } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { appendLedgerEvent, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { failing, goodbye, hello, implementOf, rateLimited, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);


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

describe("replaying a step that is still open", () => {
  const notLoggedIn = { exitCode: 1, error: { kind: "config_auth" as const, message: "not logged in" } };

  /** A one-step run cut right after its `nth` failed attempt, as if the runtime had stopped there. */
  async function cutAfterFailure(attempts: Parameters<typeof retryWorkflow>[0], step: Parameters<typeof retryWorkflow>[1], nth = 1) {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const { runId, state } = await runWorkflow(retryWorkflow(attempts, step), { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, "attempt_failed", nth);
    return { repo, runId, failed: implementOf(state).attempts[nth - 1]! };
  }
  const retry = (attemptId: string, failureClass: string, change: string) => ({
    type: "retry_scheduled",
    stepId: "implement",
    attemptId,
    failureClass,
    change,
    delayMs: 0,
  });

  it("accepts a retry the failure class allows, which makes the step ready again and counts what it spent", async () => {
    const { repo, runId, failed } = await cutAfterFailure([failing], { retry: { budget: 0 } });
    expect(implementOf(await readRun({ repo, runId }))).toMatchObject({ state: "in_progress" });

    appendLedgerEvent(repo, runId, retry(failed.id, "agent_error", "none"));

    expect(implementOf(await readRun({ repo, runId }))).toMatchObject({ state: "ready", retryUsage: { retries: 1 } });
  });

  it("refuses a retry a config/auth failure never gets", async () => {
    const { repo, runId, failed } = await cutAfterFailure([notLoggedIn], { retry: { budget: 0 } });

    appendLedgerEvent(repo, runId, retry(failed.id, "config_auth", "none"));

    await expect(readRun({ repo, runId })).rejects.toThrow(/config_auth failures are not retried/);
  });

  it("refuses a failed verification retried without its evidence, and an agent error retried with some", async () => {
    const verification = await cutAfterFailure([goodbye], { retry: { budget: 0 } });
    appendLedgerEvent(verification.repo, verification.runId, retry(verification.failed.id, "verification_failed", "none"));
    await expect(readRun(verification)).rejects.toThrow(/verification_failed failures are not retried with change "none"/);

    const agent = await cutAfterFailure([failing], { retry: { budget: 0 } });
    appendLedgerEvent(agent.repo, agent.runId, retry(agent.failed.id, "agent_error", "evidence"));
    await expect(readRun(agent)).rejects.toThrow(/agent_error failures are not retried with change "evidence"/);
  });

  it("refuses a retry scheduled for an attempt other than the failed last one", async () => {
    const { repo, runId } = await cutAfterFailure([failing], { retry: { budget: 0 } });

    appendLedgerEvent(repo, runId, retry("att_other", "agent_error", "none"));

    await expect(readRun({ repo, runId })).rejects.toThrow(/not the failed last attempt/);
  });

  it("refuses to reroute a step that was already rerouted", async () => {
    const alternative = { adapter: "mock", options: { attempts: [{}, failing] } };
    const { repo, runId, failed } = await cutAfterFailure([failing], { retry: { budget: 0 }, reroute: alternative }, 2);
    expect(implementOf(await readRun({ repo, runId })).retryUsage.rerouted).toBe(true);

    appendLedgerEvent(repo, runId, retry(failed.id, "agent_error", "reroute"));

    await expect(readRun({ repo, runId })).rejects.toThrow(/already rerouted/);
  });
});
