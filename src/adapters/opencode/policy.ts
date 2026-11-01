// What AHP asks of OpenCode for the capabilities a step lists. All of it is `cooperative` and none of it is enforcement:
// OpenCode's permission rules guard OpenCode's own tool calls, and the answers AHP gives its permission requests are in
// `../acp/permissions.ts`, shared with the other ACP adapter.

import { EXTERNAL_ACTION_COMMANDS, type PermissionPolicy } from "../acp/permissions.ts";
import { providerBlockOf, type LocalEndpoint } from "./local.ts";

/**
 * The inline config OpenCode is started with (`OPENCODE_CONFIG_CONTENT`, which no file in the worktree can weaken): the
 * `permission` rules, and for a step on a local engine its `provider` block. `edit: deny` is OpenCode's own rule; `edit: ask`
 * hands each write to the client, which answers by path (`decide`); the shell patterns are deny rules for the commands that act
 * outside the workspace. The rules come from the capabilities alone: a local endpoint adds a provider and changes no rule.
 */
export function configContentOf(policy: PermissionPolicy, localEndpoint: LocalEndpoint | null = null): string {
  const permission: Record<string, unknown> = {};
  // `ask` for every step that may write: AHP's answer is what keeps a write out of `.git` and out of the workspace's parent.
  permission.edit = policy.readOnly ? "deny" : "ask";
  if (policy.noExternalActions) {
    permission.bash = Object.fromEntries(EXTERNAL_ACTION_COMMANDS.map((command) => [command === "gh" ? "gh *" : `${command}*`, "deny"]));
  }
  return JSON.stringify(localEndpoint === null ? { permission } : { permission, provider: providerBlockOf(localEndpoint) });
}
