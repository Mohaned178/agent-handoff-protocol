// What the adapter hands `claude`: its tool set, its permission rules, the settings file with the `PreToolUse` hook, and
// the policy file the hook reads. The rules and the hook guard Claude Code's own tool calls, not what a shell command
// reaches another way (observed on native Windows, ticket 14, F3), which is why the capabilities are `cooperative`.

import { writeFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppliedCapabilities, CapabilityRequest } from "../../protocol/index.ts";
import { WRITE_TOOLS, type HookPolicy } from "./hook.ts";

/** Runs as `.ts` from source and as `.js` once built. */
const hookScript = fileURLToPath(new URL(`./hook${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/**
 * The tools an agent is given. Named one by one rather than left to Claude Code's default set, which also holds tools
 * that schedule jobs, message people and start subagents. No PowerShell tool: `Bash` is the one shell, so the rules over
 * it cover every way in. The network stance does not change this list (see the declaration: it applies nothing).
 */
export const BASE_TOOLS = ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

/** Deny rules for a step that must change no shared ref. Exact command prefixes only: `git branch` and `git tag` also list, so they are not here. */
const NO_EXTERNAL_ACTIONS_DENY = ["Bash(git push:*)", "Bash(git update-ref:*)", "Bash(gh:*)"];

const requestOf = (applied: AppliedCapabilities, kind: CapabilityRequest["kind"]) => applied.capabilities.find((capability) => capability.kind === kind);

/** Forward slashes and double quotes: the shell Claude Code runs a hook in reads backslashes as escapes. */
const quoted = (path: string) => `"${path.replaceAll("\\", "/")}"`;

export interface ClaudeInvocation {
  args: string[];
  /** The settings file's content, written where `--settings` points. */
  settings: object;
  /** The hook's policy file content. */
  policy: HookPolicy;
}

export interface InvocationInput {
  applied: AppliedCapabilities;
  workspace: string;
  requestedModel: string | null;
  /** The JSON Schema of the output fields to report; null for none. */
  outputSchema: object | null;
  settingsFile: string;
  policyFile: string;
  effort: string | undefined;
  maxBudgetUsd: number | undefined;
}

export function invocationFor(input: InvocationInput): ClaudeInvocation {
  const { applied } = input;
  const readOnly = requestOf(applied, "read_only") !== undefined;
  const scope = requestOf(applied, "write_scope");
  const tools: string[] = BASE_TOOLS.filter((tool) => !(readOnly && (WRITE_TOOLS as readonly string[]).includes(tool)));
  const deny = [...(readOnly ? WRITE_TOOLS : []), ...(requestOf(applied, "no_external_actions") ? NO_EXTERNAL_ACTIONS_DENY : [])];
  const policy: HookPolicy = { workspace: input.workspace, readOnly, writeScope: scope?.kind === "write_scope" ? scope.paths : null };
  const hookCommand = `${quoted(process.execPath)} ${quoted(hookScript)} ${quoted(input.policyFile)}`;
  const settings = {
    permissions: { allow: tools, deny },
    // Registered for every attempt: Claude Code's file tools write anywhere an allow rule reaches (observed), so the
    // hook also keeps them inside the workspace.
    hooks: { PreToolUse: [{ matcher: WRITE_TOOLS.join("|"), hooks: [{ type: "command", command: hookCommand }] }] },
  };
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // A call no rule allows is denied: nobody is there to answer a prompt.
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
    "--settings",
    input.settingsFile,
    // The user's and the repository's local settings are left out, so an attempt behaves the same on every machine.
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (input.requestedModel) args.push("--model", input.requestedModel);
  if (input.effort) args.push("--effort", input.effort);
  if (input.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  if (input.outputSchema) args.push("--json-schema", JSON.stringify(input.outputSchema));
  return { args, settings, policy };
}

export function writeInvocationFiles(invocation: ClaudeInvocation, settingsFile: string, policyFile: string): void {
  writeFileSync(settingsFile, JSON.stringify(invocation.settings, null, 2));
  writeFileSync(policyFile, JSON.stringify(invocation.policy, null, 2));
}
