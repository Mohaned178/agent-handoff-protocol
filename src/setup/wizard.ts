// `ahp setup`: an interactive way to write a workflow (for `ahp run`) or an evaluation suite (for `ahp eval`), choosing
// the tool and the model of each step. It writes the same files `ahp init` and a hand-written suite would be, validated
// before they are written, never replaces a file, and only offers to start them: what runs is still `ahp run`/`ahp eval`.
// The questions go through a `Prompter`, so the flow is tested with scripted answers and run with real menus.

import { existsSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_BRANCH, DEFAULT_WORKFLOW_FILE, ROLES, renderWorkflow, type Role, type RoleAssignment } from "../doctor/init.ts";
import type { DoctorReport } from "../doctor/doctor.ts";
import { TOOLS, type ToolId } from "../doctor/tools.ts";
import { CONDITIONS, type ConditionId } from "../evaluation/events.ts";
import { validateSuite, type EvaluationRole } from "../evaluation/suite.ts";
import type { ModelList } from "./models.ts";

export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
  /** Why it cannot be chosen; shown, never selectable. */
  disabled?: string;
  checked?: boolean;
}

export interface Prompter {
  select<T>(question: { message: string; choices: Choice<T>[]; default?: T }): Promise<T>;
  checkbox<T>(question: { message: string; choices: Choice<T>[] }): Promise<T[]>;
  input(question: { message: string; default?: string; validate?: (value: string) => true | string }): Promise<string>;
  confirm(question: { message: string; default?: boolean }): Promise<boolean>;
  /** Text shown between questions. */
  say(text: string): void;
}

export interface SetupOptions {
  prompter: Prompter;
  /** Where files are written and tasks are looked for. */
  dir: string;
  /** What `ahp doctor` found on this machine. */
  report: DoctorReport;
  /** The models to offer for a tool (`modelsFor`, or a fixed list in tests). */
  models: (tool: ToolId) => Promise<ModelList>;
}

export type SetupResult =
  | { kind: "workflow"; path: string; start: boolean }
  | { kind: "evaluation"; path: string; start: boolean };

export const DEFAULT_SUITE_FILE = "ahp.suite.mjs";

const CONDITION_NAMES: Record<ConditionId, string> = {
  C0: "C0  one agent alone",
  C1: "C1  plan → implement → review, plain text handed on",
  C2: "C2  the same steps with structured handoffs, nothing checked",
  C3: "C3  full AHP: validated handoffs, verification, retry, send-back",
  baseline: "baseline  one agent given as many attempts as C3 used",
};

const ROLE_WORDS: Record<Role, string> = { plan: "plans (read-only)", implement: "writes the code", review: "reviews it" };

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { prompter } = options;
  const kind = await prompter.select<"workflow" | "evaluation">({
    message: "What do you want to set up?",
    choices: [
      { name: "Run a workflow on a repository", value: "workflow", description: "plan → implement → review → your approval → AHP pushes (ahp run)" },
      { name: "Run an evaluation", value: "evaluation", description: "frozen tasks under conditions C0 to C3, scored by hidden tests (ahp eval)" },
    ],
  });
  return kind === "workflow" ? setupWorkflow(options) : setupEvaluation(options);
}

/** The tool and model of one role. `mock` is offered only where a script exists for it (the workflow). */
async function castRole(options: SetupOptions, role: Role, allowMock: boolean): Promise<RoleAssignment> {
  const { prompter, report } = options;
  const choices: Choice<string>[] = TOOLS.map((tool) => {
    const found = report.tools.find((candidate) => candidate.id === tool.id);
    const why = !found?.installed ? "not installed" : !found.adapter ? "no adapter in this build" : found.login.state === "not_logged_in" ? "not logged in" : undefined;
    return { name: tool.name, value: tool.id, ...(why ? { disabled: why } : {}), ...(found?.paidAccess ? { description: found.paidAccess } : {}) };
  });
  if (allowMock) choices.push({ name: "Mock (scripted, no real agent: its output is no evidence)", value: "mock" });
  const adapter = await prompter.select({ message: `Who ${ROLE_WORDS[role]}? (${role})`, choices });
  if (adapter === "mock") return { role, adapter, tool: null, reason: "chosen in ahp setup" };
  const tool = adapter as ToolId;
  const list = await options.models(tool);
  const typed = "\u0000typed";
  const picked = await prompter.select<string | null>({
    message: `Which model for ${role}? (${list.source})`,
    choices: [...list.choices.map((choice) => ({ name: choice.label, value: choice.value })), { name: "type a model name", value: typed }],
    default: null,
  });
  const model = picked === typed ? (await prompter.input({ message: "Model name:", validate: (value) => (value.trim() ? true : "a name, or go back and pick the default") })).trim() : picked;
  return { role, adapter: tool, tool, reason: "chosen in ahp setup", ...(model ? { model } : {}) };
}

/** A file name in `dir` that does not exist yet: asked for again while the one given does. */
async function newFile(options: SetupOptions, message: string, fallback: string): Promise<string> {
  let name = await options.prompter.input({ message, default: fallback });
  while (existsSync(resolve(options.dir, name))) {
    name = await options.prompter.input({ message: `${name} already exists and is never replaced. Another name:`, default: `new-${name}` });
  }
  return resolve(options.dir, name);
}

async function writeNew(path: string, content: string): Promise<void> {
  // Exclusive, as `ahp init`: an existing file is never replaced, even one that appeared after the question.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

async function setupWorkflow(options: SetupOptions): Promise<SetupResult> {
  const { prompter } = options;
  prompter.say("The workflow is the password-reset reference scenario: each step is verified, a review asking for changes sends implement back, and nothing is pushed until you approve.");
  const assignments: RoleAssignment[] = [];
  for (const role of ROLES) assignments.push(await castRole(options, role, true));
  const branch = await prompter.input({ message: "Branch AHP pushes after your approval:", default: DEFAULT_BRANCH });
  const path = await newFile(options, "Workflow file:", DEFAULT_WORKFLOW_FILE);
  await writeNew(path, renderWorkflow(assignments, branch.trim() || DEFAULT_BRANCH, "setup"));
  prompter.say(`Wrote ${path}. It needs a git repository with a commit and a remote named origin; it stops at the approval gate for \`ahp approve\`.`);
  const start = await prompter.confirm({ message: "Start `ahp run` now, in this directory?", default: false });
  return { kind: "workflow", path, start };
}

/** The task directories under `dir`'s `pilot/tasks` (this repository's pilot), relative to `dir`. */
export function tasksUnder(dir: string): string[] {
  const root = join(dir, "pilot", "tasks");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "task.json")))
      .map((entry) => `./${relative(dir, join(root, entry.name)).replaceAll("\\", "/")}`)
      .sort();
  } catch {
    return [];
  }
}

const positiveInteger = (value: string) => (/^[1-9]\d*$/.test(value.trim()) ? true : "a whole number, 1 or more");
const amountOrBlank = (value: string) => (value.trim() === "" || (Number.isFinite(Number(value)) && Number(value) > 0) ? true : "an amount above 0, or blank for none");

async function setupEvaluation(options: SetupOptions): Promise<SetupResult> {
  const { prompter } = options;
  const found = tasksUnder(options.dir);
  let tasks: string[] = [];
  if (found.length > 0) {
    tasks = await prompter.checkbox({ message: "Which tasks?", choices: found.map((task) => ({ name: task.split("/").at(-1)!, value: task, checked: task.endsWith("/password-reset") })) });
  }
  if (tasks.length === 0) {
    const typed = await prompter.input({ message: "Task directories (each holds a task.json), separated by commas:", validate: (value) => (value.trim() ? true : "at least one task") });
    tasks = typed.split(",").map((task) => task.trim()).filter(Boolean);
  }
  let conditions: ConditionId[] = [];
  while (conditions.length === 0) {
    conditions = await prompter.checkbox({ message: "Which conditions?", choices: CONDITIONS.map((id) => ({ name: CONDITION_NAMES[id], value: id, checked: id === "C3" })) });
    if (conditions.length === 0) prompter.say("Choose at least one condition.");
    else if (conditions.includes("baseline") && !conditions.includes("C3")) {
      prompter.say("The baseline is matched to C3's attempts, so it needs C3.");
      conditions = [];
    }
  }
  // C0, and so the baseline, is the implement agent alone; the pipeline conditions need all three.
  const roles: EvaluationRole[] = conditions.some((id) => id === "C1" || id === "C2" || id === "C3") ? ["plan", "implement", "review"] : ["implement"];
  const agents: Partial<Record<EvaluationRole, { adapter: string; model?: string }>> = {};
  for (const role of roles) {
    const cast = await castRole(options, role, false);
    agents[role] = cast.model ? { adapter: cast.adapter, model: cast.model } : { adapter: cast.adapter };
  }
  const repeats = Number(await prompter.input({ message: "Trials per task and condition:", default: "1", validate: positiveInteger }));
  const cap = (await prompter.input({ message: "Stop once the tools report this much spent, in USD (blank: no cap):", default: "5", validate: amountOrBlank })).trim();
  const path = await newFile(options, "Suite file:", DEFAULT_SUITE_FILE);
  const name = path.replace(/^.*[\\/]/, "").replace(/\.m?js$/, "") || "suite";
  const suite = { name, tasks, conditions, agents, repeats, ...(cap ? { spendCap: { amount: Number(cap), currency: "USD" } } : {}) };
  const problems = validateSuite(suite);
  if (problems.length > 0) throw new Error(`the suite would be invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  await writeNew(
    path,
    [
      "// An evaluation suite written by `ahp setup`. Run it with `ahp eval " + relative(options.dir, path).replaceAll("\\", "/") + "`.",
      "// Task paths are relative to this file. A spend cap counts only the cost a tool reports, which is a list price, not a charge.",
      "",
      `export default ${JSON.stringify(suite, null, 2)};`,
      "",
    ].join("\n"),
  );
  prompter.say(`Wrote ${path}.`);
  const start = await prompter.confirm({ message: "Start `ahp eval` now?", default: false });
  return { kind: "evaluation", path, start };
}
