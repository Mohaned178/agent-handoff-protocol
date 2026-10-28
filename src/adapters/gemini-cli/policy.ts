// The policy file AHP gives Gemini CLI (`--policy <file>`) for the capabilities a step lists. It is Gemini CLI's own policy
// engine's TOML, which parses the shell command (`commandPrefix`), so it sees what the title of an ACP permission request
// only describes. It is `cooperative` all the same: it guards Gemini CLI's own tool calls, and an agent with a shell
// reaches files and refs around them (observed for Claude Code on Windows, ticket 14 F3; not tested for Gemini CLI).
//
// What was seen on a real 0.42.0: a rule file of this shape is read and validated (a file with an unknown `decision`
// printed "Policy file error" on stderr and the one below did not). Not seen: a deny rule stopping a tool call.
// The source says `--policy` replaces the user's own policy directory for the run, so their saved "always allow" rules do
// not apply to an attempt; an admin (system-wide) policy still does.

import { EXTERNAL_ACTION_COMMANDS, type PermissionPolicy } from "../acp/permissions.ts";

/** The tools that change a file (source: the `write_file` and `replace` tools; the shell is covered by the shell rules and by AHP's answers). */
const WRITE_TOOLS = ["write_file", "replace"];

// Higher wins; the top of the user tier's range.
const PRIORITY = 999;

const quoted = (value: string) => JSON.stringify(value);

/** The TOML text of the rules for `policy`: `deny` rules for what the step may not do, and no rule otherwise. */
export function policyFileOf(policy: PermissionPolicy): string {
  const rules: string[] = ["# The rules of one AHP attempt. Gemini CLI reads this file in place of the user's own policy directory."];
  if (policy.readOnly) {
    rules.push(`[[rule]]\ntoolName = [${WRITE_TOOLS.map(quoted).join(", ")}]\ndecision = "deny"\npriority = ${PRIORITY}\ndenyMessage = "This step is read-only."`);
  }
  if (policy.noExternalActions) {
    rules.push(
      `[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = [${EXTERNAL_ACTION_COMMANDS.map(quoted).join(", ")}]\ndecision = "deny"\npriority = ${PRIORITY}\n` +
        'denyMessage = "A step does not push, open pull requests or move shared refs: AHP does, after the result is verified."',
    );
  }
  return `${rules.join("\n\n")}\n`;
}
