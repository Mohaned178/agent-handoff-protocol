import { adapters } from "../adapters/index.ts";
import { currentPlatform, locateRepo, validateHandoffRevision, type HandoffValidation } from "../runtime/index.ts";

export interface ValidateHandoffOptions {
  /** Any directory inside the git repository the handoff's artifacts and base commit are read from. */
  repo: string;
  /** The operating system whose declared enforcement levels the capability requests are checked against, as Node's `process.platform` names it. Default: this one. */
  platform?: string;
}

/**
 * Validates a handoff revision the way a recipient does before any coding agent runs: the document must match
 * the schema, everything it requires must be there, every artifact must hash to what it states over its
 * committed content at the base commit, and the adapter it is for must be able to apply the capabilities and network
 * stance it requests, at the levels it requires, on this system. Resolves with the validated handoff, or with every
 * reason it is rejected, each carrying a closed `code`, a JSON Pointer into the document and a message.
 */
export async function validateHandoff(handoff: unknown, options: ValidateHandoffOptions): Promise<HandoffValidation> {
  const location = await locateRepo(options.repo);
  const named = (handoff as { to?: { adapter?: unknown } } | null)?.to?.adapter;
  const declaration = typeof named === "string" ? adapters.get(named)?.declaration : undefined;
  return validateHandoffRevision(handoff, location.repo, { declaration, platform: options.platform ?? currentPlatform() });
}

export type { HandoffValidation };
