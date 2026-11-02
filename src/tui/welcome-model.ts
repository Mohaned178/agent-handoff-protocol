// What the first-open screens say about the tools on this machine, as data: one row per tool with the symbol that carries its
// state without colour. Only what `diagnose` found: a login is "logged in" only when the tool's own status command said so,
// and a tool whose login AHP cannot read is said to be unchecked, never assumed fine or broken.

import type { DoctorReport, ToolReport } from "../doctor/doctor.ts";
import { TOOLS, type ToolDefinition } from "../doctor/tools.ts";
import { SYMBOLS, type Token } from "./theme.ts";

export interface ToolRow {
  id: ToolReport["id"];
  name: string;
  symbol: string;
  tone: Token;
  /** The version the tool printed, or "". */
  version: string;
  /** "logged in", "not logged in", "not installed"... */
  state: string;
  /** The command that fixes it (install, or log in), or null when nothing needs fixing. */
  fix: string | null;
  /** Whether a step can be cast to it now. */
  usable: boolean;
}

export function toolRow(report: ToolReport, definition: ToolDefinition): ToolRow {
  const base = { id: report.id, name: definition.name, version: report.version ?? "", usable: report.usable };
  if (!report.installed) return { ...base, symbol: SYMBOLS.fail, tone: "error", state: "not installed", fix: definition.install, version: "" };
  if (report.adapter === null) return { ...base, symbol: SYMBOLS.fail, tone: "error", state: "no adapter in this build", fix: null };
  if (report.login.state === "not_logged_in") return { ...base, symbol: SYMBOLS.wait, tone: "warn", state: "not logged in", fix: definition.logIn };
  if (report.login.state === "logged_in") return { ...base, symbol: SYMBOLS.ok, tone: "accent", state: "logged in", fix: null };
  return { ...base, symbol: SYMBOLS.ok, tone: "accent", state: "installed, login not checked", fix: null };
}

/** One row per tool, in the order of `TOOLS`. */
export function toolRows(report: DoctorReport): ToolRow[] {
  return TOOLS.map((definition) => toolRow(report.tools.find((tool) => tool.id === definition.id)!, definition));
}

/** Whether any tool can play a step. */
export const anyUsable = (report: DoctorReport): boolean => report.tools.some((tool) => tool.usable);
