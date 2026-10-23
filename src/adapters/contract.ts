// The contract every adapter implements. The runtime drives coding agents only through it,
// so the core holds no provider-specific logic.

export interface AdapterDeclaration {
  name: string;
  /** A mock adapter's results are labelled as mock in all output and never count as evidence. */
  mock: boolean;
}

export interface AttemptInput {
  attemptId: string;
  /** 1 for a step's first attempt. */
  attemptNumber: number;
  /** The attempt's git worktree; the coding agent's working directory. */
  workspace: string;
  requestedModel: string | null;
  /** The step's adapter options, already accepted by `validateOptions`. */
  options: unknown;
}

export interface AttemptExit {
  exitCode: number | null;
  signal: string | null;
}

export interface StartedAttempt {
  pid: number;
  /** Settles once the process has terminated. */
  exited: Promise<AttemptExit>;
}

export interface Adapter {
  declaration: AdapterDeclaration;
  /** Returns one message per problem with `options`; empty when they are valid. */
  validateOptions(options: unknown): string[];
  /** Spawns exactly one fresh coding-agent process for the attempt; resolves once it has spawned. */
  startAttempt(input: AttemptInput): Promise<StartedAttempt>;
}
