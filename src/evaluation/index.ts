// Evaluation engine: tasks and their freezing, conditions C0–C3 and the matched-budget baseline, repeats in a seeded order,
// independent validators, and reports with paired comparisons. See .scratch/ahp-release-1/issues/20-evaluation-core.md,
// 21-evaluation-conditions-and-statistics.md and docs/evaluation.md.

export { CONSTRAINT_CHECK_KINDS, forbiddenPatternViolations, type ConstraintCheck, type ConstraintCheckKind } from "./checks.ts";
export { changesBetween, fileListOf, hashOfFiles, sha256Of } from "./freeze.ts";
export {
  loadTask,
  parseTask,
  readTaskFiles,
  TaskInvalidError,
  type EvaluationTask,
  type LoadedTask,
  type SeededDefect,
  type TaskConstraint,
} from "./task.ts";
export * from "./events.ts";
export { conditionsOf, DEFAULT_RETRY_BUDGET, EVALUATION_ROLES, validateSuite, type AgentSource, type EvaluationSuite, type EvaluationRole, type TrialSlot } from "./suite.ts";
export { retryBudgetOf, taskText, workflowFor } from "./conditions.ts";
export { validateResult, type ConstraintFinding, type Validation, type ValidationEvidence, type ValidationInput } from "./validators.ts";
export {
  applyEvaluationEvent,
  EvaluationLedgerInconsistentError,
  replayEvaluation,
  type EvaluationState,
  type EvaluationView,
  type TaskView,
  type TrialEnded,
  type TrialView,
} from "./replay.ts";
export {
  BOOTSTRAP_RESAMPLES,
  COMPARISON_FINDINGS,
  comparePaired,
  isSeed,
  MIN_PAIRED_TASKS,
  pairedBootstrap,
  PAIRING_GAPS,
  seededRandom,
  seededShuffle,
  type ComparisonFinding,
  type PairedComparison,
  type PairingGap,
  type SideCounts,
  type TaskTally,
} from "./statistics.ts";
export {
  API_KEY_NOTICE,
  COMPARISONS,
  formatReport,
  MOCK_REPORT_NOTE,
  reportOf,
  USAGE_COUNTS,
  type BaselineCell,
  type BaselineReport,
  type ConditionComparison,
  type ConditionReport,
  type EvaluationReport,
  type FailureOutcome,
  type InvalidCell,
  type SpendReport,
  type ToolVersionReport,
  type TrialCondition,
  type UsageCount,
  type UsageSummary,
  type WallTime,
} from "./report.ts";
export { recordToolVersions, toolsUsedBy, versionNumberOf } from "./tools.ts";
export { readEvaluation, runEvaluation, SuiteInvalidError, type EvaluationResult, type RunEvaluationOptions } from "./run.ts";
