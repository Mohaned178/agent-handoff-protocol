// What the adapter hands `codex exec`: its sandbox mode, its approval policy and the rest of the command line. Codex's
// sandbox is one mode for the whole workspace (read-only, workspace-write, danger-full-access), so the only capability it
// can be asked to apply through the tool is `read_only`; a path scope and the shared refs are asked of the agent in words.

import type { AppliedCapabilities } from "../../protocol/index.ts";

export type CodexSandbox = "read-only" | "workspace-write";

/**
 * The sandbox mode for an attempt, from the levels recorded for it and nothing else. `read_only` recorded at any level but
 * `none` is `read-only`; with it absent or recorded `none` (the conformance suite's control run) nothing is held back, which is the
 * workspace-write mode. Never `danger-full-access` and never the flags that bypass the sandbox or the approvals: the
 * agent works in its worktree and not outside it.
 */
export function sandboxFor(applied: AppliedCapabilities): CodexSandbox {
  const readOnly = applied.capabilities.find((capability) => capability.kind === "read_only");
  return readOnly !== undefined && readOnly.level !== "none" ? "read-only" : "workspace-write";
}

export interface InvocationInput {
  applied: AppliedCapabilities;
  workspace: string;
  requestedModel: string | null;
  /** The file holding the JSON Schema of the output fields to report; null for none. */
  outputSchemaFile: string | null;
  effort: string | undefined;
  /** The system the agent runs on: Windows needs its sandbox named. */
  platform: string;
}

export function invocationFor(input: InvocationInput): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxFor(input.applied),
    // A command the sandbox does not allow is refused: nobody is there to approve it.
    "--config",
    'approval_policy="never"',
  ];
  // Without this Codex on native Windows has no sandbox and declines every command that is not a read, in the workspace
  // too (ticket 14 and ticket 16, observed). `elevated` needs a setup that asks the person for administrator rights.
  if (input.platform === "win32") args.push("--config", 'windows.sandbox="unelevated"');
  args.push(
    // The user's `config.toml` and execpolicy rules are left out, so an attempt behaves the same on every machine (the
    // login is not: it stays in `CODEX_HOME`). Skills and instructions kept elsewhere in the user's home still load.
    "--ignore-user-config",
    "--ignore-rules",
    "--cd",
    input.workspace,
  );
  if (input.requestedModel) args.push("--model", input.requestedModel);
  if (input.effort) args.push("--config", `model_reasoning_effort="${input.effort}"`);
  if (input.outputSchemaFile) args.push("--output-schema", input.outputSchemaFile);
  // The prompt is read from stdin.
  args.push("-");
  return args;
}
