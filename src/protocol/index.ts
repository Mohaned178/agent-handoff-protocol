// AHP protocol: workflow definitions, ledger events and the state derived from them.
// State names and failure classes are closed enumerations; adding a value is a protocol change.

import type { HandoffRevision, HandoffState, OutputFieldValue, RejectionReason } from "./handoff.ts";

export * from "./handoff.ts";
export { protocolJsonSchemas } from "./schemas.ts";
export { PROTOCOL_VERSION } from "./version.ts";

export type RunState =
  | "pending"
  | "running"
  | "waiting_approval"
  | "needs_recovery"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepState =
  | "blocked"
  | "ready"
  | "in_progress"
  | "verifying"
  | "succeeded"
  | "failed"
  | "needs_recovery"
  | "cancelled"
  | "skipped";

export type AttemptState = "created" | "dispatching" | "running" | "exited" | "unknown";

export type AttemptOutcome = "ok" | "error" | "timed_out" | "cancelled";

export type VerificationState = "pending" | "pass" | "fail" | "inconclusive";

/**
 * Why an attempt, or the step it belongs to, failed; each class has its own handling (`docs/design`, §4). A
 * closed list: a new class is a protocol change.
 * - `rejected`: the handoff was rejected, so no attempt ran. Never retried.
 * - `config_auth`: the coding agent's login or configuration is wrong. Never retried; surfaced to the user.
 * - `transient`: a rate limit, a quota or a provider network problem. Retried with backoff, on a budget of its own.
 * - `agent_error`: the agent failed (non-zero exit, refusal, ran out of turns). Retried within the shared budget.
 * - `verification_failed`: verification failed. Retried with the evidence, within the shared budget.
 * - `inconclusive`: the validator could not run. Re-run once, then escalated; never counted.
 * - `unknown`: the attempt's outcome is not known. Never retried automatically (ticket 06).
 */
export const FAILURE_CLASSES = [
  "rejected",
  "config_auth",
  "transient",
  "agent_error",
  "verification_failed",
  "inconclusive",
  "unknown",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Why a coding agent's turn ended, as its adapter normalizes it (the ACP stop reasons that matter for
 * classification). Outcome detail, never proof that the process exited. Cancellation arrives with ticket 07.
 */
export const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** The failure classes an adapter can report for an attempt it saw fail. */
export const ADAPTER_ERROR_KINDS = ["config_auth", "transient", "agent_error"] as const satisfies readonly FailureClass[];
export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

/** An error the adapter observed in the coding agent or its tool, and what class it belongs to. */
export interface AttemptError {
  kind: AdapterErrorKind;
  /** For the user: what the tool said, as far as the adapter can tell. */
  message: string;
}

// ---------------------------------------------------------------------------
// Workflow definition

/** Names the adapter that drives a step's coding agent, and what to pass it. */
export interface AgentRef {
  adapter: string;
  /** The model requested from the coding agent; recorded as requested, never as reported. */
  model?: string;
  /** Adapter-specific options, validated by the adapter. */
  options?: unknown;
}

/**
 * A step's acceptance criteria. It needs a command, required output fields, or both: with only fields the
 * verification is structural, checking that the output is complete and nothing about its quality.
 */
export interface VerificationDefinition {
  /** Run through the system shell in the verification worktree; exit code 0 is `pass`. */
  command?: string;
  /**
   * Fields the attempt must report. A missing or blank field fails verification, and the fields of a
   * passing attempt are the context of the next step's handoff.
   */
  requiredOutputFields?: string[];
  /**
   * Repository-relative paths the attempt must not change: a file, or a directory with everything under it
   * (exact paths, no globs; compared without regard to case). Name test runner config, test scripts and CI
   * config here. Hidden tests are protected too, without being listed. A change to a protected path fails
   * verification.
   */
  protectedPaths?: string[];
  /**
   * Run through the system shell in the verification worktree before `command`, to install dependencies
   * (for example `npm ci`). The worktree is built from the snapshot alone, so nothing the agent or the
   * repository's own checkout installed is there. An install that fails is a validator that could not run:
   * the verdict is `inconclusive`. Needs a `command`.
   */
  install?: string;
  /**
   * Tests the coding agent never sees. Each file is written into the verification worktree, and only there,
   * just before `command` runs; the command must run them. They are in the workflow definition and so in the
   * ledger, but not in the agent's workspace, the snapshot or the handoff. Their paths are protected paths.
   */
  hiddenTests?: HiddenTest[];
}

export interface HiddenTest {
  /** Repository-relative; where the file appears in the verification worktree. */
  path: string;
  content: string;
}

/** How long a step waits before retrying a `transient` failure. The total wait of a step is capped. */
export interface BackoffPolicy {
  /** The wait before the first transient retry, in milliseconds. Default 2000. */
  initialMs?: number;
  /** Each further transient retry waits this many times as long as the one before. Default 2. */
  factor?: number;
  /** No transient retry is made that would take the step's waits past this total, in milliseconds. Default 120000. */
  maxTotalMs?: number;
}

/** A step's retry budgets. What is spent of them is counted from the ledger, so a restart sees what is left. */
export interface RetryPolicy {
  /** Retries shared by `agent_error` and `verification_failed` failures. Default 2. */
  budget?: number;
  /** Retries of `transient` failures, a budget of its own. Default 5. */
  transientBudget?: number;
  backoff?: BackoffPolicy;
}

export interface StepDefinition {
  id: string;
  agent: AgentRef;
  verification: VerificationDefinition;
  /** Retry budgets; the defaults apply to whatever is left out. */
  retry?: RetryPolicy;
  /**
   * The coding agent that takes the step over, under the same contract, once the retry budget is spent. Off by
   * default: without it a step whose budget is spent fails. The alternative starts with budgets of its own, and a
   * step is rerouted at most once.
   */
  reroute?: AgentRef;
  /** What the step is to do, in the words the coding agent receives it in; carried in the handoff's contract. */
  instructions?: string;
  /**
   * Repository-relative paths of files this step hands to the next one. The next step's handoff references them
   * with the SHA-256 of their committed content in this step's snapshot. A path that is not a file there makes
   * that handoff unsatisfiable: the file may be one the step wrote or one already in the repository, but a file
   * git ignores is not in the snapshot.
   */
  artifacts?: string[];
}

export interface WorkflowDefinition {
  name: string;
  steps: StepDefinition[];
}

// ---------------------------------------------------------------------------
// Ledger events: one JSON object per line, in append order.

export interface TestOutputEvidence {
  kind: "test_output";
  command: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  /** True when `output` holds only the tail of a longer output. */
  truncated: boolean;
}

export interface RequiredOutputFieldsEvidence {
  kind: "required_output_fields";
  required: string[];
  /** The required fields the attempt did not report, or reported blank. */
  missing: string[];
}

/** How an attempt changed a path, from the step's base commit to the attempt's snapshot. */
export type PathChange = "added" | "modified" | "deleted";

export interface ChangedPath {
  path: string;
  change: PathChange;
}

/** What the attempt changed: the diff from the step's base commit to the snapshot. Recorded, never a verdict on its own. */
export interface DiffScopeEvidence {
  kind: "diff_scope";
  changed: ChangedPath[];
  /** True when `changed` lists only the first of more changed paths. */
  truncated: boolean;
}

/** Whether the attempt changed a protected path. Any violation fails verification. */
export interface ProtectedPathsEvidence {
  kind: "protected_paths";
  /** Every protected path: the declared ones and the hidden tests'. */
  protected: string[];
  /** The changed paths that are, contain or lie under a protected path. */
  violations: ChangedPath[];
  /** True when `violations` lists only the first of more. */
  truncated: boolean;
}

/** The parts of verification that can break before or while the validator runs. */
export type ValidatorStage = "diff_scope" | "verification_worktree" | "install" | "hidden_tests" | "command";

/**
 * AHP could not get the validator to run to a result, so it says nothing about the attempt: the verdict is
 * `inconclusive`, never `pass` or `fail`.
 */
export interface ValidatorErrorEvidence {
  kind: "validator_error";
  stage: ValidatorStage;
  message: string;
}

export type EvidenceItem =
  | TestOutputEvidence
  | RequiredOutputFieldsEvidence
  | DiffScopeEvidence
  | ProtectedPathsEvidence
  | ValidatorErrorEvidence;

/**
 * What a retry changes about the step's input: nothing (a new attempt under the same handoff revision), the
 * evidence of a failed verification (a new revision that carries it), or the coding agent (a reroute: a new
 * revision that names the alternative).
 */
export type RetryChange = "none" | "evidence" | "reroute";

export type LedgerEventBody =
  | {
      type: "run_created";
      runId: string;
      protocolVersion: string;
      workflow: WorkflowDefinition;
      repo: string;
      baseCommit: string;
    }
  | { type: "run_started" }
  | { type: "step_ready"; stepId: string }
  /** The full, immutable revision as issued to the recipient step. */
  | { type: "handoff_issued"; handoff: HandoffRevision }
  | { type: "handoff_accepted"; handoffId: string; revision: number }
  | { type: "handoff_rejected"; handoffId: string; revision: number; reasons: RejectionReason[] }
  | {
      type: "attempt_created";
      stepId: string;
      attemptId: string;
      /** The accepted handoff revision this attempt runs under; with `attemptId` it is the idempotency key. */
      handoffId: string;
      handoffRevision: number;
      adapter: string;
      /** From the adapter's declaration; mock results are never evidence. */
      mock: boolean;
      requestedModel: string | null;
      workspace: string;
    }
  | { type: "attempt_dispatching"; attemptId: string }
  | { type: "attempt_running"; attemptId: string; pid: number }
  | {
      type: "attempt_exited";
      attemptId: string;
      outcome: AttemptOutcome;
      exitCode: number | null;
      signal: string | null;
      /** What the coding agent claims to have produced. A claim, not a result: verification checks it. */
      reportedOutput: Record<string, OutputFieldValue>;
      /** Why the agent's turn ended, if its adapter says. Outcome detail, not proof that the process exited. */
      stopReason: StopReason | null;
      /** What the adapter saw go wrong, if anything; its class decides how the failure is handled. */
      error: AttemptError | null;
    }
  /** The failure class of an attempt that did not pass, recorded once its verdict (if it had one) is final. */
  | { type: "attempt_failed"; attemptId: string; failureClass: FailureClass }
  /**
   * The step will be tried again: recorded before any wait and before the next attempt (or the new handoff
   * revision) begins. Retry budgets are counted from these events.
   */
  | {
      type: "retry_scheduled";
      stepId: string;
      /** The failed attempt this retry follows. */
      attemptId: string;
      failureClass: FailureClass;
      change: RetryChange;
      /** The backoff before the next attempt, in milliseconds; 0 for everything but a transient failure. */
      delayMs: number;
    }
  | { type: "workspace_snapshot_committed"; attemptId: string; commit: string; ref: string }
  | {
      type: "verification_started";
      attemptId: string;
      verificationId: string;
      /** Null for a structural verification, which runs no command. */
      command: string | null;
      /** Null when no command runs, so no verification worktree is built. */
      worktree: string | null;
    }
  | {
      type: "verification_verdict";
      verificationId: string;
      verdict: Exclude<VerificationState, "pending">;
      evidence: EvidenceItem[];
    }
  | {
      type: "step_terminal";
      stepId: string;
      state: Extract<StepState, "succeeded" | "failed">;
      failureClass: FailureClass | null;
    }
  | { type: "run_terminal"; state: Extract<RunState, "succeeded" | "failed"> };

export type LedgerEventType = LedgerEventBody["type"];

/** A ledger event as written: the body plus its sequence number (from 1) and ISO timestamp. */
export type LedgerEvent = { seq: number; time: string } & LedgerEventBody;

// ---------------------------------------------------------------------------
// Derived state: produced only by replaying ledger events.

export interface VerificationView {
  id: string;
  state: VerificationState;
  /** Null for a structural verification, which runs no command. */
  command: string | null;
  worktree: string | null;
  evidence: EvidenceItem[];
}

export interface AttemptView {
  id: string;
  /** 1 for a step's first attempt. */
  number: number;
  state: AttemptState;
  /** The handoff revision this attempt runs under. */
  handoff: { id: string; revision: number };
  outcome: AttemptOutcome | null;
  exitCode: number | null;
  signal: string | null;
  /** The output fields the coding agent reported; empty until the attempt exits. */
  reportedOutput: Record<string, OutputFieldValue>;
  stopReason: StopReason | null;
  error: AttemptError | null;
  /** Set once the attempt is known to have failed; null while it runs and for an attempt that passed. */
  failureClass: FailureClass | null;
  pid: number | null;
  adapter: string;
  mock: boolean;
  requestedModel: string | null;
  /** What the coding agent reported; `unknown` until an adapter reports one. */
  reportedModel: string;
  workspace: string;
  snapshot: { commit: string; ref: string } | null;
  /** The verification that decided the attempt: the last one, or the only one. */
  verification: VerificationView | null;
  /** Inconclusive verifications that were re-run, oldest first. */
  earlierVerifications: VerificationView[];
}

export interface HandoffView {
  handoffId: string;
  revision: number;
  supersedes: number | null;
  state: HandoffState;
  /** The revision exactly as issued. */
  handoff: HandoffRevision;
  /** Set when the revision was rejected. */
  rejection: RejectionReason[] | null;
}

/**
 * What a step has spent of its retry budgets since it was last rerouted (a reroute starts the alternative agent
 * on budgets of its own). Counted by replaying `retry_scheduled` events, never kept anywhere else.
 */
export interface RetryUsage {
  /** Retries granted for `agent_error` and `verification_failed`, which share a budget. */
  retries: number;
  /** Retries granted for `transient` failures. */
  transientRetries: number;
  /** The backoff delays scheduled for those, in milliseconds. */
  transientWaitMs: number;
  /** True once the step was handed to its alternative agent; a step is rerouted at most once. */
  rerouted: boolean;
}

export interface StepView {
  id: string;
  state: StepState;
  failureClass: FailureClass | null;
  retryUsage: RetryUsage;
  /** True when any attempt of this step ran on the mock adapter. */
  mock: boolean;
  /** Every handoff revision issued to this step, in issue order. */
  handoffs: HandoffView[];
  attempts: AttemptView[];
}

export interface RunView {
  runId: string;
  protocolVersion: string;
  workflowName: string;
  state: RunState;
  repo: string;
  baseCommit: string;
  /** True when any attempt ran on the mock adapter: the run's results are not evidence. */
  mock: boolean;
  createdAt: string;
  endedAt: string | null;
  steps: StepView[];
}
