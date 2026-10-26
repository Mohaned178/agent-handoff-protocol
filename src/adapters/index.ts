import type { Adapter } from "./contract.ts";
import { mockAdapter } from "./mock/index.ts";

export type { Adapter, AdapterDeclaration, AttemptExit, AttemptInput, CancelOptions, StartedAttempt } from "./contract.ts";
export { mock, MOCK_USAGE_SOURCE, type MockAttemptScript, type MockEdit, type MockOptions, type MockUsage } from "./mock/index.ts";

/** The adapters a workflow step can name, by name. */
export const adapters: ReadonlyMap<string, Adapter> = new Map([[mockAdapter.declaration.name, mockAdapter]]);
