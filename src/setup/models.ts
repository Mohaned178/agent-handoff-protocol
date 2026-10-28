// The models `ahp setup` offers for a tool. Where the tool can list its own (`opencode models`), the list is the tool's;
// where it cannot, a short list AHP knows, which a login may not have every model of. Either way the first choice is the
// tool's own default (no model requested) and the last is a name typed in, so the list is never the limit.

import { tmpdir } from "node:os";
import { probe } from "../doctor/probe.ts";
import type { ToolId } from "../doctor/tools.ts";

export interface ModelChoice {
  /** The model a step requests, or null for the tool's own default. */
  value: string | null;
  label: string;
}

export interface ModelList {
  choices: ModelChoice[];
  /** Where the names came from, said beside the list. */
  source: string;
}

/**
 * Names AHP knows for the tools that cannot list their models. Claude Code takes aliases, which it resolves itself; the
 * Codex and Gemini names are ones this project's own runs used (2026-10), not a catalogue.
 */
export const KNOWN_MODELS: Record<Exclude<ToolId, "opencode">, readonly string[]> = {
  "claude-code": ["sonnet", "opus", "haiku"],
  codex: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna"],
  "gemini-cli": ["gemini-2.5-flash", "gemini-2.5-pro"],
};

/** The lines of `opencode models` that name a model: `provider/model`, one per line. */
export function openCodeModelsIn(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w.-]+\/[\w.:@-]+$/.test(line)))];
}

const DEFAULT: ModelChoice = { value: null, label: "the tool's own default (no model requested)" };

/** The models to offer for `tool`. `env` is the environment the tool is run with; nothing else is read. */
export async function modelsFor(tool: ToolId, env: NodeJS.ProcessEnv = process.env): Promise<ModelList> {
  if (tool !== "opencode") {
    const source = tool === "claude-code" ? "Claude Code's aliases" : "names this project's runs used; your login may not have each";
    return { choices: [DEFAULT, ...KNOWN_MODELS[tool].map((name) => ({ value: name, label: name }))], source };
  }
  const result = await probe("opencode", ["models"], { cwd: tmpdir(), env, timeoutMs: 30_000 });
  const names = result.outcome === "exited" && result.exitCode === 0 ? openCodeModelsIn(result.stdout) : [];
  // Free models first: a choice that costs nothing should not be the one that is hard to find.
  const sorted = [...names.filter((name) => /-free$/.test(name)), ...names.filter((name) => !/-free$/.test(name))];
  return {
    choices: [DEFAULT, ...sorted.map((name) => ({ value: name, label: /-free$/.test(name) ? `${name}  (free)` : name }))],
    source: names.length > 0 ? "`opencode models`" : "`opencode models` printed none: type a name, or use the default",
  };
}
