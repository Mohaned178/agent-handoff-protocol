// A task before it runs, as the app builds it (spec "Summary" and "Slash commands"): what the project and the machine give
// (`inferCommands`, `castRoles`, `branchFor`), then what the person changes for the next run, held in a `TaskSession`. All
// pure but the three git reads at the end; the screens show the result and the run is `buildTaskRun` over it. Nothing here
// prints, asks or writes.

import { ROLES, type Role, type RoleAssignment } from "../doctor/init.ts";
import type { DoctorReport } from "../doctor/doctor.ts";
import { TOOLS, TOOL_IDS, type ToolId } from "../doctor/tools.ts";
import { THIS_REPOSITORY } from "../protocol/index.ts";
import { git } from "../runtime/git.ts";
import { branchFor, type Inferred, type ProjectCommands } from "../setup/infer.ts";
import { effortsFor } from "../setup/models.ts";
import { CHECK_TYPED, mockCasting, stepsOf, type TaskRun } from "../setup/task.ts";

/** What a person changes for the next run: kept above the screens so the prompt's commands and the summary share it. */
export interface TaskSession {
  /** The plan step, on or off. */
  plan: boolean;
  /** The scripted mock plays every step (chosen on the screen that found no usable tool); lasts the whole session. */
  mock: boolean;
  /** A step's tool, model and effort, replacing what AHP cast. */
  steps: Partial<Record<Role, RoleAssignment>>;
  /** The check the person gave (`/check`), `"none"` for review only, or null: the project's own. */
  check: Inferred | "none" | null;
  /** The remote the approved branch is pushed to, or null for a branch in this repository. */
  remote: string | null;
}

export const freshSession = (mock = false): TaskSession => ({ plan: false, mock, steps: {}, check: null, remote: null });

/** What carries over to the run after one starts: the choices were for that run, the mock is for the session. */
export const afterRun = (session: TaskSession): TaskSession => freshSession(session.mock);

/** The reason of a step the person changed for this run. */
export const CHANGED_HERE = "changed for this run";

/** The three roles cast: AHP's casting with the session's changes on top, or the mock for every role. */
export function sessionCasting(base: readonly RoleAssignment[], session: TaskSession): RoleAssignment[] {
  if (session.mock) return mockCasting(ROLES);
  return ROLES.map((role) => session.steps[role] ?? base.find((assignment) => assignment.role === role)!);
}

/** What the session changes from the defaults, in words for the status line: "plan on", "implement Codex CLI gpt-5.6". */
export function sessionChanges(session: TaskSession): string[] {
  const changes: string[] = [];
  if (session.plan) changes.push("plan on");
  for (const role of ROLES) {
    const step = session.steps[role];
    if (step?.tool) changes.push([role, toolNameOf(step.tool), step.model, step.effort].filter(Boolean).join(" "));
  }
  if (session.check === "none") changes.push("check none");
  else if (session.check) changes.push(`check ${session.check.command}`);
  if (session.remote !== null) changes.push(`push ${session.remote}`);
  return changes;
}

export const toolNameOf = (tool: ToolId): string => TOOLS.find((definition) => definition.id === tool)!.name;

/** Why a tool cannot be cast here, as the setup menu says it, or null when it can. */
export function unusableBecause(report: DoctorReport, tool: ToolId): string | null {
  const found = report.tools.find((candidate) => candidate.id === tool);
  if (found?.usable) return null;
  return !found?.installed ? "not installed" : !found.adapter ? "no adapter in this build" : found.login.state === "not_logged_in" ? "not logged in" : "not usable";
}

/** The tool a word names: its id (`claude-code`, `codex`, `opencode`), or `claude`. */
export function toolNamed(word: string): ToolId | null {
  const lower = word.toLowerCase();
  if (lower === "claude") return "claude-code";
  return TOOL_IDS.find((id) => id === lower) ?? null;
}

export type SlashOutcome = { ok: true; session: TaskSession; notice: string } | { ok: false; error: string };
const fail = (error: string): SlashOutcome => ({ ok: false, error });

/** What a command that sets a step's tool, model or effort needs to know. */
export interface SlashContext {
  session: TaskSession;
  /** AHP's casting for the three roles, with the saved defaults. */
  base: readonly RoleAssignment[];
  report: DoctorReport;
  /** The remotes the repository has. */
  remotes: readonly string[];
}

const ROLE_LIST = ROLES.join(", ");
const MODEL_USAGE = `usage: /model <step> <tool> [model], e.g. /model implement codex gpt-5.6 (steps: ${ROLE_LIST}; tools: ${TOOL_IDS.join(", ")}); /model <step> <model> keeps the tool`;
const EFFORT_USAGE = `usage: /effort <step> <level>, e.g. /effort review high (steps: ${ROLE_LIST}; a level, or default)`;

const roleNamed = (word: string | undefined): Role | null => ROLES.find((role) => role === word?.toLowerCase()) ?? null;

function withStep(session: TaskSession, step: RoleAssignment): TaskSession {
  return { ...session, steps: { ...session.steps, [step.role]: step } };
}

const describeStep = (step: RoleAssignment): string =>
  `${step.role}: ${step.tool === null ? "mock" : toolNameOf(step.tool)}, ${step.model ?? "default model"}${step.effort ? `, effort ${step.effort}` : ""}`;

function setModel(context: SlashContext, args: string[]): SlashOutcome {
  const role = roleNamed(args[0]);
  if (role === null || args.length < 2) return fail(MODEL_USAGE);
  if (context.session.mock) return fail("the mock plays every step: it has no tool or model to choose");
  const current = sessionCasting(context.base, context.session).find((assignment) => assignment.role === role)!;
  const tool = toolNamed(args[1]!);
  if (tool !== null) {
    const why = unusableBecause(context.report, tool);
    if (why !== null) return fail(`${role} ${tool}: ${toolNameOf(tool)} is not usable here (${why}; /tools says more)`);
    const model = args.slice(2).join(" ").trim();
    // A new tool drops the model and effort cast for the old one; a same tool keeps the effort.
    const kept = tool === current.tool && current.effort ? { effort: current.effort } : {};
    const step: RoleAssignment = { role, adapter: tool, tool, reason: CHANGED_HERE, ...(model ? { model } : {}), ...kept };
    return { ok: true, session: withStep(context.session, step), notice: `${describeStep(step)} for the next run` };
  }
  if (current.tool === null) return fail(`${role} has no tool to name a model for: ${MODEL_USAGE}`);
  const step: RoleAssignment = { ...current, model: args.slice(1).join(" ").trim(), reason: CHANGED_HERE };
  return { ok: true, session: withStep(context.session, step), notice: `${describeStep(step)} for the next run` };
}

function setEffort(context: SlashContext, args: string[]): SlashOutcome {
  const role = roleNamed(args[0]);
  if (role === null || args.length !== 2) return fail(EFFORT_USAGE);
  if (context.session.mock) return fail("the mock plays every step: it has no effort to choose");
  const current = sessionCasting(context.base, context.session).find((assignment) => assignment.role === role)!;
  const level = args[1]!.toLowerCase();
  const levels = current.tool === null ? [] : effortsFor(current.tool);
  const name = current.tool === null ? "the mock" : toolNameOf(current.tool);
  if (level !== "default" && !levels.includes(level)) return fail(levels.length > 0 ? `${role} effort ${level}: ${name}'s efforts are ${levels.join(", ")}` : `${name} has no effort setting`);
  const { effort: _dropped, ...rest } = current;
  const step: RoleAssignment = { ...rest, ...(level === "default" ? {} : { effort: level }), reason: CHANGED_HERE };
  return { ok: true, session: withStep(context.session, step), notice: `${describeStep(step)} for the next run` };
}

/**
 * The slash commands that change the next run: `/model`, `/effort`, `/plan`, `/check`, `/push`. A refusal is a sentence
 * that says how to say it right. Tools and efforts are validated; a model is any name the person types.
 */
export function applySlash(name: string, argument: string, context: SlashContext): SlashOutcome {
  const args = argument.trim().split(/\s+/).filter(Boolean);
  const { session } = context;
  switch (name) {
    case "model":
      return setModel(context, args);
    case "effort":
      return setEffort(context, args);
    case "plan": {
      const word = args[0]?.toLowerCase();
      const plan = word === "on" ? true : word === "off" ? false : word === undefined ? !session.plan : null;
      if (plan === null || args.length > 1) return fail("usage: /plan on or /plan off");
      return { ok: true, session: { ...session, plan }, notice: `the plan step is ${plan ? "on" : "off"} for the next run` };
    }
    case "check": {
      const command = argument.trim();
      if (command === "") return fail("usage: /check <command that checks the work>, or /check none for review only");
      if (command.toLowerCase() === "none") return { ok: true, session: { ...session, check: "none" }, notice: "no check for the next run: review only, not verified" };
      return { ok: true, session: { ...session, check: { command, source: CHECK_TYPED } }, notice: `the next run is checked by \`${command}\`` };
    }
    case "push": {
      const remote = args[0];
      if (remote === undefined || args.length > 1) return fail("usage: /push <remote>, e.g. /push origin; /push . keeps the branch in this repository");
      if (remote === "." || remote.toLowerCase() === "local") return { ok: true, session: { ...session, remote: null }, notice: "the next run puts the approved work on a branch in this repository" };
      if (!context.remotes.includes(remote)) {
        return fail(`this repository has no remote "${remote}"${context.remotes.length > 0 ? ` (it has ${context.remotes.join(", ")})` : ""}: \`git remote add ${remote} <url>\` adds it, or /push . keeps the branch here`);
      }
      return { ok: true, session: { ...session, remote }, notice: `the next run pushes the approved branch to ${remote}, after you approve` };
    }
  }
  return fail(`/${name} is not a command that changes the next run`);
}

export interface DraftInput {
  task: string;
  /** What the project names: its check and install. */
  found: ProjectCommands;
  /** AHP's casting for the three roles, with the saved defaults. */
  base: readonly RoleAssignment[];
  session: TaskSession;
  /** The branch names a new branch must not take. */
  branches: readonly string[];
}

export interface TaskDraft {
  run: TaskRun;
  /** No check was found and none given: the summary asks for one before the run can start. */
  needsCheck: boolean;
  /** No tool is usable and the mock was not chosen: the summary offers the install commands and the mock instead. */
  noTool: boolean;
}

/** The run a task would be, from the project, the machine's casting and the session's changes. */
export function draftTask({ task, found, base, session, branches }: DraftInput): TaskDraft {
  const casting = sessionCasting(base, session);
  const assignments = stepsOf(session.plan).map((role) => casting.find((assignment) => assignment.role === role)!);
  const check = session.check === "none" ? null : (session.check ?? found.check);
  const remote = session.remote ?? THIS_REPOSITORY;
  return {
    run: { task, check, install: check === null ? null : found.install, assignments, branch: branchFor(task, branches), remote },
    needsCheck: session.check === null && found.check === null,
    noTool: !session.mock && assignments.some((assignment) => assignment.tool === null),
  };
}

/** The remotes of the repository at `repo`. */
export async function remotesOf(repo: string): Promise<string[]> {
  return (await git(repo, ["remote"])).split("\n").map((line) => line.trim()).filter(Boolean);
}

/** The branch names a new branch must not take: this repository's, and the remote's it is pushed to. */
export async function branchesOf(repo: string, remote: string): Promise<string[]> {
  const local = await git(repo, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]);
  const remoteRefs = remote === THIS_REPOSITORY ? "" : await git(repo, ["for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/${remote}`]);
  return [...local.split("\n"), ...remoteRefs.split("\n")].filter(Boolean);
}

/** How many files differ from the last commit: the agents never see them. */
export async function uncommittedIn(repo: string): Promise<number> {
  return (await git(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
}
