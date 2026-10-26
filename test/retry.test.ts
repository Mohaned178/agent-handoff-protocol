import { afterEach, describe, expect, it } from "vitest";
import { mock, readRunEvents, runWorkflow, validateWorkflow } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { failing, hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

describe("an agent error", () => {
  it("is retried as a new attempt under the same handoff revision, each in its own workspace", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const clock = fakeClock();

    const { state } = await runWorkflow(retryWorkflow([failing, failing, hello]), { repo, clock });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    expect(step.state).toBe("succeeded");
    expect(step.attempts.map((a) => [a.number, a.outcome, a.failureClass])).toEqual([
      [1, "error", "agent_error"],
      [2, "error", "agent_error"],
      [3, "ok", null],
    ]);
    // Same input: one handoff revision, which every attempt ran under.
    expect(step.handoffs).toHaveLength(1);
    expect(step.attempts.map((a) => a.handoff)).toEqual(Array(3).fill({ id: step.handoffs[0]!.handoffId, revision: 1 }));
    expect(new Set(step.attempts.map((a) => a.id)).size).toBe(3);
    expect(new Set(step.attempts.map((a) => a.workspace)).size).toBe(3);
    // An agent error is retried at once.
    expect(clock.slept).toEqual([]);
  });
});

describe("the retry budget", () => {
  it("fails the step with the last failure's class once the default of 2 retries is spent", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(retryWorkflow([failing, failing, failing, hello]), { repo, clock: fakeClock() });

    expect(state.state).toBe("failed");
    const step = implementOf(state);
    expect(step).toMatchObject({ state: "failed", failureClass: "agent_error" });
    // One attempt and two retries; the fourth script is never used.
    expect(step.attempts.map((a) => a.failureClass)).toEqual(["agent_error", "agent_error", "agent_error"]);
    expect(step.retryUsage).toEqual({ retries: 2, transientRetries: 0, transientWaitMs: 0, rerouted: false });
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "retry_scheduled")).toHaveLength(2);
    expect(events.map((e) => e.type).slice(-3)).toEqual(["attempt_failed", "step_terminal", "run_terminal"]);
  });

  it("is configurable per step", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const attemptsWith = async (budget: number) => {
      const { state } = await runWorkflow(retryWorkflow([failing, failing, failing, failing, failing], { retry: { budget } }), {
        repo,
        clock: fakeClock(),
      });
      return implementOf(state).attempts.length;
    };

    expect(await attemptsWith(0)).toBe(1);
    expect(await attemptsWith(1)).toBe(2);
    expect(await attemptsWith(4)).toBe(5);
  });

  it("records its intent to retry before the next attempt begins, and leaves a successful run's events as they were", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId } = await runWorkflow(retryWorkflow([failing, hello]), { repo, clock: fakeClock() });

    const events = await readRunEvents({ repo, runId });
    const attemptEvents = [
      "attempt_created",
      "ref_snapshot_taken",
      "attempt_dispatching",
      "attempt_running",
      "attempt_exited",
      "ref_snapshot_taken",
      "workspace_snapshot_committed",
    ];
    expect(events.map((e) => e.type)).toEqual([
      "run_created",
      "run_started",
      "step_ready",
      "handoff_issued",
      "handoff_accepted",
      ...attemptEvents,
      "attempt_failed",
      "retry_scheduled",
      ...attemptEvents,
      "verification_started",
      "verification_verdict",
      "step_terminal",
      "run_terminal",
    ]);
    const retry = events.find((e) => e.type === "retry_scheduled");
    expect(retry).toMatchObject({ stepId: "implement", failureClass: "agent_error", change: "none", delayMs: 0 });
  });
});

describe("workflow definition", () => {
  const plain = { id: "implement", agent: mock({ attempts: [{}] }), verification: { command: "node verify.mjs" } };

  it("accepts retry budgets, a backoff and an alternative agent", () => {
    const problems = validateWorkflow({
      name: "ok",
      steps: [
        {
          ...plain,
          retry: { budget: 0, transientBudget: 3, backoff: { initialMs: 0, factor: 1.5, maxTotalMs: 60_000 } },
          reroute: { adapter: "mock", model: "backup", options: { attempts: [{}] } },
        },
      ],
    });

    expect(problems).toEqual([]);
  });

  it("rejects retry budgets and backoff values that cannot work, naming each", () => {
    const problems = validateWorkflow({
      name: "bad-retry",
      steps: [
        {
          ...plain,
          retry: {
            budget: -1,
            transientBudget: 2.5,
            colour: "red",
            backoff: { initialMs: "soon", factor: 0.5, maxTotalMs: -5, jitter: true },
          },
        },
        { ...plain, id: "second", retry: "twice" },
        { ...plain, id: "third", retry: { backoff: 3 } },
      ],
    });

    const text = problems.join("\n");
    expect(text).toContain('step "implement": `retry.budget` must be a non-negative integer');
    expect(text).toContain('step "implement": `retry.transientBudget` must be a non-negative integer');
    expect(text).toContain("step \"implement\": unknown property `retry.colour`");
    expect(text).toContain('step "implement": `retry.backoff.initialMs` must be a non-negative integer number of milliseconds');
    expect(text).toContain('step "implement": `retry.backoff.factor` must be a number of at least 1');
    expect(text).toContain('step "implement": `retry.backoff.maxTotalMs` must be a non-negative integer number of milliseconds');
    expect(text).toContain("step \"implement\": unknown property `retry.backoff.jitter`");
    expect(text).toContain('step "second": `retry` must be an object');
    expect(text).toContain('step "third": `retry.backoff` must be an object');
    expect(problems).toHaveLength(9);
  });

  it("rejects a wait too long for a timer, which would fire at once instead", () => {
    const longest = 2 ** 31 - 1;
    const problemsFor = (backoff: object) => validateWorkflow({ name: "waits", steps: [{ ...plain, retry: { backoff } }] });

    expect(problemsFor({ initialMs: longest, maxTotalMs: longest })).toEqual([]);
    expect(problemsFor({ initialMs: longest + 1 })).toEqual([
      expect.stringContaining("`retry.backoff.initialMs` must be a non-negative integer number of milliseconds, at most 2147483647"),
    ]);
    expect(problemsFor({ maxTotalMs: longest + 1 })).toEqual([
      expect.stringContaining("`retry.backoff.maxTotalMs` must be a non-negative integer number of milliseconds, at most 2147483647"),
    ]);
  });

  it("rejects a mock script that reports a stop reason or an error the protocol does not know", () => {
    const attempts = (script: object) => ({ adapter: "mock", options: { attempts: [script] } });
    const problems = validateWorkflow({
      name: "bad-mock",
      steps: [
        { ...plain, agent: attempts({ stopReason: "bored" }) },
        { ...plain, id: "second", agent: attempts({ error: { kind: "sulking", message: "x" } }) },
        { ...plain, id: "third", agent: attempts({ error: { kind: "transient" } }) },
      ],
    });

    expect(problems).toEqual([
      expect.stringContaining('step "implement": mock attempt 1: `stopReason` must be one of end_turn, max_tokens, max_turn_requests, refusal'),
      expect.stringContaining('step "second": mock attempt 1: `error` needs a `kind` (config_auth, transient, agent_error)'),
      expect.stringContaining('step "third": mock attempt 1: `error` needs a `kind`'),
    ]);
  });

  it("holds the alternative agent to the same rules as the agent, naming it as the reroute", () => {
    const problems = validateWorkflow({
      name: "bad-reroute",
      steps: [
        { ...plain, reroute: { adapter: "no-such-tool" } },
        { ...plain, id: "second", reroute: { adapter: "mock", options: { attempts: [] } } },
        { ...plain, id: "third", reroute: "backup" },
        { ...plain, id: "fourth", reroute: { adapter: "mock", options: { attempts: [{}] }, colour: "red" } },
      ],
    });

    const text = problems.join("\n");
    expect(text).toContain('step "implement": reroute: unknown adapter "no-such-tool" (known: mock)');
    expect(text).toContain('step "second": reroute: mock adapter options need a non-empty `attempts` array');
    expect(text).toContain('step "third": `reroute` must be an object naming its `adapter`');
    expect(text).toContain("step \"fourth\": unknown property `reroute.colour`");
    expect(problems).toHaveLength(4);
  });
});
