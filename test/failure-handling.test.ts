import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, mock, readRunEvents, runWorkflow } from "../src/index.ts";
import type { MockAttemptScript } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING, VERIFY_OK } from "./helpers/repo.ts";
import { failing, goodbye, hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

const scratch: string[] = [];
afterEach(() => {
  removeTempRepos();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const rateLimited: MockAttemptScript = { exitCode: 1, error: { kind: "transient", message: "429: rate limited" } };
const notLoggedIn: MockAttemptScript = { exitCode: 1, error: { kind: "config_auth", message: "not logged in: run `claude login`" } };

describe("a transient failure", () => {
  it("is retried after an exponential wait, under the same handoff revision", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const clock = fakeClock();

    const { runId, state } = await runWorkflow(retryWorkflow([rateLimited, rateLimited, hello]), { repo, clock });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    expect(step.attempts.map((a) => a.failureClass)).toEqual(["transient", "transient", null]);
    expect(step.handoffs).toHaveLength(1);
    expect(step.attempts[0]!.error).toEqual({ kind: "transient", message: "429: rate limited" });
    expect(clock.slept).toEqual([2000, 4000]);
    expect(step.retryUsage).toEqual({ retries: 0, transientRetries: 2, transientWaitMs: 6000, rerouted: false });

    // The wait is recorded before it is taken, and the ledger's time shows it was taken.
    const events = await readRunEvents({ repo, runId });
    const retries = events.filter((e) => e.type === "retry_scheduled");
    expect(retries.map((e) => [e.change, e.delayMs])).toEqual([
      ["none", 2000],
      ["none", 4000],
    ]);
    const nextAttemptAfter = (retry: (typeof events)[number]) =>
      events.slice(events.indexOf(retry)).find((e) => e.type === "attempt_created")!;
    for (const retry of retries) {
      const waited = Date.parse(nextAttemptAfter(retry).time) - Date.parse(retry.time);
      expect(waited).toBe(retry.type === "retry_scheduled" ? retry.delayMs : -1);
    }
  });

  it("has a budget of its own: 5 retries, with waits that double, before the step fails", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const clock = fakeClock();

    const { state } = await runWorkflow(retryWorkflow(Array(7).fill(rateLimited)), { repo, clock });

    const step = implementOf(state);
    expect(step).toMatchObject({ state: "failed", failureClass: "transient" });
    expect(step.attempts).toHaveLength(6);
    expect(clock.slept).toEqual([2000, 4000, 8000, 16000, 32000]);
  });

  it("does not spend the budget agent errors and failed verifications share, and does not draw on it", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(retryWorkflow([rateLimited, failing, goodbye, rateLimited, hello]), {
      repo,
      clock: fakeClock(),
    });

    // Two transient retries and two shared ones: with one budget of 2 this run would have failed.
    expect(state.state).toBe("succeeded");
    expect(implementOf(state).retryUsage).toMatchObject({ retries: 2, transientRetries: 2 });
  });

  it("stops retrying rather than wait past the cap on the step's total wait", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const clock = fakeClock();
    const retry = { transientBudget: 5, backoff: { initialMs: 1000, factor: 2, maxTotalMs: 5000 } };

    const { state } = await runWorkflow(retryWorkflow(Array(6).fill(rateLimited), { retry }), { repo, clock });

    // Waits of 1000 and 2000 fit; the next, 4000, would make 7000.
    expect(clock.slept).toEqual([1000, 2000]);
    expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "transient" });
    expect(implementOf(state).attempts).toHaveLength(3);
  });
});

describe("a config/auth failure", () => {
  it("is not retried, not verified and surfaced with the adapter's message", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(retryWorkflow([notLoggedIn, hello]), { repo, clock: fakeClock() });

    expect(state.state).toBe("failed");
    const step = implementOf(state);
    expect(step).toMatchObject({ state: "failed", failureClass: "config_auth" });
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0]).toMatchObject({
      failureClass: "config_auth",
      error: { kind: "config_auth", message: "not logged in: run `claude login`" },
      verification: null,
    });
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "retry_scheduled")).toEqual([]);
  });

  it("is not rerouted either: another agent is not the cure for this agent's login", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const reroute = mock({ attempts: [{}, hello] });

    const { state } = await runWorkflow(retryWorkflow([notLoggedIn], { reroute }), { repo, clock: fakeClock() });

    expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "config_auth" });
    expect(implementOf(state).attempts).toHaveLength(1);
  });
});

describe("a rejected handoff", () => {
  it("is never retried: no attempt runs, and the step fails as rejected", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const plan = { id: "plan", agent: mock({ attempts: [{}] }), verification: { command: "node ok.mjs" }, artifacts: ["PLAN.md"] };
    const implement = { id: "implement", agent: mock({ attempts: [{}, {}, {}] }), verification: { command: "node ok.mjs" } };

    const { runId, state } = await runWorkflow(defineWorkflow({ name: "rejected", steps: [plan, implement] }), {
      repo,
      clock: fakeClock(),
    });

    const step = state.steps[1]!;
    expect(step).toMatchObject({ state: "failed", failureClass: "rejected", attempts: [] });
    expect(step.handoffs).toHaveLength(1);
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "retry_scheduled" || e.type === "attempt_failed")).toEqual([]);
  });
});

describe("an agent that did not end cleanly", () => {
  it("is an agent error and is not verified, even if its workspace would pass", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(retryWorkflow([{ ...hello, exitCode: 3 }, hello]), { repo, clock: fakeClock() });

    const [crashed, retried] = implementOf(state).attempts;
    expect(crashed).toMatchObject({ outcome: "error", exitCode: 3, failureClass: "agent_error", verification: null });
    // Its work was snapshotted for whoever wants to look, and verification never ran on it.
    expect(crashed!.snapshot).not.toBeNull();
    expect(retried).toMatchObject({ outcome: "ok", failureClass: null });
    expect(retried!.verification?.state).toBe("pass");
  });

  it("includes an agent that refused or ran out of turns although its process exited 0", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const refused: MockAttemptScript = { ...hello, stopReason: "refusal" };
    const outOfTurns: MockAttemptScript = { ...hello, stopReason: "max_turn_requests" };

    const { state } = await runWorkflow(retryWorkflow([refused, outOfTurns, hello]), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    expect(implementOf(state).attempts.map((a) => [a.exitCode, a.stopReason, a.outcome, a.failureClass])).toEqual([
      [0, "refusal", "error", "agent_error"],
      [0, "max_turn_requests", "error", "agent_error"],
      [0, null, "ok", null],
    ]);
  });
});

/**
 * A verification script that exits 127 ("cannot run") the first time it runs anywhere, and checks the greeting
 * after that. Its marker is outside the repository, since every verification starts in a fresh worktree.
 */
function flakyValidator(failures: number): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ahp-flaky-"));
  scratch.push(dir);
  return {
    "flaky.mjs": `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const runs = ${JSON.stringify(join(dir, "runs.txt"))};
      const n = existsSync(runs) ? Number(readFileSync(runs, "utf8")) : 0;
      writeFileSync(runs, String(n + 1));
      if (n < ${failures}) process.exit(127);
      const ok = existsSync("greeting.txt") && readFileSync("greeting.txt", "utf8").trim() === "hello";
      process.exit(ok ? 0 : 1);
    `,
  };
}

describe("an inconclusive verification", () => {
  const flaky = { command: "node flaky.mjs" };

  it("is re-run once on the same snapshot, with no new attempt and nothing spent, and a pass then passes the step", async () => {
    const repo = createTempRepo(flakyValidator(1));

    const { runId, state } = await runWorkflow(retryWorkflow([hello], { verification: flaky }), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    expect(step.attempts).toHaveLength(1);
    const [attempt] = step.attempts;
    expect(attempt!.earlierVerifications.map((v) => v.state)).toEqual(["inconclusive"]);
    expect(attempt!.verification?.state).toBe("pass");
    expect(attempt!.failureClass).toBeNull();
    expect(step.retryUsage).toEqual({ retries: 0, transientRetries: 0, transientWaitMs: 0, rerouted: false });
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "verification_verdict").map((e) => e.type === "verification_verdict" && e.verdict)).toEqual([
      "inconclusive",
      "pass",
    ]);
    expect(events.filter((e) => e.type === "retry_scheduled" || e.type === "attempt_failed")).toEqual([]);
    // Both verification worktrees are gone: the repository and the one attempt workspace remain.
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
  });

  it("is escalated when the re-run is inconclusive too: the step fails as inconclusive, not retried and not counted", async () => {
    const repo = createTempRepo(flakyValidator(5));

    const { runId, state } = await runWorkflow(retryWorkflow([hello, hello, hello], { verification: flaky }), {
      repo,
      clock: fakeClock(),
    });

    expect(state.state).toBe("failed");
    const step = implementOf(state);
    expect(step).toMatchObject({ state: "failed", failureClass: "inconclusive" });
    expect(step.attempts).toHaveLength(1);
    const [attempt] = step.attempts;
    expect(attempt).toMatchObject({ failureClass: "inconclusive" });
    expect([...attempt!.earlierVerifications, attempt!.verification!].map((v) => v.state)).toEqual(["inconclusive", "inconclusive"]);
    expect(step.retryUsage).toEqual({ retries: 0, transientRetries: 0, transientWaitMs: 0, rerouted: false });
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "verification_started")).toHaveLength(2);
    expect(events.filter((e) => e.type === "retry_scheduled")).toEqual([]);
  });

  it("is a verification failure when the re-run finds the work failing, and is retried with its evidence", async () => {
    const repo = createTempRepo(flakyValidator(1));

    const { state } = await runWorkflow(retryWorkflow([goodbye, hello], { verification: flaky }), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const [first, second] = implementOf(state).attempts;
    expect(first!.earlierVerifications.map((v) => v.state)).toEqual(["inconclusive"]);
    expect(first).toMatchObject({ failureClass: "verification_failed" });
    expect(first!.verification?.state).toBe("fail");
    expect(second!.handoff.revision).toBe(2);
    expect(implementOf(state).retryUsage.retries).toBe(1);
  });
});
