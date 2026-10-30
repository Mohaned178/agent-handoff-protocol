// How AHP answers an ACP agent's `session/request_permission`, for the capabilities a step lists. All of it is
// `cooperative` and none of it is enforcement: an ACP permission request is a question the client may answer either way,
// the agent's own rules guard only its own tool calls, and an agent with a shell reaches files and refs around both
// (observed for Claude Code on Windows, ticket 14, F3; not tested for OpenCode). Kept apart from the OpenCode
// adapter because none of it is particular to one ACP agent.

import { isAbsolute, relative, resolve } from "node:path";
import type { AppliedCapabilities } from "../../protocol/index.ts";
import type { ToolCall, ToolCallLogger } from "./tool-calls.ts";

/** The commands that move a shared ref or open a pull request. Matched at the start of a shell command; `git branch` and `git tag` also list, so they are not here. */
export const EXTERNAL_ACTION_COMMANDS = ["git push", "git update-ref", "gh"] as const;

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

/** What the agent told the client about a tool call it wants to make. */
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

/**
 * Answers a `session/request_permission` by the policy: one option of the kind chosen, `allow_once` or `reject_once`,
 * never `allow_always` (it would outlive the attempt in the user's own rules). What the agent knew of the call from
 * earlier updates fills in what the request leaves out.
 */
export function answerPermission(params: unknown, policy: PermissionPolicy, known: (toolCallId: string) => ToolCall | undefined, log: ToolCallLogger): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const request = (typeof params === "object" && params !== null ? params : {}) as { toolCall?: unknown; options?: { optionId?: string; kind?: string }[] };
  const tool = (typeof request.toolCall === "object" && request.toolCall !== null ? request.toolCall : {}) as Record<string, unknown>;
  const earlier: ToolCall | undefined = typeof tool.toolCallId === "string" ? known(tool.toolCallId) : undefined;
  const rawInput = typeof tool.rawInput === "object" && tool.rawInput !== null ? (tool.rawInput as Record<string, unknown>) : {};
  const locations: string[] = Array.isArray(tool.locations)
    ? tool.locations.flatMap((location: unknown) => (typeof (location as { path?: unknown } | null)?.path === "string" ? [(location as { path: string }).path] : []))
    : [];
  const kind = typeof tool.kind === "string" ? tool.kind : (earlier?.kind ?? null);
  const title = typeof tool.title === "string" ? tool.title : (earlier?.title ?? null);
  const call: ToolCallRequest = {
    kind,
    title,
    paths: locations.length > 0 ? locations : (earlier?.paths ?? []),
    command: typeof rawInput.command === "string" ? rawInput.command : (earlier?.command ?? null),
  };
  const decision = decide(policy, call);
  const wanted = decision.allow ? "allow_once" : "reject_once";
  const option = request.options?.find((candidate) => candidate.kind === wanted);
  // What was answered, not what was meant: with no option of the kind, the answer is `cancelled`, which allows nothing.
  if (typeof tool.toolCallId === "string") log.permission(tool.toolCallId, call, decision.allow && option?.optionId ? "allowed" : "rejected");
  return { outcome: option?.optionId ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
}
