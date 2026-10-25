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

export type FailureClass =
  | "rejected"
  | "config_auth"
  | "transient"
  | "agent_error"
  | "verification_failed"
  | "inconclusive"
  | "unknown";

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
}

export interface StepDefinition {
  id: string;
  agent: AgentRef;
  verification: VerificationDefinition;
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

export type EvidenceItem = TestOutputEvidence | RequiredOutputFieldsEvidence;

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
  pid: number | null;
  adapter: string;
  mock: boolean;
  requestedModel: string | null;
  /** What the coding agent reported; `unknown` until an adapter reports one. */
  reportedModel: string;
  workspace: string;
  snapshot: { commit: string; ref: string } | null;
  verification: VerificationView | null;
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

export interface StepView {
  id: string;
  state: StepState;
  failureClass: FailureClass | null;
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
