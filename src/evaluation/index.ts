// Evaluation engine: tasks and their freezing, conditions C0 and C3, independent validators and reports.
// See .scratch/ahp-release-1/issues/20-evaluation-core.md and docs/evaluation.md.

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
export { conditionsOf, DEFAULT_RETRY_BUDGET, EVALUATION_ROLES, validateSuite, type AgentSource, type EvaluationSuite, type EvaluationRole } from "./suite.ts";
export { taskText, workflowFor } from "./conditions.ts";
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
export { formatReport, MOCK_REPORT_NOTE, reportOf, type ConditionReport, type EvaluationReport, type FailureOutcome } from "./report.ts";
export { readEvaluation, runEvaluation, SuiteInvalidError, type EvaluationResult, type RunEvaluationOptions } from "./run.ts";
