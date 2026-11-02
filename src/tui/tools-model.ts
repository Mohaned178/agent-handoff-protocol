// What `/tools` shows, as data, from `diagnose`'s report: Node and git against their minimums, each coding tool with its
// version, login, adapter and the levels that adapter declares on this OS, and the command that fixes what is not ready.
// The levels are what each adapter declares, never something observed; a login AHP cannot read is "unknown", not "no".

import type { AdapterReport, DoctorReport, SystemReport } from "../doctor/doctor.ts";
import { TOOLS } from "../doctor/tools.ts";
import { ENFORCEMENT_LEVELS, type EnforcementLevel } from "../protocol/index.ts";
import { SYMBOLS, type Token } from "./theme.ts";
import { line, part, type TextLine } from "./components/lines.ts";
import { toolRow } from "./welcome-model.ts";

/**
 * Said on the screen under the tools, one short line each so none is cut at 80 columns (the words are the old doctor text's:
 * the old terminal layer goes in ticket 09, so they are not imported from it).
 */
export const NOTES: readonly string[] = [
  "Levels are what each adapter declares, not what was observed here.",
  "enforced_by_tool: the tool itself blocks it. cooperative: the agent is only asked,",
  "and nothing stops it. none: not applied.",
  "A worktree isolates files; it is not a security boundary.",
  "AHP reads no credentials: login comes only from each tool's own status command.",
];

export interface SystemRow {
  key: "os" | "node" | "git";
  symbol: string;
  tone: Token;
  label: string;
  /** What was found against what is required: "v24.8.0, needs 24 or newer". */
  value: string;
}

export interface ToolsRow {
  id: string;
  name: string;
  symbol: string;
  tone: Token;
  /** The version the tool printed, or "not installed". */
  version: string;
  /** "logged in", "not logged in", "login unknown" (the tool has no status command AHP may read), or "". */
  login: string;
  /** The adapter in this build, or "no adapter in this build". */
  adapter: string;
  /** The declared levels on this OS, one line per level that has any, strongest first; empty with no adapter. */
  levels: string[];
  /** The install or log-in command when the tool is not ready, else null. */
  fix: string | null;
}

export interface ToolsModel {
  system: SystemRow[];
  tools: ToolsRow[];
  /** False when Node or git does not meet its minimum: ahp cannot run reliably. */
  ok: boolean;
}

/** Strongest first. */
const LEVEL_ORDER: readonly EnforcementLevel[] = ENFORCEMENT_LEVELS;

/** The declared levels grouped by level: `enforced_by_tool: read_only, write_scope`, one line per level in use. */
export function levelLines(adapter: AdapterReport): string[] {
  const named = [...adapter.capabilities.map(({ kind, level }) => ({ name: kind as string, level })), ...adapter.network.map(({ stance, level }) => ({ name: `network ${stance}`, level }))];
  return LEVEL_ORDER.flatMap((level) => {
    const names = named.filter((entry) => entry.level === level).map((entry) => entry.name);
    return names.length > 0 ? [`${level}: ${names.join(", ")}`] : [];
  });
}

function systemRows(system: SystemReport): SystemRow[] {
  const { os, node, git } = system;
  const row = (key: SystemRow["key"], label: string, meets: boolean, value: string): SystemRow => ({ key, label, value, symbol: meets ? SYMBOLS.ok : SYMBOLS.fail, tone: meets ? "accent" : "error" });
  return [
    row("os", "system", os.supported, `${os.label ?? os.platform} ${os.release}${os.supported ? "" : " (not a system AHP supports)"}`),
    row("node", "Node", node.meets, `${node.version}, needs ${node.required}${node.meets ? "" : ": too old"}`),
    row("git", "git", git.meets, git.version === null ? `not found${git.detail ? ` (${git.detail})` : ""}, needs ${git.required}` : `${git.version}, needs ${git.required}${git.meets ? "" : ": too old"}`),
  ];
}

export function toolsModel(report: DoctorReport): ToolsModel {
  const tools = TOOLS.map((definition): ToolsRow => {
    const found = report.tools.find((tool) => tool.id === definition.id)!;
    const row = toolRow(found, definition);
    const login = !found.installed ? "" : found.login.state === "logged_in" ? "logged in" : found.login.state === "not_logged_in" ? "not logged in" : "login unknown";
    return {
      id: definition.id,
      name: definition.name,
      symbol: row.symbol,
      tone: row.tone,
      version: found.installed ? (found.version ?? "version unknown") : "not installed",
      login,
      adapter: found.adapter ? `${found.adapter.name} (${found.adapter.transport})` : "no adapter in this build",
      levels: found.adapter ? levelLines(found.adapter) : [],
      fix: row.fix,
    };
  });
  return { system: systemRows(report.system), tools, ok: report.ok };
}

/** The screen as lines: the machine, each tool with its fix and its declared levels, then the notes. */
export function toolsLines(model: ToolsModel): TextLine[] {
  const lines: TextLine[] = [line("h-system", part("This machine", "text", true))];
  for (const row of model.system) lines.push(line(`s-${row.key}`, part(`${row.symbol} `, row.tone), part(row.label.padEnd(8), "text"), part(row.value, row.tone === "error" ? "error" : "muted")));
  if (!model.ok) lines.push(line("s-bad", part("  ahp cannot run reliably until the problems above are fixed.", "error")));
  lines.push(line("gap-1", part(" ")), line("h-tools", part("Coding tools", "text", true)));
  for (const tool of model.tools) {
    lines.push(
      line(`t-${tool.id}`, part(`${tool.symbol} `, tool.tone), part(tool.name.padEnd(13), "text"), part(`${tool.version}`.padEnd(26), tool.version === "not installed" ? "error" : "text"), part(tool.login === "" ? "" : `${tool.login}  `, tool.login === "not logged in" ? "warn" : "muted"), part(tool.adapter, "muted")),
    );
    if (tool.fix !== null) lines.push(line(`f-${tool.id}`, part(`  ${tool.version === "not installed" ? "install" : "log in"}: `, "warn"), part(tool.fix, "text")));
    for (const [index, text] of tool.levels.entries()) lines.push(line(`l-${tool.id}-${index}`, part(`  ${text}`, "muted")));
  }
  lines.push(line("gap-2", part(" ")));
  for (const [index, text] of NOTES.entries()) lines.push(line(`n-${index}`, part(text, "muted")));
  return lines;
}
