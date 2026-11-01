// What a scored request records. The answer's text is not kept (ticket 01): a verdict is audited from its outcome, a short detail
// (the first failing line of a test, the call that was made) and, for code, the SHA-256 of the code that was run.

import type { QualityOutcome } from "./quality.ts";
import type { ToolOutcome } from "./tools.ts";

export interface RequestScore {
  outcome: QualityOutcome | ToolOutcome;
  /** At most 300 characters; null when the outcome says it all. */
  detail: string | null;
  /** The SHA-256 of the code block that was run (`quality`); null for a tool call or when there was no code. */
  codeSha256: string | null;
}

/**
 * Scoring never throws. A harness failure (a temporary directory that cannot be made, `node` that cannot start) is not the
 * answer's fault and is no outcome: the request keeps no score, and the problem is recorded beside it.
 */
export type ScoreResult = { score: RequestScore; problem: null } | { score: null; problem: string };
