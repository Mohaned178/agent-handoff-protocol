// The contract every adapter implements. The runtime drives coding agents only through it,
// so the core holds no provider-specific logic.

import type { AttemptError, HandoffRevision, OutputFieldValue, StopReason } from "../protocol/index.ts";
import type { Termination } from "../process/index.ts";

export interface AdapterDeclaration {
  name: string;
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
  /** The handoff revision the recipient accepted: the contract, context and artifacts for this attempt. */
  handoff: HandoffRevision;
  /** The step's adapter options, already accepted by `validateOptions`. */
  options: unknown;
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
