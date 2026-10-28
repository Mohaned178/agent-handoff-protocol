// What AHP asks of OpenCode for the capabilities a step lists. All of it is `cooperative` and none of it is enforcement:
// OpenCode's permission rules guard OpenCode's own tool calls, and the answers AHP gives its permission requests are in
// `../acp/permissions.ts`, shared with the other ACP adapter.

import { EXTERNAL_ACTION_COMMANDS, type PermissionPolicy } from "../acp/permissions.ts";

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
