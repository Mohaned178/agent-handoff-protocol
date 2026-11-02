// What the summary lists (spec "Summary: one look, one key"), as data: each answer with where it came from, so a wrong guess
// is seen before anything runs. The text is only what the project, the machine and the person said: a check that is not
// there is "not verified", never skipped quietly, and the mock says it is one.

import { TOOLS } from "../doctor/tools.ts";
import { THIS_REPOSITORY } from "../protocol/index.ts";
import { CHECK_TYPED, type TaskRun } from "../setup/task.ts";
import { YOUR_DEFAULT } from "../setup/infer.ts";
import { CHANGED_HERE } from "../commands/task.ts";
import type { Role, RoleAssignment } from "../doctor/init.ts";
import type { Token } from "./theme.ts";

export interface SummaryRow {
  key: string;
  label: string;
  value: string;
  /** Where the value came from, in `muted` (or `warn` where it asks for attention). */
  source: string;
  sourceTone: Token;
  /** The step this row is, for the rows Tab can pick. */
  role?: Role;
}

const toolName = (assignment: RoleAssignment): string => (assignment.tool === null ? "mock" : (TOOLS.find((tool) => tool.id === assignment.tool)?.name ?? assignment.adapter));

/** "Codex CLI · gpt-5.6 · medium"; "mock" for the mock. */
export function playerOf(assignment: RoleAssignment): string {
  if (assignment.tool === null) return "mock";
  return [toolName(assignment), assignment.model ?? "default model", ...(assignment.effort ? [assignment.effort] : [])].join(" · ");
}

/** Where a step's answer came from, in a few words. */
export function sourceOfStep(assignment: RoleAssignment): string {
  if (assignment.tool === null) return "scripted, not a real agent";
  if (assignment.reason === YOUR_DEFAULT) return "your default";
  if (assignment.reason.startsWith(`${YOUR_DEFAULT}, `)) return "AHP's pick: your default is not usable here";
  if (assignment.reason === CHANGED_HERE) return "you changed it";
  return "installed here";
}

export interface SummaryInput {
  run: TaskRun;
  /** The check is missing and none was given yet. */
  needsCheck: boolean;
  uncommitted: number;
}

export function summaryRows({ run, needsCheck, uncommitted }: SummaryInput): SummaryRow[] {
  const rows: SummaryRow[] = [];
  if (needsCheck) rows.push({ key: "check", label: "check", value: "none found", source: "no test script, pytest, cargo, go or make test target", sourceTone: "warn" });
  else if (run.check) rows.push({ key: "check", label: "check", value: run.check.command, source: run.check.source === CHECK_TYPED ? "typed by you" : run.check.source, sourceTone: "muted" });
  else rows.push({ key: "check", label: "check", value: "none: review only", source: "not verified", sourceTone: "warn" });
  if (run.check && run.install) rows.push({ key: "install", label: "install", value: run.install.command, source: run.install.source, sourceTone: "muted" });
  for (const assignment of run.assignments) rows.push({ key: assignment.role, label: assignment.role, role: assignment.role, value: playerOf(assignment), source: sourceOfStep(assignment), sourceTone: assignment.tool === null ? "warn" : "muted" });
  rows.push({
    key: "result",
    label: "result",
    value: run.remote === THIS_REPOSITORY ? `branch ${run.branch}, local, after you approve` : `branch ${run.branch}, pushed to ${run.remote} once you approve`,
    source: "",
    sourceTone: "muted",
  });
  if (uncommitted > 0) rows.push({ key: "note", label: "note", value: `${uncommitted} ${uncommitted === 1 ? "file" : "files"} not committed: the agents will not see them`, source: "", sourceTone: "warn" });
  return rows;
}

/** The notice of the first run with real agents. */
export const REAL_AGENTS_NOTICE = "first run with real agents: they run commands on this machine, and their usage counts against your own plans";
/** Said on the summary whenever the mock plays. */
export const MOCK_NOTICE = "mock: scripted agents show the flow and do none of the work; their output is no evidence";
