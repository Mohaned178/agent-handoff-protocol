import type { DoctorReport, InitResult, ToolReport } from "../doctor/index.ts";
import { ENFORCEMENT_NOTE } from "./format.ts";

function formatTool(tool: ToolReport): string[] {
  const lines = [`${tool.name} (${tool.command})`];
  if (!tool.installed) {
    lines.push(`  installed: no (${tool.problem})`);
  } else {
    lines.push(`  installed: yes${tool.path ? ` (${tool.path})` : ""}`);
    lines.push(`  version: ${tool.version ?? `unknown${tool.problem ? ` (${tool.problem})` : ""}`}`);
    lines.push(`  logged in: ${tool.login.state === "logged_in" ? "yes" : tool.login.state === "not_logged_in" ? "no" : "unknown"} (${tool.login.detail})`);
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

/** What `ahp init` did, and what to do next. */
export function formatInit({ path, assignments }: InitResult): string {
  return [
    `wrote ${path}`,
    ...assignments.map(({ role, adapter, reason }) => `  ${role}: ${adapter}${adapter === "mock" ? " [mock]" : ""} (${reason})`),
    "",
    `Next: in a git repository with a commit and a remote named origin, \`ahp run ${path}\`.`,
    "It stops at the approval gate (exit code 4); `ahp approve <run-id> approve` lets AHP push the branch.",
  ].join("\n");
}
