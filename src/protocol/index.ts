// AHP protocol: workflow definitions, ledger events and the state derived from them.
// State names and failure classes are closed enumerations; adding a value is a protocol change.

import type { EnforcementLevel, NetworkStance, UsageReport } from "./capabilities.ts";
import type { CapabilityRequest, HandoffRevision, HandoffState, NetworkRequest, OutputFieldValue, PathChange, RejectionReason, ReviewVerdict } from "./handoff.ts";

export * from "./capabilities.ts";
export * from "./handoff.ts";
export * from "./review.ts";
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

/**
 * A step's state. An approval gate goes `blocked → ready → waiting_approval → succeeded | failed` and never
 * `in_progress` or `verifying`: it has no coding agent, so no attempt.
 */
export type StepState =
  | "blocked"
  | "ready"
  | "waiting_approval"
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

/** A verification's result once it is decided: `pending` is not a verdict. */
export type Verdict = Exclude<VerificationState, "pending">;

/**
 * Why an attempt, or the step it belongs to, failed; each class has its own handling (`docs/design`, §4). A
 * closed list: a new class is a protocol change.
 * - `rejected`: the handoff was rejected, so no attempt ran. Never retried.
 * - `config_auth`: the coding agent's login or configuration is wrong. Never retried; surfaced to the user.
 * - `transient`: a rate limit, a quota or a provider network problem. Retried with backoff, on a budget of its own.
 * - `agent_error`: the agent failed (non-zero exit, refusal, ran out of turns). Retried within the shared budget.
 * - `verification_failed`: verification failed. Retried with the evidence, within the shared budget.
 * - `inconclusive`: the validator could not run. Re-run once, then escalated; never counted.
 * - `unknown`: the attempt's outcome is not known. Never retried: the step's recovery policy, or a person, decides.
 * - `external_action_failed`: AHP could not perform an external-action step (a push refused, a pull request it could
 *   not open or merge), and checking again showed it not done. No attempt is involved. Never retried.
 */
export const FAILURE_CLASSES = [
  "rejected",
  "config_auth",
  "transient",
  "agent_error",
  "verification_failed",
  "inconclusive",
  "unknown",
  "external_action_failed",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Why a coding agent's turn ended, as its adapter normalizes it (the ACP stop reasons that matter for
 * classification). Outcome detail, never proof that the process exited. ACP's `cancelled` is not one: a cancel is
 * recorded as the attempt's `cancelled` outcome, once the runtime has seen the agent's processes gone.
 */
export const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Why an attempt's outcome is unknown: it was dispatched, and nothing records how it ended. A closed list.
 * - `no_terminal_record`: the runtime stopped while the attempt was dispatching or running, and a later process
 *   found it so.
 * - `lost_contact`: the adapter could not say whether or how the agent's process ended, as when its transport's
 *   connection dropped or its start failed partway.
 * - `unconfirmed_kill`: the runtime killed the agent to cancel the attempt and could not confirm that every process of
 *   its tree had gone.
 */
/**
 * What stopped a cancelled attempt's agent, as the process layer saw it end. A closed list.
 * - `transport`: the transport's own cancel (ACP `session/cancel`), for an adapter that declares one. Graceful.
 * - `signal`: SIGTERM to the agent's process group, on Linux and macOS. Graceful: the agent could clean up.
 * - `tree_kill`: the whole process tree killed (SIGKILL to the group, or `taskkill /T /F` on Windows). Forced.
 */
export const CANCEL_PATHS = ["transport", "signal", "tree_kill"] as const;
export type CancelPath = (typeof CANCEL_PATHS)[number];

/** How a cancelled attempt's agent was stopped, recorded once every process of its tree was seen gone. */
export interface AttemptCancel {
  /** True when it took a kill: the agent had no chance to stop by itself. */
  forced: boolean;
  via: CancelPath;
}

export const UNKNOWN_REASONS = ["no_terminal_record", "lost_contact", "unconfirmed_kill"] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/**
 * What is done with a step's attempt whose outcome is unknown, declared per step: `manual` (the default) stops the
 * run for a person to decide with `ahp recover`; `adopt` verifies the attempt's workspace as its result; `abort`
 * ends the step. Never a retry: whatever the attempt did may already have happened. `discard_and_retry` is
 * deferred past release 1.
 */
export const RECOVERY_POLICIES = ["manual", "adopt", "abort"] as const;
export type RecoveryPolicy = (typeof RECOVERY_POLICIES)[number];

/** A recovery decision: what `manual` leaves to a person, or what the step's policy says at once. */
export type RecoveryAction = Exclude<RecoveryPolicy, "manual">;
export const RECOVERY_ACTIONS = ["adopt", "abort"] as const satisfies readonly RecoveryAction[];

/** Who decided what becomes of an unknown attempt: a person through `ahp recover`, or the step's own policy. */
export const RECOVERY_DECIDERS = ["human", "step_policy"] as const;
export type RecoveryDecider = (typeof RECOVERY_DECIDERS)[number];

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
 * verification is structural, checking that the output is complete and nothing about its quality. A review step
 * (`StepDefinition.review`) already requires `verdict` and `findings`, so it may list nothing here.
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

/**
 * Makes a step a review. Besides what its verification lists, it must report a `verdict` (`approved` or
 * `changes_requested`) and its `findings`. When it requests changes, the step it names is sent back (ADR 0004).
 */
export interface ReviewDefinition {
  /** The step to send back: the step immediately before the review, which is the only one a send-back can reach. */
  sendBackTo: string;
}

/**
 * A capability a step asks its coding agent's adapter to apply, and the weakest enforcement level it will accept. An
 * adapter that cannot reach `require` on the running operating system gets the handoff rejected
 * (`capability_unsatisfiable`). Default `require`: `cooperative`, which asks the agent and stops nothing.
 */
export type CapabilityRequestDefinition =
  | { kind: "read_only"; require?: EnforcementLevel }
  | { kind: "write_scope"; paths: string[]; require?: EnforcementLevel }
  | { kind: "no_external_actions"; require?: EnforcementLevel };

/**
 * A step's network stance for its coding agent's own tool use (never its connection to its model provider). Default
 * `deny`, applied as far as the adapter can; `require` raises the bar, default `none`.
 */
export interface NetworkDefinition {
  stance: NetworkStance;
  require?: EnforcementLevel;
}

export interface StepDefinition {
  id: string;
  agent: AgentRef;
  /**
   * What the adapter is to apply to the coding agent. Every agent step also carries `no_external_actions` (ADR 0003),
   * at the level the adapter reaches, whether or not it is listed here. Each kind at most once.
   */
  capabilities?: CapabilityRequestDefinition[];
  /** Default: `{ stance: "deny" }`. An implement step opts in to package registries with `{ stance: "package_registries" }`. */
  network?: NetworkDefinition;
  verification: VerificationDefinition;
  /** Present on a review step. Without a `verification.command`, a review is verified structurally only. */
  review?: ReviewDefinition;
  /** Retry budgets; the defaults apply to whatever is left out. */
  retry?: RetryPolicy;
  /**
   * The coding agent that takes the step over, under the same contract, once the retry budget is spent. Off by
   * default: without it a step whose budget is spent fails. The alternative starts with budgets of its own, and a
   * step is rerouted at most once.
   */
  reroute?: AgentRef;
  /** What is done with an attempt whose outcome is unknown. Default `manual`: the run stops for a person to decide. */
  recovery?: RecoveryPolicy;
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

/** What a human may decide at an approval gate. There is no edit: the approver approves or sends work back. */
export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];

/**
 * Makes a step an approval gate: no coding agent, and nothing to verify. The run stops at it in `waiting_approval`
 * and its process exits; a person approves, which lets the run go on, or rejects with a reason, which sends back the
 * step immediately before it (ADR 0004), so that step must be an agent step. Takes no options yet.
 */
export type ApprovalDefinition = Record<string, never>;

export interface ApprovalGateDefinition {
  id: string;
  approval: ApprovalDefinition;
}

/**
 * The external actions AHP performs itself, after a passed verification and an approved gate (ADR 0003). A closed
 * list: a new kind is a protocol change. There is no deploy in release 1.
 */
export const EXTERNAL_ACTION_KINDS = ["push_branch", "open_pr", "merge_pr"] as const;
export type ExternalActionKind = (typeof EXTERNAL_ACTION_KINDS)[number];

/** How `merge_pr` merges: a merge commit, one squashed commit, or the commits rebased. */
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** The git remote an external action works on when it names none. */
export const DEFAULT_REMOTE = "origin";

/**
 * A branch name an external action may name: a stricter subset of what `git check-ref-format --branch` allows, so it
 * can be passed to git and the GitHub CLI as an argument and never read as an option or a revision expression.
 */
export function isBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value === "HEAD") return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.endsWith(".")) return false;
  return value.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.startsWith("-") && !part.endsWith(".lock") && !part.includes(".."));
}

/** A git remote's name, as an external action may name it: never read as an option. */
export const isRemoteName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);

/**
 * Pushes the approved commit, exactly as it was approved, to `refs/heads/<branch>` on the remote. Never forced: a
 * branch the push would not fast-forward fails the step.
 */
export interface PushBranchAction {
  kind: "push_branch";
  branch: string;
  /** A configured git remote. Default `origin`. */
  remote?: string;
}

/**
 * Opens a pull request from `branch` into `base`, both in the repository at the remote, with the GitHub CLI under
 * the user's own login. The branch must have been pushed by an earlier `push_branch` after the same gate.
 */
export interface OpenPullRequestAction {
  kind: "open_pr";
  branch: string;
  base: string;
  title: string;
  /** Default: a body naming the run, the approval and the commit. */
  body?: string;
  remote?: string;
}

/**
 * Merges the pull request from `branch`, only while its head is the approved commit. It must have been opened by an
 * earlier `open_pr` after the same gate.
 */
export interface MergePullRequestAction {
  kind: "merge_pr";
  branch: string;
  /** Default `merge`. */
  method?: MergeMethod;
  remote?: string;
}

export type ExternalActionDefinition = PushBranchAction | OpenPullRequestAction | MergePullRequestAction;

/**
 * A step AHP performs itself: no coding agent, nothing to verify. It follows an approval gate, with nothing but
 * other external actions between them, and publishes the commit that gate approved. Intent is recorded before
 * anything is done, and the remote is checked first, so a resumed run never performs it twice.
 */
export interface ExternalActionStepDefinition {
  id: string;
  action: ExternalActionDefinition;
}

/** A step of a workflow: one a coding agent performs, an approval gate, or an external action. */
export type WorkflowStepDefinition = StepDefinition | ApprovalGateDefinition | ExternalActionStepDefinition;

export const isApprovalGate = (step: WorkflowStepDefinition): step is ApprovalGateDefinition => "approval" in step;

export const isExternalAction = (step: WorkflowStepDefinition): step is ExternalActionStepDefinition => "action" in step;

/** A step a coding agent performs: neither an approval gate nor an external action. */
export const isAgentStep = (step: WorkflowStepDefinition): step is StepDefinition => !isApprovalGate(step) && !isExternalAction(step);

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStepDefinition[];
}

/** A requested capability and the enforcement level the adapter's declaration reaches for it. */
export type AppliedCapability = CapabilityRequest & { level: EnforcementLevel };

/** The network stance and the enforcement level the adapter's declaration reaches for it. */
export type AppliedNetwork = NetworkRequest & { level: EnforcementLevel };

/**
 * What an attempt's adapter was asked to apply, with the level its static declaration reaches for each on `platform`.
 * The levels are the declared ones, recorded before the agent starts; an adapter that cannot apply a capability fails
 * the attempt rather than apply it at a weaker level. They are never read from the tool afterwards.
 */
export interface AppliedCapabilities {
  /** The operating system the levels are for, as Node's `process.platform` names it. */
  platform: string;
  capabilities: AppliedCapability[];
  network: AppliedNetwork;
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

/**
 * The verdict a review step reported. `verdict` is null when what it reported (`reported`) is neither `approved` nor
 * `changes_requested`, which fails verification: a send-back must rest on a verdict that was understood. Recorded
 * only when the review reported a `verdict` at all; a missing one is the required output fields evidence's to report.
 */
export interface ReviewVerdictEvidence {
  kind: "review_verdict";
  verdict: ReviewVerdict | null;
  reported: OutputFieldValue;
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

/**
 * The parts of verification that can break before or while the validator runs; `runtime_stopped` when the runtime
 * stopped during the verification, so which part it had reached is not known.
 */
export type ValidatorStage = "diff_scope" | "verification_worktree" | "install" | "hidden_tests" | "command" | "runtime_stopped";

/**
 * AHP could not get the validator to run to a result, so it says nothing about the attempt: the verdict is
 * `inconclusive`, never `pass` or `fail`.
 */
export interface ValidatorErrorEvidence {
  kind: "validator_error";
  stage: ValidatorStage;
  message: string;
}

/**
 * The shared repository's refs changed while the attempt's agent ran: a branch, a tag, or a remote-tracking ref that
 * a push or a fetch moves. Only AHP performs external actions (ADR 0003), so this fails verification, and the
 * verification command is not run. AHP cannot tell who changed them: a person working in the repository, or an
 * editor fetching, meanwhile shows the same. Detection is partial, so an attempt without this evidence is not proven
 * to have performed none: a push to a URL, or through a service's API, leaves no local ref behind.
 */
export interface ForbiddenExternalActionEvidence {
  kind: "forbidden_external_action_detected";
  /** The shared refs that differ between the snapshots taken before the agent was dispatched and after it ended. */
  changed: RefChange[];
  /** True when `changed` lists only the first of more. */
  truncated: boolean;
}

export type EvidenceItem =
  | TestOutputEvidence
  | RequiredOutputFieldsEvidence
  | ReviewVerdictEvidence
  | DiffScopeEvidence
  | ProtectedPathsEvidence
  | ForbiddenExternalActionEvidence
  | ValidatorErrorEvidence;

/**
 * An external action as AHP set out to perform it, recorded before anything is done: the step's action with its
 * defaults filled in, the approval gate it follows, and the commit that gate approved, which is what it publishes.
 */
export type ExternalActionTarget = (
  | { kind: "push_branch"; branch: string }
  | { kind: "open_pr"; branch: string; base: string; title: string; body: string }
  | { kind: "merge_pr"; branch: string; method: MergeMethod }
) & { remote: string; gateStepId: string; commit: string };

export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** A pull request as its host reported it. */
export interface PullRequestRecord {
  number: number;
  url: string;
  state: PullRequestState;
  /** The commit at the head of its branch. */
  headCommit: string;
  /** The branch it merges into. */
  base: string;
}

/** What AHP saw of the remote when it checked an external action, or once it had performed it. */
export type ExternalObservation =
  /** The commit the remote's branch points at; null when it has no such branch. */
  | { kind: "remote_branch"; commit: string | null }
  /** The pull request from the branch that decides the action; null when there is none. */
  | { kind: "pull_request"; pullRequest: PullRequestRecord | null };

/** The process that holds a run's ledger lock, and so is the one process writing the run. */
export interface LockOwner {
  host: string;
  pid: number;
  /** When the process started (ISO). With the PID it tells the owner apart from a later process given the same PID. */
  startedAt: string;
}

/**
 * A ref of the shared repository (branches, tags, remote-tracking refs, the stash: everything under `refs/` but
 * AHP's own `refs/ahp/`) and the object it points at.
 */
export interface SharedRef {
  name: string;
  oid: string;
}

/** When an attempt's shared refs are recorded: just before its agent is dispatched, and once it has exited. */
export const REF_SNAPSHOT_PHASES = ["before", "after"] as const;
export type RefSnapshotPhase = (typeof REF_SNAPSHOT_PHASES)[number];

/** A shared ref that differs between two snapshots of the refs: null on the side where it did not exist. */
export interface RefChange {
  name: string;
  before: string | null;
  after: string | null;
}

/**
 * One line of a transport's tool-call log: what the coding agent's tool said about a tool call, or that AHP answered a
 * permission request for it. Metadata only, never the call's input or output.
 */
export interface ToolCallLogEntry {
  time: string;
  toolCallId: string;
  /** The tool's own kind for the call (ACP: `read`, `edit`, `execute`, ...). */
  kind: string | null;
  /** The tool's title for the call; for a shell command, the command. Cut short. */
  title: string | null;
  /** The call's status as the tool last reported it (`pending`, `in_progress`, `completed`, `failed`). */
  status: string | null;
  paths: string[];
  /** What AHP answered when the tool asked permission for the call; null when it did not ask. */
  permission: "allowed" | "rejected" | null;
}

/** The last of a transport's tool-call log entries, oldest first. */
export interface ToolCallLog {
  entries: ToolCallLogEntry[];
  /** True when earlier entries were left out. */
  truncated: boolean;
}

/**
 * What is known about an attempt whose outcome is unknown, for the person or policy that decides what becomes of
 * it. Everything in it was read when it was written; nothing in it says what the agent did beyond the workspace
 * and the shared repository's refs.
 */
export interface RecoveryReport {
  /** The last events recorded before the attempt was found unknown, oldest first. */
  lastEvents: { seq: number; time: string; type: LedgerEventType }[];
  workspace: {
    path: string;
    /** False when the workspace is gone, so there is no result to adopt. */
    exists: boolean;
    /** What differs between the step's base commit and the workspace as it was, untracked files included. */
    changed: ChangedPath[];
    /** True when `changed` lists only the first of more. */
    truncated: boolean;
    /** Why the workspace could not be read, if it could not. */
    error: string | null;
  };
  refs: {
    /**
     * The shared refs that differ between the snapshot taken just before the attempt was dispatched and the one
     * taken when it was found unknown.
     */
    changed: RefChange[];
    truncated: boolean;
    /** Why the refs could not be compared: a snapshot is missing. */
    error: string | null;
  };
  /** The transport's log of the agent's tool calls; null when the attempt's adapter kept none. */
  toolCallLog: ToolCallLog | null;
  /** The statement that host and external effects are undetermined, always present. */
  undetermined: string;
}

/**
 * What a retry changes about the step's input: nothing (a new attempt under the same handoff revision), the
 * evidence of a failed verification (a new revision that carries it), or the coding agent (a reroute: a new
 * revision that names the alternative).
 */
export const RETRY_CHANGES = ["none", "evidence", "reroute"] as const;
export type RetryChange = (typeof RETRY_CHANGES)[number];

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
      /** What the runtime asked the adapter to apply, and the level its declaration reaches for it on this system. */
      capabilities: AppliedCapabilities;
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
      /** The model the tool said it ran; null when it did not say. Never the requested one. */
      reportedModel: string | null;
      /** What the tool reported using, with its source; null when it reported none. Never estimated. */
      usage: UsageReport | null;
      /**
       * How the agent was stopped, for the `cancelled` outcome only; null otherwise. An attempt that was being cancelled
       * and had ended by itself before anything was sent to it exits with its own outcome.
       */
      cancel: AttemptCancel | null;
    }
  /**
   * The run is to stop: someone pressed Ctrl+C or the SDK's signal was aborted. Recorded before anything is stopped;
   * from here no agent is dispatched, and the run ends `cancelled` unless its last step had already succeeded.
   */
  | { type: "run_cancel_requested" }
  /** The runtime is about to stop the attempt's agent: recorded before anything is sent to its processes. */
  | { type: "attempt_cancelling"; attemptId: string }
  /**
   * The attempt was dispatched and how it ended is not known. It is never retried automatically: its step needs
   * recovery, decided by the step's policy or by a person.
   */
  | { type: "attempt_unknown"; attemptId: string; reason: UnknownReason; detail: string }
  | { type: "recovery_report_written"; attemptId: string; report: RecoveryReport }
  /** The step's policy is `manual`, so the run stops here for a person to decide with `ahp recover`. */
  | { type: "recovery_awaited"; attemptId: string }
  | {
      type: "recovery_decided";
      attemptId: string;
      policy: RecoveryAction;
      decidedBy: RecoveryDecider;
      /** The name of the user who decided; null for the step's policy. */
      user: string | null;
    }
  /** The failure class of an attempt that did not pass, recorded once its verdict (if it had one) is final. */
  | { type: "attempt_failed"; attemptId: string; failureClass: FailureClass }
  /**
   * A review step asked for changes: the step before it (`stepId`), which had succeeded, goes back to `ready` for a
   * new attempt under a new handoff revision carrying the review's findings, and spends one retry of its budget
   * (ADR 0004). The review step goes back to `blocked`, to review the new result when there is one. Recorded before
   * the revision or the attempt begins; the findings are those the review attempt reported, which replay reads.
   */
  | { type: "step_sent_back"; stepId: string; attemptId: string; reviewStepId: string; reviewAttemptId: string }
  /**
   * The run reached an approval gate: the step before it (`attemptId`'s) succeeded, and the run stops in
   * `waiting_approval` for a person. The request binds the decision to what was verified: the attempt, its snapshot
   * `commit`, and the paths that differ between the run's `base` commit (what a later push would publish against) and
   * that commit. A decision applies to this commit and no other.
   */
  | {
      type: "approval_requested";
      stepId: string;
      attemptId: string;
      base: string;
      commit: string;
      changed: ChangedPath[];
      /** True when `changed` lists only the first of more. */
      truncated: boolean;
    }
  /**
   * A person decided the gate's open request, after taking the ledger lock. A rejection carries the reason, which
   * reaches the coding agent as evidence; an approval carries none. `user` is the name the operating system gives
   * the person; the time is the event's.
   */
  | { type: "approval_decided"; stepId: string; decision: ApprovalDecisionKind; reason: string | null; user: string }
  /**
   * The gate's rejection sends the step before it (`stepId`, whose last attempt `attemptId` was the one put to the
   * approver) back, as a review's changes requested would: the step goes back to `ready` for a new attempt under a
   * new handoff revision carrying the reason, spends one retry of its budget (ADR 0004), and the gate goes back to
   * `blocked`. Recorded before the revision or the attempt begins; the reason is the decision's, which replay reads.
   */
  | { type: "approval_sent_back"; stepId: string; attemptId: string; gateStepId: string }
  /**
   * AHP is about to perform an external-action step: recorded before the remote is looked at or anything is done, so a
   * process that stops from here on leaves a record, and the process that resumes the run checks before it acts.
   */
  | { type: "external_action_intended"; stepId: string; target: ExternalActionTarget }
  /**
   * What the remote showed when AHP looked: `done` when the action is already performed there, which is then recorded
   * and not repeated. Recorded before every attempt to perform it.
   */
  | { type: "external_action_checked"; stepId: string; done: boolean; observed: ExternalObservation }
  /** AHP performed the action, after a check that found it not done. */
  | { type: "external_action_performed"; stepId: string; observed: ExternalObservation }
  /** AHP could not check or perform the action, and a check after the failure did not find it done. */
  | { type: "external_action_failed"; stepId: string; error: string }
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
  /**
   * The shared repository's refs, recorded just before the attempt's agent is dispatched and again once it has
   * exited or been found unknown, so a change an agent made to them (a branch, a fetch, a push that moved a
   * remote-tracking ref) shows.
   */
  | { type: "ref_snapshot_taken"; attemptId: string; phase: RefSnapshotPhase; refs: SharedRef[] }
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
      verdict: Verdict;
      evidence: EvidenceItem[];
    }
  | {
      type: "step_terminal";
      stepId: string;
      state: Extract<StepState, "succeeded" | "failed" | "cancelled">;
      failureClass: FailureClass | null;
    }
  | { type: "run_terminal"; state: Extract<RunState, "succeeded" | "failed" | "cancelled"> }
  /**
   * A process opened the unfinished run to continue it: after its process stopped, or to apply a person's decision.
   * `takenOverFrom` names the process whose stale lock it removed to do so, if it did.
   */
  | { type: "run_resumed"; takenOverFrom: LockOwner | null }
  /**
   * The process that opened the ledger to write it found a torn tail, a last line that a write did not finish
   * (no newline, or not JSON), and truncated it. The line was never recorded, so nothing it said happened.
   */
  | { type: "ledger_truncated"; droppedBytes: number };

export type LedgerEventType = LedgerEventBody["type"];

/**
 * A ledger event as written: the body plus its sequence number (from 1), the previous event's hash (null for the
 * first), its ISO timestamp, and its own hash: SHA-256 (lowercase hex) over the canonical JSON of everything
 * else in the event, keys sorted and no whitespace. The hashes chain the events, so an event changed, reordered or
 * missing anywhere but at the end shows. Events lost from the end leave a valid chain: nothing records its length.
 */
export type LedgerEvent = { seq: number; prevHash: string | null; time: string; hash: string } & LedgerEventBody;

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
  /** What the tool reported using, labelled with its source; null until the attempt exits, and for good when it reported none. */
  usage: UsageReport | null;
  /** What was asked of the adapter and the level its declaration reaches for it; null for an attempt recorded before capabilities existed. */
  capabilities: AppliedCapabilities | null;
  workspace: string;
  /** The shared repository's refs just before the agent was dispatched and once it had exited; null until recorded. */
  refs: Record<RefSnapshotPhase, SharedRef[] | null>;
  snapshot: { commit: string; ref: string } | null;
  /** The verification that decided the attempt: the last one, or the only one. */
  verification: VerificationView | null;
  /** Inconclusive verifications that were re-run, oldest first. */
  earlierVerifications: VerificationView[];
  /**
   * The retry scheduled after this attempt failed, or after a review sent the step back (`sentBack`), if one was:
   * what it changes, and the wait it starts with.
   */
  retry: ScheduledRetry | null;
  /** Set when a review asked for changes to this attempt's result, which passed verification. */
  sentBack: SentBack | null;
  /** Set once the attempt's outcome is unknown: why, its report, and what was decided. */
  recovery: AttemptRecovery | null;
  /** Set once the runtime set out to stop the attempt's agent: when, and how it was stopped once that is confirmed. */
  cancellation: AttemptCancellation | null;
}

export interface AttemptCancellation {
  /** When the runtime recorded that it was stopping the agent (ISO). */
  requestedAt: string;
  /**
   * How the agent was stopped, once its processes were seen gone. Null while it is being stopped, and for good when
   * they never were seen gone (the attempt is unknown) or when it had ended by itself before anything was sent to it
   * (it exited with its own outcome).
   */
  result: AttemptCancel | null;
}

export interface AttemptRecovery {
  reason: UnknownReason;
  /** What was observed, in words. */
  detail: string;
  report: RecoveryReport | null;
  /** True once the run stopped for a person to decide. */
  awaited: boolean;
  decision: RecoveryDecision | null;
}

export interface RecoveryDecision {
  policy: RecoveryAction;
  decidedBy: RecoveryDecider;
  user: string | null;
  time: string;
}

/** A send-back, as the review step's attempt reported it. */
export interface ReviewSentBack {
  kind: "review";
  reviewStepId: string;
  reviewAttemptId: string;
  /** What the review found, in its words. */
  findings: string[];
}

/** A send-back by a person who rejected the attempt's result at an approval gate. */
export interface ApprovalSentBack {
  kind: "approval";
  gateStepId: string;
  /** The reason the approver gave, in their words. */
  reason: string;
  user: string;
  /** When the rejection was decided (ISO). */
  decidedAt: string;
}

export type SentBack = ReviewSentBack | ApprovalSentBack;

/** A person's decision at an approval gate, as its `approval_decided` event records it. */
export interface ApprovalDecision {
  decision: ApprovalDecisionKind;
  reason: string | null;
  user: string;
  time: string;
}

/** One request for approval of a gate: what was put to the approver, and what they decided once they did. */
export interface ApprovalView {
  /** The verified attempt of the step before the gate. */
  attemptId: string;
  /** When the run stopped for approval (ISO). */
  requestedAt: string;
  /** The run's base commit, and the attempt's snapshot commit: the diff approved is between them. */
  base: string;
  commit: string;
  changed: ChangedPath[];
  truncated: boolean;
  decision: ApprovalDecision | null;
}

/**
 * What a step is: one a coding agent performs, a review (an agent step that can send the one before it back), an
 * approval gate, or an external action AHP performs.
 */
export type StepKind = "agent" | "review" | "approval_gate" | "external_action";

/** An external-action step's record: what AHP set out to do, each look at the remote, and how it ended. */
export interface ExternalActionView {
  target: ExternalActionTarget;
  intendedAt: string;
  /** Every check of the remote, oldest first. */
  checks: { time: string; done: boolean; observed: ExternalObservation }[];
  performed: { time: string; observed: ExternalObservation } | null;
  failure: { time: string; error: string } | null;
}

/** Whether the action is done: AHP performed it, or the last check found it already performed. */
export const isExternalActionDone = (action: ExternalActionView) => action.performed !== null || action.checks.at(-1)?.done === true;

export interface ScheduledRetry {
  change: RetryChange;
  delayMs: number;
  /** When the retry was scheduled (ISO): its wait runs from here. */
  scheduledAt: string;
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
  kind: StepKind;
  state: StepState;
  failureClass: FailureClass | null;
  retryUsage: RetryUsage;
  /** True when any attempt of this step ran on the mock adapter. */
  mock: boolean;
  /** Every handoff revision issued to this step, in issue order. */
  handoffs: HandoffView[];
  attempts: AttemptView[];
  /** The requests for approval of an approval gate, in order; empty for any other step. */
  approvals: ApprovalView[];
  /** An external-action step's record once its intent is recorded; null before that, and for any other step. */
  action: ExternalActionView | null;
}

/** A torn tail truncated from the ledger, as its `ledger_truncated` event records it. */
export interface LedgerTruncation {
  /** The `ledger_truncated` event's sequence number: the torn line came after the event before it. */
  seq: number;
  time: string;
  droppedBytes: number;
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
  /** Torn tails truncated from the ledger, oldest first. */
  ledgerTruncations: LedgerTruncation[];
  /** Each time a later process continued the run, oldest first. */
  resumptions: RunResumption[];
  /** When cancelling the run was recorded (ISO); null unless it was. */
  cancelRequestedAt: string | null;
}

/** A process continuing a run, as its `run_resumed` event records it. */
export interface RunResumption {
  seq: number;
  time: string;
  /** The process whose stale lock was removed so the run could continue, if one was. */
  takenOverFrom: LockOwner | null;
}
