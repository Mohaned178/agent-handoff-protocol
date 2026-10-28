import type { Adapter } from "./contract.ts";
import { claudeCodeAdapter } from "./claude-code/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { geminiCliAdapter } from "./gemini-cli/index.ts";
import { mockAdapter } from "./mock/index.ts";
import { openCodeAdapter } from "./opencode/index.ts";

export type { Adapter, AdapterDeclaration, AttemptExit, AttemptInput, CancelOptions, StartedAttempt } from "./contract.ts";
export { mock, MOCK_USAGE_SOURCE, type MockAttemptScript, type MockEdit, type MockOptions, type MockUsage } from "./mock/index.ts";
export { claudeCode, claudeCodeAdapter, type ClaudeCodeOptions } from "./claude-code/index.ts";
export { codex, codexAdapter, type CodexOptions } from "./codex/index.ts";
export { geminiCli, geminiCliAdapter, type GeminiCliOptions } from "./gemini-cli/index.ts";
export { opencode, openCodeAdapter, type OpenCodeOptions } from "./opencode/index.ts";

/** The adapters a workflow step can name, by name. */
export const adapters: ReadonlyMap<string, Adapter> = new Map(
  [mockAdapter, claudeCodeAdapter, codexAdapter, openCodeAdapter, geminiCliAdapter].map((adapter) => [adapter.declaration.name, adapter] as const),
);
