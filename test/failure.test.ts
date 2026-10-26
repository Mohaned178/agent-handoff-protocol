import { describe, expect, it } from "vitest";
import { classifyAttempt, decideAfterFailure, FAILURE_CLASSES, resolveRetryPolicy } from "../src/index.ts";
import type { AttemptEnd, FailureClass, FailureDecision, RetryPolicy, RetryUsage } from "../src/index.ts";

/** An attempt that ended cleanly: exit 0, the agent finished its turn, nothing reported, not yet verified. */
const clean: AttemptEnd = { exitCode: 0, signal: null, stopReason: null, error: null, verdict: null };

describe("the failure classes", () => {
  it("are a closed list; a new class is a protocol change", () => {
    expect([...FAILURE_CLASSES]).toEqual([
      "rejected",
      "config_auth",
      "transient",
      "agent_error",
      "verification_failed",
      "inconclusive",
      "unknown",
      "external_action_failed",
    ]);
  });
});

describe("classifying an ended attempt", () => {
  const table: [name: string, end: Partial<AttemptEnd>, expected: FailureClass | null][] = [
    ["a clean exit that has not been verified yet is not a failure", {}, null],
    ["a clean exit at the end of the agent's turn", { stopReason: "end_turn" }, null],
    ["a clean exit whose verification passed", { verdict: "pass" }, null],

    ["a non-zero exit is an agent error", { exitCode: 3 }, "agent_error"],
    ["a process killed by a signal is an agent error", { exitCode: null, signal: "SIGKILL" }, "agent_error"],
    ["a refusal is an agent error even though the process exited 0", { stopReason: "refusal" }, "agent_error"],
    ["running out of turns is an agent error", { stopReason: "max_turn_requests" }, "agent_error"],
    ["running out of tokens is an agent error", { stopReason: "max_tokens" }, "agent_error"],
    ["an error the adapter calls an agent error is an agent error", { error: { kind: "agent_error", message: "x" } }, "agent_error"],

    ["an adapter-reported transient error is transient, whatever the exit code", { exitCode: 1, error: { kind: "transient", message: "rate limited" } }, "transient"],
    ["an adapter-reported transient error is transient even when the process exited 0", { error: { kind: "transient", message: "overloaded" } }, "transient"],
    ["an adapter-reported auth error is config/auth", { exitCode: 1, error: { kind: "config_auth", message: "not logged in" } }, "config_auth"],
    ["the adapter's own classification outranks the exit code and the stop reason", { exitCode: 2, stopReason: "refusal", error: { kind: "config_auth", message: "bad flag" } }, "config_auth"],

    ["a failing verdict is verification_failed", { verdict: "fail" }, "verification_failed"],
    ["an inconclusive verdict is inconclusive, never a failure of the attempt", { verdict: "inconclusive" }, "inconclusive"],
    ["a failing exit is judged before any verdict, which a failed attempt never has", { exitCode: 1, verdict: null }, "agent_error"],
  ];

  it.each(table)("%s", (_name, end, expected) => {
    expect(classifyAttempt({ ...clean, ...end })).toBe(expected);
  });
});

describe("what to do after a failure", () => {
  const nothingSpent: RetryUsage = { retries: 0, transientRetries: 0, transientWaitMs: 0, rerouted: false };
  const stop = (reason: Extract<FailureDecision, { action: "stop" }>["reason"]): FailureDecision => ({ action: "stop", reason });

  function decide(
    failureClass: FailureClass,
    options: { retry?: RetryPolicy; spent?: Partial<RetryUsage>; validatorRuns?: number; reroute?: boolean } = {},
  ): FailureDecision {
    return decideAfterFailure({
      failureClass,
      policy: resolveRetryPolicy(options.retry),
      usage: { ...nothingSpent, ...options.spent },
      validatorRuns: options.validatorRuns ?? 1,
      reroute: options.reroute ?? false,
    });
  }

  it("defaults to 2 retries shared by agent errors and failed verifications, and 5 transient retries", () => {
    expect(resolveRetryPolicy()).toMatchObject({ budget: 2, transientBudget: 5 });
    expect(resolveRetryPolicy({ budget: 0 })).toMatchObject({ budget: 0, transientBudget: 5 });
    expect(resolveRetryPolicy({ transientBudget: 1 })).toMatchObject({ budget: 2, transientBudget: 1 });
  });

  it("never retries a rejected handoff, a config/auth failure, an unknown outcome or a failed external action, even with a reroute configured", () => {
    for (const failureClass of ["rejected", "config_auth", "unknown", "external_action_failed"] as const) {
      expect(decide(failureClass, { reroute: true }), failureClass).toEqual(stop("not_retryable"));
    }
  });

  it("retries an agent error with the same input, immediately, until the shared budget is spent", () => {
    expect(decide("agent_error")).toEqual({ action: "retry", input: "same", delayMs: 0 });
    expect(decide("agent_error", { spent: { retries: 1 } })).toEqual({ action: "retry", input: "same", delayMs: 0 });
    expect(decide("agent_error", { spent: { retries: 2 } })).toEqual(stop("budget_exhausted"));
  });

  it("retries a failed verification with changed input, since the evidence is new input", () => {
    expect(decide("verification_failed")).toEqual({ action: "retry", input: "changed", delayMs: 0 });
    expect(decide("verification_failed", { spent: { retries: 2 } })).toEqual(stop("budget_exhausted"));
  });

  it("draws agent errors and failed verifications on one budget, which a configured budget replaces", () => {
    // Two retries already went to failed verifications, so an agent error has none left.
    expect(decide("agent_error", { spent: { retries: 2 } })).toEqual(stop("budget_exhausted"));
    expect(decide("agent_error", { retry: { budget: 3 }, spent: { retries: 2 } })).toMatchObject({ action: "retry" });
    expect(decide("agent_error", { retry: { budget: 0 } })).toEqual(stop("budget_exhausted"));
  });

  it("retries a transient failure with the same input after an exponential wait, on a budget of its own", () => {
    expect(decide("transient")).toEqual({ action: "retry", input: "same", delayMs: 2000 });
    expect(decide("transient", { spent: { transientRetries: 1 } })).toEqual({ action: "retry", input: "same", delayMs: 4000 });
    expect(decide("transient", { spent: { transientRetries: 2 } })).toEqual({ action: "retry", input: "same", delayMs: 8000 });
    expect(decide("transient", { spent: { transientRetries: 5 } })).toEqual(stop("budget_exhausted"));
    // The shared budget being spent does not stop a transient retry, and transient retries do not spend it.
    expect(decide("transient", { spent: { retries: 2 } })).toMatchObject({ action: "retry" });
  });

  it("follows the configured backoff", () => {
    const retry = { backoff: { initialMs: 100, factor: 3 } };

    expect(decide("transient", { retry })).toMatchObject({ delayMs: 100 });
    expect(decide("transient", { retry, spent: { transientRetries: 3 } })).toMatchObject({ delayMs: 2700 });
  });

  it("stops retrying a transient failure rather than wait past the cap on a step's total wait", () => {
    const retry = { transientBudget: 5, backoff: { initialMs: 1000, factor: 2, maxTotalMs: 5000 } };

    // Waited 1000 + 2000 so far; the next wait is 4000, which would bring the total to 7000.
    expect(decide("transient", { retry, spent: { transientRetries: 2, transientWaitMs: 3000 } })).toEqual(stop("budget_exhausted"));
    // Waited 1000 so far; the next wait is 2000, which still fits.
    expect(decide("transient", { retry, spent: { transientRetries: 1, transientWaitMs: 1000 } })).toMatchObject({ delayMs: 2000 });
    // A wait that exactly reaches the cap is allowed.
    expect(decide("transient", { retry, spent: { transientRetries: 2, transientWaitMs: 1000 } })).toMatchObject({ delayMs: 4000 });
  });

  it("re-runs the validator once for an inconclusive verification, then escalates; it is never a retry", () => {
    expect(decide("inconclusive", { validatorRuns: 1 })).toEqual({ action: "rerun_validator" });
    expect(decide("inconclusive", { validatorRuns: 2 })).toEqual(stop("escalate"));
    // Not counted: a spent budget changes nothing, and a reroute is not offered for a validator that broke.
    expect(decide("inconclusive", { validatorRuns: 1, spent: { retries: 2 } })).toEqual({ action: "rerun_validator" });
    expect(decide("inconclusive", { validatorRuns: 2, reroute: true })).toEqual(stop("escalate"));
  });

  it("reroutes when the budget is spent and a reroute is configured, once, and not otherwise", () => {
    expect(decide("agent_error", { spent: { retries: 2 } })).toEqual(stop("budget_exhausted"));
    expect(decide("agent_error", { spent: { retries: 2 }, reroute: true })).toEqual({ action: "reroute" });
    expect(decide("verification_failed", { spent: { retries: 2 }, reroute: true })).toEqual({ action: "reroute" });
    expect(decide("transient", { spent: { transientRetries: 5 }, reroute: true })).toEqual({ action: "reroute" });
    expect(decide("agent_error", { retry: { budget: 0 }, reroute: true })).toEqual({ action: "reroute" });
    // Retries come first: the reroute waits for the budget.
    expect(decide("agent_error", { spent: { retries: 1 }, reroute: true })).toMatchObject({ action: "retry" });
    expect(decide("agent_error", { spent: { retries: 2, rerouted: true }, reroute: true })).toEqual(stop("budget_exhausted"));
  });
});
