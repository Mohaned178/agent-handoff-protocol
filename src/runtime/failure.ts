import type {
  AttemptError,
  FailureClass,
  RetryPolicy,
  RetryUsage,
  StopReason,
  VerificationState,
} from "../protocol/index.ts";

/** What is known about an attempt once its process has ended, and its verdict if it was verified. */
export interface AttemptEnd {
  exitCode: number | null;
  signal: string | null;
  stopReason: StopReason | null;
  /** What the adapter observed go wrong; its classification outranks everything else here. */
  error: AttemptError | null;
  /** Null when the attempt was not verified: verification is for attempts whose agent ended cleanly. */
  verdict: Exclude<VerificationState, "pending"> | null;
}

/** Stop reasons that mean the agent did not complete the work, even if its process exited 0. */
const FAILED_STOP_REASONS: readonly StopReason[] = ["max_tokens", "max_turn_requests", "refusal"];

/**
 * The failure class of an ended attempt, or null when it did not fail: its agent ended cleanly and either
 * verification has not run yet or it passed. Pure; the adapter's own error comes first, then how the process
 * and the agent's turn ended, and only then the verdict.
 *
 * An attempt whose agent did not end cleanly is never verified, so it never has a verdict: a coding agent that
 * crashed or gave up has no finished result to check, and `exited(error)` with a passing verification would
 * contradict itself. `rejected` and `unknown` are not outcomes of an ended attempt, so this never returns them.
 */
export function classifyAttempt(end: AttemptEnd): FailureClass | null {
  if (end.error) return end.error.kind;
  if (end.stopReason !== null && FAILED_STOP_REASONS.includes(end.stopReason)) return "agent_error";
  if (end.exitCode !== 0) return "agent_error";
  switch (end.verdict) {
    case "fail":
      return "verification_failed";
    case "inconclusive":
      return "inconclusive";
    default:
      return null;
  }
}

/** A retry policy with every default filled in. */
export interface ResolvedRetryPolicy {
  budget: number;
  transientBudget: number;
  backoff: { initialMs: number; factor: number; maxTotalMs: number };
}

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  budget: 2,
  transientBudget: 5,
  // 2 + 4 + 8 + 16 + 32 seconds for the five default retries: a rate limit is waited out, not hammered.
  backoff: { initialMs: 2_000, factor: 2, maxTotalMs: 120_000 },
};

export function resolveRetryPolicy(retry: RetryPolicy = {}): ResolvedRetryPolicy {
  return {
    budget: retry.budget ?? DEFAULT_RETRY_POLICY.budget,
    transientBudget: retry.transientBudget ?? DEFAULT_RETRY_POLICY.transientBudget,
    backoff: { ...DEFAULT_RETRY_POLICY.backoff, ...retry.backoff },
  };
}

export interface FailureContext {
  failureClass: FailureClass;
  policy: ResolvedRetryPolicy;
  /** What the step has spent so far, as replay of its ledger counts it. */
  usage: RetryUsage;
  /** How many times the failed attempt's verification has run, the one that failed included. */
  validatorRuns: number;
  /** Whether the step names an alternative coding agent. */
  reroute: boolean;
}

/**
 * What the runtime does after a failure.
 * - `retry`: a new attempt after `delayMs`; `input: "same"` under the same handoff revision, `"changed"` under a
 *   new revision that carries the evidence.
 * - `rerun_validator`: verify the same snapshot again; no new attempt.
 * - `reroute`: a new revision naming the alternative agent, then a new attempt.
 * - `stop`: the step fails with the failure's class. `not_retryable` is the class's own rule, `budget_exhausted`
 *   means there was nothing left to spend and no reroute to make, `escalate` is a validator that broke twice.
 */
export type FailureDecision =
  | { action: "retry"; input: "same" | "changed"; delayMs: number }
  | { action: "rerun_validator" }
  | { action: "reroute" }
  | { action: "stop"; reason: "not_retryable" | "budget_exhausted" | "escalate" };

/** The most validator runs an attempt gets: the one that was inconclusive, and one re-run. */
export const MAX_VALIDATOR_RUNS = 2;

/**
 * Decides what follows a failure, from its class and what the step has already spent. Pure: the same inputs give
 * the same decision, so budgets read from replay survive a restart. An exhausted budget reroutes when the step
 * has an alternative that was not used yet, and stops otherwise.
 */
export function decideAfterFailure(context: FailureContext): FailureDecision {
  const { failureClass, policy, usage } = context;
  const exhausted = (): FailureDecision =>
    context.reroute && !usage.rerouted ? { action: "reroute" } : { action: "stop", reason: "budget_exhausted" };

  switch (failureClass) {
    case "rejected":
    case "config_auth":
    case "unknown":
      return { action: "stop", reason: "not_retryable" };
    case "inconclusive":
      return context.validatorRuns < MAX_VALIDATOR_RUNS ? { action: "rerun_validator" } : { action: "stop", reason: "escalate" };
    case "agent_error":
      return usage.retries < policy.budget ? { action: "retry", input: "same", delayMs: 0 } : exhausted();
    case "verification_failed":
      return usage.retries < policy.budget ? { action: "retry", input: "changed", delayMs: 0 } : exhausted();
    case "transient": {
      if (usage.transientRetries >= policy.transientBudget) return exhausted();
      const { initialMs, factor, maxTotalMs } = policy.backoff;
      const delayMs = Math.round(initialMs * factor ** usage.transientRetries);
      if (usage.transientWaitMs + delayMs > maxTotalMs) return exhausted();
      return { action: "retry", input: "same", delayMs };
    }
  }
}
