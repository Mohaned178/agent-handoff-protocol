// Choosing a step's tool, model and effort (spec D6), as a pure state machine over answers: tool, then OpenCode's access
// (asked once, never claimed to be checked), then the model (the tool's default first, then the tool's list or AHP's known
// names, then any name typed), then the effort (only where the tool has one), then whether to keep it for next time.
// The screen only shows the phase and feeds the answer in.

import type { DoctorReport } from "../doctor/doctor.ts";
import type { Role, RoleAssignment } from "../doctor/init.ts";
import { TOOLS, type ToolId } from "../doctor/tools.ts";
import type { RoleDefault } from "../setup/infer.ts";
import { effortsFor, offeredByOpenCode, type ModelList, type OpenCodeAccess } from "../setup/models.ts";
import { toolRows, type ToolRow } from "./welcome-model.ts";

/** The value of the picker row that opens a text field for a model name. */
export const TYPED = "\u0000typed";

export type Phase = "tool" | "access" | "model" | "typed" | "effort" | "keep" | "done";

export interface StepChoice {
  role: Role;
  phase: Phase;
  tool: ToolId | null;
  /** The model asked for, or null for the tool's own default. */
  model: string | null;
  effort: string | null;
  /** Whether to keep it as the default for next time (default no). */
  keep: boolean;
}

export interface ChoiceOptions {
  /** Whether the answer to "keep it?" is asked (the summary asks; the first-open screen saves on its own terms). */
  askKeep: boolean;
  /** Whether OpenCode's access was asked already in this session. */
  accessKnown: boolean;
}

export type Answer =
  | { tool: ToolId }
  | { access: readonly OpenCodeAccess[] }
  | { model: string | null }
  | { typed: string }
  | { effort: string | null }
  | { keep: boolean };

export const startChoice = (role: Role): StepChoice => ({ role, phase: "tool", tool: null, model: null, effort: null, keep: false });

const afterEffort = (choice: StepChoice, options: ChoiceOptions): StepChoice => ({ ...choice, phase: options.askKeep ? "keep" : "done" });
const afterModel = (choice: StepChoice, options: ChoiceOptions): StepChoice =>
  choice.tool !== null && effortsFor(choice.tool).length > 0 ? { ...choice, phase: "effort" } : afterEffort(choice, options);

/** The choice once `answer` is given to the phase it is in; an answer to another phase changes nothing. */
export function advance(choice: StepChoice, answer: Answer, options: ChoiceOptions): StepChoice {
  switch (choice.phase) {
    case "tool":
      if (!("tool" in answer)) return choice;
      // A new tool drops the model and effort chosen before for another.
      return { ...choice, tool: answer.tool, model: null, effort: null, phase: answer.tool === "opencode" && !options.accessKnown ? "access" : "model" };
    case "access":
      return "access" in answer ? { ...choice, phase: "model" } : choice;
    case "model":
      if (!("model" in answer)) return choice;
      return answer.model === TYPED ? { ...choice, phase: "typed" } : afterModel({ ...choice, model: answer.model }, options);
    case "typed":
      return "typed" in answer && answer.typed.trim() !== "" ? afterModel({ ...choice, model: answer.typed.trim() }, options) : choice;
    case "effort":
      return "effort" in answer ? afterEffort({ ...choice, effort: answer.effort }, options) : choice;
    case "keep":
      return "keep" in answer ? { ...choice, keep: answer.keep, phase: "done" } : choice;
    case "done":
      return choice;
  }
}

/** The step as chosen. `reason` says where it came from (the summary's words for it). */
export function assignmentOf(choice: StepChoice, reason: string): RoleAssignment {
  const tool = choice.tool!;
  return { role: choice.role, adapter: tool, tool, reason, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) };
}

/** The same as the default a person can keep: names only. */
export function defaultOf(assignment: RoleAssignment): RoleDefault | null {
  if (assignment.tool === null) return null;
  return { tool: assignment.tool, ...(assignment.model ? { model: assignment.model } : {}), ...(assignment.effort ? { effort: assignment.effort } : {}) };
}

export interface ChoiceRow<V> {
  label: string;
  hint?: string;
  dim?: boolean;
  value: V;
}

/** The tools to pick from: every tool, the unusable ones dimmed and saying what to do about it. */
export function toolChoices(report: DoctorReport): (ChoiceRow<ToolId> & { row: ToolRow })[] {
  return toolRows(report).map((row) => ({ label: row.name, value: row.id, row, dim: !row.usable, hint: row.usable ? [row.version, row.state].filter(Boolean).join("  ") : `${row.state}${row.fix ? `: ${row.fix}` : ""}` }));
}

/** The models to pick from: the tool's default, what the list holds (for OpenCode, what the named access offers), a typed name. */
export function modelChoices(list: ModelList, tool: ToolId, access: readonly OpenCodeAccess[]): ChoiceRow<string | null>[] {
  const offered = list.choices.filter((choice) => tool !== "opencode" || choice.value === null || offeredByOpenCode(choice.value, access));
  return [...offered.map((choice) => ({ label: choice.value === null ? "the tool's own default" : choice.label, value: choice.value, ...(choice.value === null ? { hint: "no model requested" } : {}) })), { label: "type a model name…", value: TYPED }];
}

/** The efforts to pick from: the tool's default, then each level its adapter passes on. */
export function effortChoices(tool: ToolId): ChoiceRow<string | null>[] {
  return [{ label: "the tool's own default", value: null }, ...effortsFor(tool).map((level) => ({ label: level, value: level }))];
}

export const KEEP_CHOICES: ChoiceRow<boolean>[] = [
  { label: "no, only this run", value: false },
  { label: "yes, use it next time", value: true },
];

/** The question each phase asks, as the screen's heading. */
export function questionOf(choice: StepChoice): string {
  const tool = choice.tool === null ? "" : (TOOLS.find((definition) => definition.id === choice.tool)?.name ?? choice.tool);
  switch (choice.phase) {
    case "tool":
      return `Who does ${choice.role}?`;
    case "access":
      return "Which OpenCode access do you have? (AHP cannot check it; Zen's free models are always offered)";
    case "model":
    case "typed":
      return `Which model for ${choice.role}? (${tool})`;
    case "effort":
      return `Which effort for ${choice.role}? (the model may refuse a level; ${tool} says so when it runs)`;
    case "keep":
      return `Use ${tool} (${[choice.model ?? "its default model", ...(choice.effort ? [`effort ${choice.effort}`] : [])].join(", ")}) for ${choice.role} next time?`;
    case "done":
      return "";
  }
}
