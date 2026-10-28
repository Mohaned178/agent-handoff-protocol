// The contract every adapter implements. The runtime drives coding agents only through it,
// so the core holds no provider-specific logic.

import type {
  AppliedCapabilities,
  AttemptError,
  CapabilityKind,
  HandoffRevision,
  LevelsByOs,
  LoginKind,
  ModelReportingLevel,
  NetworkStance,
  OutputFieldValue,
  StopReason,
  TransportKind,
  UsageReport,
} from "../protocol/index.ts";
import type { Termination } from "../process/index.ts";

/**
 * What an adapter says about itself, statically: the same on every run, so the runtime can check a handoff against it
 * before any agent starts. An adapter states a level for every capability, stance and operating system, so none is left
 * out by accident; `none` says it cannot apply it there. The levels are claims about the adapter's tool, which the
 * conformance suite checks (`src/conformance`), and which only `enforced_by_tool` may call enforcement: a prompt instruction or
 * an ACP permission request the agent may ignore is `cooperative`.
 */
export interface AdapterDeclaration {
  name: string;
  /** How the adapter drives its coding agent (ADR 0001). */
  transport: TransportKind;
  /** How much the adapter can say about the tool's model: the models it lists, a name it passes on, or nothing. */
  modelReporting: ModelReportingLevel;
  /** The login the tool needs; AHP stores none. */
  login: LoginKind;
  /** The level at which the adapter applies each capability, per operating system. */
  capabilities: Record<CapabilityKind, LevelsByOs>;
  /** The level at which the adapter applies each network stance to the agent's tool use, per operating system. */
  network: Record<NetworkStance, LevelsByOs>;
  /** A mock adapter's results are labelled as mock in all output and never count as evidence. */
  mock: boolean;
  /**
   * True when the adapter's transport has a cancel of its own (ACP `session/cancel`), which `cancel` tries before
   * anything is sent to the agent's processes. False: a cancel is SIGTERM to the agent's process group, then a kill of
   * the tree, on Linux and macOS, and a forced kill of the tree on Windows.
   */
  gracefulCancel: boolean;
}

export interface AttemptInput {
  attemptId: string;
  /** 1 for a step's first attempt, counting every attempt of the step, whichever coding agent made it. */
  attemptNumber: number;
  /** The attempt's git worktree; the coding agent's working directory. */
  workspace: string;
  requestedModel: string | null;
  /**
   * What the runtime asks the adapter to apply, and the level its declaration reaches for each on this system: at least
   * what each request requires. The adapter applies them through its tool, and fails the attempt (by throwing from
   * `startAttempt`) rather than apply one at a weaker level than the one recorded.
   */
  capabilities: AppliedCapabilities;
  /** The handoff revision the recipient accepted: the contract, context and artifacts for this attempt. */
  handoff: HandoffRevision;
  /** The step's adapter options, already accepted by `validateOptions`. */
  options: unknown;
  /**
   * An absolute path the runtime owns, outside the workspace, where an adapter whose transport reports tool calls
   * appends one JSON line (`ToolCallLogEntry`) for each as it happens. The runtime reads it into the recovery report of
   * an attempt whose outcome is unknown, which no adapter's `exited` ever reaches, so it must be written during the
   * attempt, not at its end. Metadata only. An adapter with nothing to log leaves it alone, and one that is not given a path (a caller that keeps no report) logs nothing.
   */
  toolCallLog?: string;
}

export interface AttemptExit {
  exitCode: number | null;
  signal: string | null;
  /**
   * The output fields the coding agent reported (for example `summary`, `decisions`, `constraints`), by name.
   * The adapter normalizes whatever its tool produces into this shape; the runtime verifies the claim.
   */
  reportedOutput: Record<string, OutputFieldValue>;
  /** Why the agent's turn ended, when the tool says (an ACP stop reason, normalized); null when it does not. */
  stopReason: StopReason | null;
  /**
   * What the adapter observed go wrong, with the class it belongs to: a login problem is `config_auth`, a rate
   * limit or quota is `transient`. Null when it saw nothing; a non-zero exit is then an agent error.
   */
  error: AttemptError | null;
  /**
   * The model the tool said it ran, as it said it; null when it did not say, which the runtime records as `unknown`.
   * Never the requested model.
   */
  reportedModel: string | null;
  /**
   * What the tool reported using for the attempt, with the source of the numbers; null when it reported none. Never
   * estimated from output, time or anything else.
   */
  usage: UsageReport | null;
}

export interface CancelOptions {
  /** How long a graceful stop is given before the process tree is killed. */
  graceMs: number;
}

export interface StartedAttempt {
  pid: number;
  /** Settles once the process has terminated. */
  exited: Promise<AttemptExit>;
  /**
   * Stops the agent and every process it started, through the shared process layer (with the transport's own cancel
   * first, if `gracefulCancel`), and says whether every process was seen gone, and how they were stopped.
   */
  cancel(options: CancelOptions): Promise<Termination>;
}

export interface Adapter {
  declaration: AdapterDeclaration;
  /** Returns one message per problem with `options`; empty when they are valid. */
  validateOptions(options: unknown): string[];
  /**
   * Spawns exactly one fresh coding-agent process for the attempt, through the shared process layer (`src/process`);
   * resolves once it has spawned.
   */
  startAttempt(input: AttemptInput): Promise<StartedAttempt>;
}
