// `ahp setup`: an interactive way to write a workflow (for `ahp run`) or an evaluation suite (for `ahp eval`), choosing
// the tool and the model of each step. It writes the same files `ahp init` and a hand-written suite would be, validated
// before they are written, never replaces a file, and only offers to start them: what runs is still `ahp run`/`ahp eval`.
// The questions go through a `Prompter`, so the flow is tested with scripted answers and run with real menus.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_BRANCH, DEFAULT_WORKFLOW_FILE, ROLES, renderTaskWorkflow, renderWorkflow, type Role, type RoleAssignment } from "../doctor/init.ts";
import { DEFAULT_REMOTE, isBranchName, isRepoPath, THIS_REPOSITORY } from "../protocol/index.ts";
import type { DoctorReport } from "../doctor/doctor.ts";
import { TOOLS, type ToolId } from "../doctor/tools.ts";
import { CONDITIONS, type ConditionId } from "../evaluation/events.ts";
import { rolesFor, validateSuite, type EvaluationRole } from "../evaluation/suite.ts";
import { effortsFor, offeredByOpenCode, OPENCODE_ACCESS, OPENCODE_ACCESS_NAMES, type ModelList, type OpenCodeAccess } from "./models.ts";

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
  /** Where a workflow publishes after approval: a remote, or `.` for a branch in this repository. Default `origin`. */
  remote?: string;
}

/** The question for the branch, and what is said once the file is written, for where the workflow publishes. */
function publishWords(options: SetupOptions): { branch: string; after: string } {
  const remote = options.remote ?? DEFAULT_REMOTE;
  return remote === THIS_REPOSITORY
    ? {
        branch: "Branch AHP makes in this repository after your approval (it has no remote named origin):",
        after: "it stops at the approval gate; once you approve, the work goes on that branch, for you to merge",
      }
    : { branch: `Branch AHP pushes to ${remote} after your approval:`, after: "it stops at the approval gate; nothing is pushed until you approve" };
}

export type SetupResult =
  | { kind: "workflow"; path: string; start: boolean }
  | { kind: "evaluation"; path: string; start: boolean };

export const DEFAULT_SUITE_FILE = "ahp.suite.mjs";

const CONDITION_NAMES: Record<ConditionId, string> = {
  C0: "C0  one agent alone",
  C0V: "C0V  one agent with the acceptance check and retry",
  C1: "C1  plan → implement → review, plain text handed on",
  C2: "C2  the same steps with structured handoffs, nothing checked",
  C3min: "C3min  implement → review, with the acceptance check, retry and send-back",
  C3: "C3  full AHP: validated handoffs, verification, retry, send-back",
  baseline: "baseline  one agent given as many attempts as C3 used (a ceiling)",
};

/** The conditions offered ticked: whether a pipeline beats one agent that has the same acceptance check and retry. */
const PRECHECKED: readonly ConditionId[] = ["C0V", "C3min", "C3"];

const ROLE_WORDS: Record<Role, string> = { plan: "plans (read-only)", implement: "writes the code", review: "reviews it" };

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { prompter } = options;
  const kind = await prompter.select<"workflow" | "evaluation">({
    message: "What do you want to set up?",
    choices: [
      { name: "Run a workflow on a repository", value: "workflow", description: "plan → implement → review → your approval → AHP pushes (ahp run)" },
      { name: "Run an evaluation", value: "evaluation", description: "frozen tasks under conditions C0 to C3, scored by hidden tests no agent sees (ahp eval)" },
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
    return { name: tool.name, value: tool.id, ...(why ? { disabled: why } : {}) };
  });
  if (allowMock) choices.push({ name: "Mock (scripted, no real agent: its output is no evidence)", value: "mock" });
  const adapter = await prompter.select({ message: `Who ${ROLE_WORDS[role]}? (${role})`, choices });
  if (adapter === "mock") return { role, adapter, tool: null, reason: "chosen in ahp setup" };
  const tool = adapter as ToolId;
  let list = await options.models(tool);
  if (tool === "opencode") {
    const access = await openCodeAccess(options);
    list = { ...list, choices: list.choices.filter((choice) => choice.value === null || offeredByOpenCode(choice.value, access)) };
  }
  const typed = "\u0000typed";
  const picked = await prompter.select<string | null>({
    message: `Which model for ${role}? (${list.source})`,
    choices: [...list.choices.map((choice) => ({ name: choice.label, value: choice.value })), { name: "type a model name", value: typed }],
    default: null,
  });
  const model = picked === typed ? (await prompter.input({ message: "Model name:", validate: (value) => (value.trim() ? true : "a name, or go back and pick the default") })).trim() : picked;
  const efforts = effortsFor(tool);
  const effort = efforts.length === 0
    ? null
    : await prompter.select<string | null>({
        message: `Which effort for ${role}? (the model may refuse a level; the tool says so when it runs)`,
        choices: [{ name: "the tool's own default", value: null }, ...efforts.map((level) => ({ name: level, value: level }))],
        default: null,
      });
  return { role, adapter: tool, tool, reason: "chosen in ahp setup", ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

const openCodeAccessAnswers = new WeakMap<SetupOptions, OpenCodeAccess[]>();

/** What OpenCode access the person says they have, asked once per setup whatever the number of OpenCode roles. */
async function openCodeAccess(options: SetupOptions): Promise<OpenCodeAccess[]> {
  const known = openCodeAccessAnswers.get(options);
  if (known) return known;
  const access = await options.prompter.checkbox<OpenCodeAccess>({
    message: "Which OpenCode access do you have? (AHP cannot check it; Zen's free models are always offered, and any name can be typed)",
    choices: OPENCODE_ACCESS.map((id) => ({ ...OPENCODE_ACCESS_NAMES[id], value: id })),
  });
  openCodeAccessAnswers.set(options, access);
  return access;
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
  const task = await prompter.select<"own" | "example">({
    message: "Which task?",
    choices: [
      { name: "Your own task in this repository", value: "own", description: "you say what to build and the command that checks it" },
      { name: "The password-reset example", value: "example", description: "a demo with a hidden test, to see AHP work end to end" },
    ],
  });
  if (task === "own") return setupOwnTask(options);
  prompter.say("The workflow is the password-reset reference scenario: each step is verified, a review asking for changes sends implement back, and nothing is pushed until you approve.");
  const assignments: RoleAssignment[] = [];
  for (const role of ROLES) assignments.push(await castRole(options, role, true));
  const words = publishWords(options);
  const branch = await prompter.input({ message: words.branch, default: DEFAULT_BRANCH });
  const path = await newFile(options, "Workflow file:", DEFAULT_WORKFLOW_FILE);
  await writeNew(path, renderWorkflow(assignments, branch.trim() || DEFAULT_BRANCH, "setup", options.remote ?? DEFAULT_REMOTE));
  prompter.say(`Wrote ${path}: ${words.after}.`);
  const start = await prompter.confirm({ message: "Start it now?", default: true });
  return { kind: "workflow", path, start };
}

/**
 * A workflow for a task of the user's own. The check is theirs and visible to the agents; the mock is not offered, since
 * it has no script for work it does not know.
 */
async function setupOwnTask(options: SetupOptions): Promise<SetupResult> {
  const { prompter, dir } = options;
  prompter.say("Implement is done only when your check command passes in a fresh copy of the repository; a review asking for changes sends implement back; nothing is pushed until you approve.");
  const goal = (await prompter.input({ message: "What should the agents build or change?", validate: (value) => (value.trim() ? true : "say what to build or change") })).trim();
  const pkg = packageOf(dir);
  const command = (
    await prompter.input({
      message: "Command that checks the work (exit code 0 means done):",
      ...(pkg?.scripts?.test ? { default: "npm test" } : {}),
      validate: (value) => (value.trim() ? true : "a command, such as npm test or pytest"),
    })
  ).trim();
  const install = (
    await prompter.input({
      message: "Command that installs dependencies in a fresh copy of the repository, run before the check (blank: none):",
      default: existsSync(join(dir, "package-lock.json")) ? "npm ci" : pkg ? "npm install" : "",
    })
  ).trim();
  const paths = pathsIn(await prompter.input({ message: "Folders or files the implementing agent may change, separated by commas (blank: anywhere):", default: "", validate: pathsOrBlank }));
  const name = (await prompter.input({ message: "A short name for the task:", default: slugOf(goal), validate: (value) => (TASK_NAME.test(value.trim()) ? true : "letters, digits, \"-\" and \"_\", starting with a letter or digit") })).trim();
  const assignments: RoleAssignment[] = [];
  for (const role of ROLES) assignments.push(await castRole(options, role, false));
  const words = publishWords(options);
  const branch = (await prompter.input({ message: words.branch, default: `ahp/${name}`, validate: (value) => (isBranchName(value.trim()) ? true : "a git branch name, such as ahp/my-task") })).trim();
  const path = await newFile(options, "Workflow file:", DEFAULT_WORKFLOW_FILE);
  await writeNew(path, renderTaskWorkflow(assignments, { name, goal, command, install: install || null, paths }, branch, "setup", options.remote ?? DEFAULT_REMOTE));
  prompter.say(`Wrote ${path}: ${words.after}.`);
  const start = await prompter.confirm({ message: "Start it now?", default: true });
  return { kind: "workflow", path, start };
}

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A task name from its first words: lowercase, joined by "-". */
export function slugOf(goal: string): string {
  const words = goal.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 5).join("-") || "task";
}

/** The paths in a comma-separated answer, written as the workflow wants them: "/" separators, no "./" or trailing "/". */
export function pathsIn(answer: string): string[] {
  const paths = answer.split(",").map((path) => path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  return [...new Set(paths)];
}

const pathsOrBlank = (value: string) => {
  const bad = pathsIn(value).filter((path) => !isRepoPath(path));
  return bad.length === 0 ? true : `paths inside the repository, relative to its root, with no "..": not ${bad.join(", ")}`;
};

/** The repository's package.json, if it has one that parses. */
function packageOf(dir: string): { scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
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
    conditions = await prompter.checkbox({ message: "Which conditions?", choices: CONDITIONS.map((id) => ({ name: CONDITION_NAMES[id], value: id, checked: PRECHECKED.includes(id) })) });
    if (conditions.length === 0) prompter.say("Choose at least one condition.");
    else if (conditions.includes("baseline") && !conditions.includes("C3")) {
      prompter.say("The baseline is matched to C3's attempts, so it needs C3.");
      conditions = [];
    }
  }
  // C0, C0V and the baseline are the implement agent alone; the pipeline conditions add a reviewer, and all but C3min a planner.
  const roles: EvaluationRole[] = rolesFor(conditions);
  const agents: Partial<Record<EvaluationRole, { adapter: string; model?: string; options?: { effort: string } }>> = {};
  for (const role of roles) {
    const cast = await castRole(options, role, false);
    agents[role] = { adapter: cast.adapter, ...(cast.model ? { model: cast.model } : {}), ...(cast.effort ? { options: { effort: cast.effort } } : {}) };
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
