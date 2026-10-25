import { afterEach, describe, expect, it } from "vitest";
import { mock, readRunEvents, runWorkflow } from "../src/index.ts";
import type { MockAttemptScript } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { failing, goodbye, hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

/**
 * The mock adapter picks a script by the step's overall attempt number, whichever agent makes the attempt, so
 * the alternative agent's scripts start after the attempts the first agent made.
 */
const after = (attempts: number, ...scripts: MockAttemptScript[]) => [...Array<MockAttemptScript>(attempts).fill({}), ...scripts];

const backup = (attempts: MockAttemptScript[]) => ({ ...mock({ attempts }), model: "backup" });

describe("a reroute", () => {
  it("hands the step to the alternative agent under a new handoff revision once the retry budget is spent", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = { agent: { ...mock({ attempts: [failing, failing, failing] }), model: "primary" }, reroute: backup(after(3, hello)) };

    const { runId, state } = await runWorkflow(retryWorkflow([], step), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const implement = implementOf(state);
    expect(implement.attempts.map((a) => [a.requestedModel, a.failureClass])).toEqual([
      ["primary", "agent_error"],
      ["primary", "agent_error"],
      ["primary", "agent_error"],
      ["backup", null],
    ]);
    // The new revision names the alternative as the recipient and keeps the contract and the base commit.
    expect(implement.handoffs.map((h) => [h.revision, h.supersedes, h.state, h.handoff.to.requestedModel])).toEqual([
      [1, null, "superseded", "primary"],
      [2, 1, "accepted", "backup"],
    ]);
    expect(implement.handoffs[1]!.handoff.base).toEqual(implement.handoffs[0]!.handoff.base);
    expect(implement.handoffs[1]!.handoff.contract).toEqual(implement.handoffs[0]!.handoff.contract);
    expect(implement.attempts.map((a) => a.handoff.revision)).toEqual([1, 1, 1, 2]);
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "retry_scheduled").map((e) => e.type === "retry_scheduled" && e.change)).toEqual([
      "none",
      "none",
      "reroute",
    ]);
    expect(implement.retryUsage.rerouted).toBe(true);
  });

  it("is off unless configured: a step whose budget is spent fails", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(retryWorkflow([failing, failing, failing, hello]), { repo, clock: fakeClock() });

    expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "agent_error" });
    expect(implementOf(state).attempts).toHaveLength(3);
    expect(implementOf(state).handoffs).toHaveLength(1);
  });

  it("starts the alternative agent on budgets of its own, and happens at most once", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = {
      retry: { budget: 1 },
      reroute: backup(after(2, failing, failing, hello)),
    };

    const { runId, state } = await runWorkflow(retryWorkflow([failing, failing], step), { repo, clock: fakeClock() });

    // Two attempts by the first agent; the alternative gets one attempt and its own retry, and then the step
    // fails: the script's third attempt is never used, because the step is not rerouted a second time.
    const implement = implementOf(state);
    expect(implement).toMatchObject({ state: "failed", failureClass: "agent_error" });
    expect(implement.attempts.map((a) => a.requestedModel)).toEqual([null, null, "backup", "backup"]);
    expect(implement.retryUsage).toEqual({ retries: 1, transientRetries: 0, transientWaitMs: 0, rerouted: true });
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "retry_scheduled").map((e) => e.type === "retry_scheduled" && e.change)).toEqual([
      "none",
      "reroute",
      "none",
    ]);
  });

  it("is also what a spent transient budget leads to", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const rateLimited: MockAttemptScript = { exitCode: 1, error: { kind: "transient", message: "429" } };
    const step = { retry: { transientBudget: 1 }, reroute: backup(after(2, hello)) };

    const { state } = await runWorkflow(retryWorkflow([rateLimited, rateLimited], step), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    expect(implementOf(state).attempts.map((a) => a.failureClass)).toEqual(["transient", "transient", null]);
  });

  it("carries the evidence of the failed verification to the alternative agent", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = { retry: { budget: 0 }, reroute: backup(after(1, hello)) };

    const { state } = await runWorkflow(retryWorkflow([goodbye], step), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const [first, second] = implementOf(state).handoffs;
    expect(first!.handoff.evidence).toEqual([]);
    expect(second!.handoff.evidence).toEqual([
      expect.objectContaining({ kind: "test_output", exitCode: 1, output: expect.stringContaining("greeting missing or wrong") }),
    ]);
  });

  it("keeps the evidence the step already had when the agent errors out and nothing new was learned", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = { reroute: backup(after(3, hello)) };

    const { state } = await runWorkflow(retryWorkflow([goodbye, failing, failing], step), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const handoffs = implementOf(state).handoffs;
    expect(handoffs.map((h) => h.revision)).toEqual([1, 2, 3]);
    // Revision 2 carried the failed verification; the agent errors that followed added nothing to it.
    expect(handoffs[2]!.handoff.evidence).toEqual(handoffs[1]!.handoff.evidence);
    expect(handoffs[2]!.handoff.evidence).not.toEqual([]);
    expect(handoffs[2]!.handoff.to.requestedModel).toBe("backup");
  });
});
