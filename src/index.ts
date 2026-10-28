// Public SDK entry point.

export * from "./protocol/index.ts";
export * from "./sdk/index.ts";
export { mock, MOCK_USAGE_SOURCE, type MockAttemptScript, type MockEdit, type MockOptions, type MockUsage } from "./adapters/index.ts";
export { claudeCode, type ClaudeCodeOptions } from "./adapters/index.ts";
export { codex, type CodexOptions } from "./adapters/index.ts";
export { opencode, type OpenCodeOptions } from "./adapters/index.ts";
export {
  classifyAttempt,
  decideAfterFailure,
  resolveRetryPolicy,
  type AttemptEnd,
  type Clock,
  type FailureContext,
  type FailureDecision,
  type ResolvedRetryPolicy,
  type RunResult,
} from "./runtime/index.ts";
export * from "./conformance/index.ts";
export * from "./doctor/index.ts";
// The evaluation engine's public surface: running a suite, reading its ledger and report, and the types of its results. The
// rest (the freeze hash, replay, the validators) stays inside the module. "Task" is reserved for the A2A task shape, so the
// evaluation's are named as the glossary names them.
export {
  CONDITIONS,
  DEFAULT_RETRY_BUDGET,
  formatReport,
  loadTask as loadEvaluationTask,
  readEvaluation,
  reportOf,
  runEvaluation,
  SuiteInvalidError,
  TaskInvalidError as EvaluationTaskInvalidError,
  TRIAL_OUTCOMES,
  UNSCORED_REASONS,
  validateSuite,
  type AgentSource,
  type ConditionId,
  type ConditionReport,
  type EvaluationEvent,
  type EvaluationReport,
  type EvaluationResult,
  type EvaluationState,
  type EvaluationSuite,
  type EvaluationTask,
  type EvaluationView,
  type FailureOutcome,
  type RunEvaluationOptions,
  type TrialEnded,
  type TrialOutcome,
  type TrialScore,
  type TrialView,
  type UnscoredReason,
} from "./evaluation/index.ts";
