import { TOOLS, type DoctorReport, type ToolReport } from "../doctor/index.ts";

/** What each enforcement level means, in every report that shows one: only the first is enforcement. */
export const ENFORCEMENT_NOTE =
  "enforced_by_tool: the tool itself blocks it; cooperative: the agent is only asked, and nothing stops it; none: not applied";

function formatTool(tool: ToolReport): string[] {
  const lines = [`${tool.name} (${tool.command})`];
  const definition = TOOLS.find((candidate) => candidate.id === tool.id);
  if (!tool.installed) {
    lines.push(`  installed: no (${tool.problem})`);
    if (definition) lines.push(`  to install: ${definition.install}`);
  } else {
    lines.push(`  installed: yes${tool.path ? ` (${tool.path})` : ""}`);
    lines.push(`  version: ${tool.version ?? `unknown${tool.problem ? ` (${tool.problem})` : ""}`}`);
    lines.push(`  logged in: ${tool.login.state === "logged_in" ? "yes" : tool.login.state === "not_logged_in" ? "no" : "unknown"} (${tool.login.detail})`);
    if (tool.login.state === "not_logged_in" && definition) lines.push(`  to log in: ${definition.logIn}`);
  }
  if (!tool.adapter) {
    lines.push("  adapter: none in this build yet, so AHP cannot apply any capability through this tool");
  } else {
    const { adapter } = tool;
    lines.push(`  adapter: ${adapter.name} (${adapter.transport}); model reporting: ${adapter.modelReporting}`);
    lines.push("  capabilities declared on this system:");
    for (const { kind, level } of adapter.capabilities) lines.push(`    ${kind}: ${level}`);
    for (const { stance, level } of adapter.network) lines.push(`    network ${stance}: ${level}`);
  }
  return lines;
}

/** `ahp doctor` as text. */
export function formatDoctor({ system, tools, ok }: DoctorReport): string {
  const { os, node, git } = system;
  const lines = [
    "System",
    `  os: ${os.label ?? os.platform} ${os.release}${os.supported ? "" : " (not a system AHP supports)"}`,
    `  node: ${node.version}, requires ${node.required}: ${node.meets ? "ok" : "TOO OLD"}`,
    `  git: ${git.version ?? "not found"}, requires ${git.required}: ${git.meets ? "ok" : git.version ? "TOO OLD" : `PROBLEM (${git.detail})`}`,
    "",
    "Coding agent tools",
  ];
  for (const tool of tools) lines.push(...formatTool(tool).map((line) => `  ${line}`), "");
  lines.push(`Levels are what each adapter declares, not what was observed here. ${ENFORCEMENT_NOTE}.`);
  lines.push("A worktree isolates files; it is not a security boundary. AHP reads no credentials: login comes only from each tool's own status command.");
  if (!ok) lines.push("", "ahp cannot run reliably on this machine until the problems above are fixed.");
  return lines.join("\n");
}
