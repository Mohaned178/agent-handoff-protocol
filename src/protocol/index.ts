// AHP protocol: workflow definitions, ledger events and the state derived from them.
// State names and failure classes are closed enumerations; adding a value is a protocol change.

export const PROTOCOL_VERSION = "0.1.0";

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

export interface VerificationDefinition {
  /** Run through the system shell in the verification worktree; exit code 0 is `pass`. */
  command: string;
}

export interface StepDefinition {
  id: string;
  agent: AgentRef;
  verification: VerificationDefinition;
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

export type EvidenceItem = TestOutputEvidence;

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
  | {
      type: "attempt_created";
      stepId: string;
      attemptId: string;
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
    }
  | { type: "workspace_snapshot_committed"; attemptId: string; commit: string; ref: string }
  | {
      type: "verification_started";
      attemptId: string;
      verificationId: string;
      command: string;
      worktree: string;
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
  command: string;
  worktree: string;
  evidence: EvidenceItem[];
}

export interface AttemptView {
  id: string;
  /** 1 for a step's first attempt. */
  number: number;
  state: AttemptState;
  outcome: AttemptOutcome | null;
  exitCode: number | null;
  signal: string | null;
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

export interface StepView {
  id: string;
  state: StepState;
  failureClass: FailureClass | null;
  /** True when any attempt of this step ran on the mock adapter. */
  mock: boolean;
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
