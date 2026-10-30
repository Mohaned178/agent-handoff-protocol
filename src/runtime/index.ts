export { systemClock, type Clock } from "./clock.ts";
export { executeRun, newId, type ExecuteRunOptions, type RunResult } from "./run.ts";
export { recoverAttempt, RecoveryRefusedError, resumeRun, type ResumeResult } from "./resume.ts";
export {
  classifyAttempt,
  decideAfterFailure,
  resolveRetryPolicy,
  type AttemptEnd,
  type FailureContext,
  type FailureDecision,
  type ResolvedRetryPolicy,
} from "./failure.ts";
export { currentPlatform, requestsOf, resolveCapabilities } from "./capabilities.ts";
export { validateHandoffRevision, type HandoffRecipient, type HandoffValidation } from "./handoff.ts";
export { isAttemptId, isRunId, ledgerPath, locateRepo, locateRun, runsDir } from "./paths.ts";
export { money, sourcesText, summarizeUsage, USAGE_COUNTS, usageLines, type UsageCount, type UsageSummary } from "./usage.ts";
export { githubCli, type GithubCliOptions, type PullRequestProvider, type PullRequestTarget } from "./pull-requests.ts";
export { refChanges } from "./recovery.ts";
export { ApprovalRefusedError, decideApproval, pendingApprovalOf, type DecideApprovalOptions, type PendingApproval } from "./approval.ts";
// What the evaluation engine's validators and trial repositories are built from; evaluation has no runtime of its own.
export { git } from "./git.ts";
export { introduceHiddenTests } from "./hidden-tests.ts";
export { demosRoot, evaluationsRoot, prepareWorktreeRoot, toolCallLogPath, transcriptPaths, worktreePath } from "./paths.ts";
export { changedPaths, checkProtectedPaths } from "./scope.ts";
export { evidenceVerdict, installDependencies, messageOf, runVerificationCommand, type CommandCancel } from "./verification.ts";
export { addWorktree, discardWorktree } from "./workspace.ts";
