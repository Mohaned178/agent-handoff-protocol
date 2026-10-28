// What AHP asks of OpenCode for the capabilities a step lists, and how it answers OpenCode's own permission requests. All
// of it is `cooperative` and none of it is enforcement: OpenCode's permission rules guard OpenCode's own tool calls, an
// ACP `session/request_permission` is a question the client may answer either way, and an agent with a shell reaches
// files and refs around both (observed for Claude Code on Windows, ticket 14, F3; not tested for OpenCode).

import { isAbsolute, relative, resolve } from "node:path";
import type { AppliedCapabilities } from "../../protocol/index.ts";

/** The commands that move a shared ref or open a pull request. Matched at the start of a shell command; `git branch` and `git tag` also list, so they are not here. */
const EXTERNAL_ACTION_COMMANDS = ["git push", "git update-ref", "gh"] as const;

export interface PermissionPolicy {
  workspace: string;
  /** No file may change. */
  readOnly: boolean;
  /** Repository-relative paths files may change under; null for any. */
  writeScope: string[] | null;
  /** No push, pull request or shared ref change. */
  noExternalActions: boolean;
}

export function policyOf(applied: AppliedCapabilities, workspace: string): PermissionPolicy {
  const scope = applied.capabilities.find((capability) => capability.kind === "write_scope");
  return {
    workspace,
    readOnly: applied.capabilities.some((capability) => capability.kind === "read_only"),
    writeScope: scope?.kind === "write_scope" ? scope.paths : null,
    noExternalActions: applied.capabilities.some((capability) => capability.kind === "no_external_actions"),
  };
}

/**
 * The `permission` rules OpenCode is started with, as its inline config (`OPENCODE_CONFIG_CONTENT`, which no file in the
 * worktree can weaken). `edit: deny` is OpenCode's own rule; `edit: ask` hands each write to the client, which answers
 * by path (`decide`); the shell patterns are deny rules for the commands that act outside the workspace.
 */
export function configContentOf(policy: PermissionPolicy): string {
  const permission: Record<string, unknown> = {};
  // `ask` for every step that may write: AHP's answer is what keeps a write out of `.git` and out of the workspace's parent.
  permission.edit = policy.readOnly ? "deny" : "ask";
  if (policy.noExternalActions) {
    permission.bash = Object.fromEntries(EXTERNAL_ACTION_COMMANDS.map((command) => [command === "gh" ? "gh *" : `${command}*`, "deny"]));
  }
  return JSON.stringify({ permission });
}

/** What OpenCode told the client about a tool call it wants to make. */
export interface ToolCallRequest {
  kind: string | null;
  title: string | null;
  paths: string[];
  command: string | null;
}

export type Decision = { allow: true } | { allow: false; reason: string };

const WRITING = ["edit", "delete", "move"];

const onWindows = process.platform === "win32";
const comparable = (path: string) => (onWindows ? path.toLowerCase() : path);

/** The path relative to `base` with forward slashes, or null when it is not under `base`. */
function under(base: string, path: string): string | null {
  const from = comparable(resolve(base));
  const to = comparable(resolve(base, path));
  const rel = relative(from, to);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replaceAll("\\", "/");
}

const trimmed = (path: string) => comparable(path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""));

/** Answers a permission request by the policy: a tool call outside the workspace, a write the capabilities forbid, or a command that acts outside it is rejected, anything else allowed once. */
export function decide(policy: PermissionPolicy, call: ToolCallRequest): Decision {
  const relatives: string[] = [];
  for (const path of call.paths) {
    const rel = under(policy.workspace, path);
    if (rel === null) return { allow: false, reason: `${path} is outside the workspace` };
    relatives.push(rel);
  }
  const writing = call.kind !== null && WRITING.includes(call.kind);
  if (writing) {
    if (relatives.some((rel) => rel === ".git" || rel.startsWith(".git/"))) return { allow: false, reason: "a step does not write into .git" };
    if (policy.readOnly) return { allow: false, reason: "this step is read-only" };
    if (policy.writeScope !== null) {
      const scope = policy.writeScope.map(trimmed);
      const outside = relatives.find((rel) => !scope.some((allowed) => trimmed(rel) === allowed || trimmed(rel).startsWith(`${allowed}/`)));
      if (outside !== undefined) return { allow: false, reason: `${outside} is outside this step's write scope` };
    }
  }
  if (call.kind === "execute" && policy.noExternalActions && call.command !== null && isExternalAction(call.command)) {
    return { allow: false, reason: "a step does not push, open pull requests or move shared refs: AHP does" };
  }
  return { allow: true };
}

/** Whether a shell command starts with one that acts outside the workspace. Only the start is read: a command that gets there another way is not seen. */
export function isExternalAction(command: string): boolean {
  const start = command.trim().replace(/\s+/g, " ");
  return EXTERNAL_ACTION_COMMANDS.some((prefix) => start === prefix || start.startsWith(`${prefix} `));
}
