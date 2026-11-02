// `ahp "<task>" --yes`: the task of the app's summary, started without it. The workflow is worked out from the project
// (`inferCommands`) and this machine's tools (`castRoles`), said once with where each answer came from, and run like any other.
// There is nobody to ask, so what cannot be worked out is an error that names the flag that answers it, and the run starts
// only with `--yes`. Nothing is written but the run's ledger, and `--save`'s file when asked for.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { diagnose, TOOLS, type DoctorReport, type RoleAssignment, type ToolId } from "../doctor/index.ts";
import { THIS_REPOSITORY } from "../protocol/index.ts";
import { locateRepo, settingsPath } from "../runtime/index.ts";
import { runWorkflow } from "../sdk/index.ts";
import { branchFor, castRoles, effortsFor, inferCommands, YOUR_DEFAULT, type Inferred } from "../setup/index.ts";
import { markRealAgentsNoticed, readSettings } from "../setup/settings.ts";
import { precheck } from "../setup/precheck.ts";
import { isHomeFolder } from "../setup/repository.ts";
import { buildTaskRun, CHECK_FROM_FLAG, mockCasting, stepsOf, type TaskRun } from "../setup/task.ts";
import { checkStepFlags, stepFlagsOf, UsageError, type StepFlags, type Values } from "./args.ts";
import { branchesOf, remotesOf as remotesIn, uncommittedIn, toolNameOf, unusableBecause } from "./task.ts";
import { saveTaskWorkflow, workflowFileName, WorkflowFileExistsError } from "./workflow-file.ts";
import { exitCodeOf, followRun, type Io } from "./stream.ts";

/** Why the repository around `dir` cannot be used, before anything starts. Echoes the repository it will use. */
export async function repositoryOf(dir: string, named: boolean, io: Io): Promise<string> {
  let top: string;
  try {
    top = (await locateRepo(dir)).repo;
  } catch {
    throw new UsageError(`${dir} is not in a git repository: run ahp in your project's folder, or pass --repo <dir> (a folder becomes one with \`git init\` and a first commit)`);
  }
  if (!named && (await isHomeFolder(top))) {
    throw new UsageError(`the git repository around ${dir} is your home folder (${top}), which is rarely the project you mean: run ahp in your project's folder, or pass --repo "${top}" if it is`);
  }
  io.stdout(`repository: ${top}`);
  return top;
}

/**
 * Refuses, before any agent starts, a workflow that publishes to a remote the repository does not have: it would fail
 * only at its last step, after every agent's work. `.` is the repository itself and always there.
 */
export async function checkRemotes(workflow: { steps: { id: string; action?: { remote?: string } }[] }, repo: string): Promise<void> {
  const have = await remotesIn(repo);
  for (const step of workflow.steps) {
    if (!step.action) continue;
    const remote = step.action.remote ?? "origin";
    if (remote === THIS_REPOSITORY || have.includes(remote)) continue;
    throw new UsageError(
      `step "${step.id}" publishes to the remote "${remote}", which this repository does not have: add it (\`git remote add ${remote} <url>\`), or set the step's \`action.remote\` to "." to put the approved work on a branch in this repository`,
    );
  }
}

/** The casting with the step flags applied: a new tool drops the model and effort cast for the old one. */
export function withStepFlags(assignments: RoleAssignment[], flags: StepFlags, report: DoctorReport): RoleAssignment[] {
  return assignments.map((assignment) => {
    const change = flags[assignment.role];
    if (!change) return assignment;
    let changed = assignment;
    if (change.tool !== undefined && change.tool !== assignment.tool) {
      const tool = change.tool as ToolId;
      const why = unusableBecause(report, tool);
      if (why !== null) throw new UsageError(`--${assignment.role} ${tool}: ${toolNameOf(tool)} is not usable here (${why}; \`ahp doctor\` says more)`);
      changed = { role: assignment.role, adapter: tool, tool, reason: `--${assignment.role}` };
    }
    if (change.model !== undefined) changed = { ...changed, model: change.model.trim(), reason: `--${assignment.role}-model` };
    if (change.effort !== undefined) {
      const efforts = changed.tool === null ? [] : effortsFor(changed.tool);
      const name = changed.tool === null ? "the mock" : toolNameOf(changed.tool);
      if (!efforts.includes(change.effort)) {
        throw new UsageError(`--${assignment.role}-effort ${change.effort}: ${efforts.length > 0 ? `${name}'s efforts are ${efforts.join(", ")}` : `${name} has no effort setting`}`);
      }
      changed = { ...changed, effort: change.effort, reason: `--${assignment.role}-effort` };
    }
    return changed;
  });
}

const COLUMN = 26;

/** What the task is about to do, every answer with where it came from: a wrong guess is in the log beside the run. */
export function summaryLines(run: TaskRun, uncommitted: number): string[] {
  const row = (label: string, value: string, note = "") => `  ${label.padEnd(10)} ${note ? value.padEnd(COLUMN) : value}${note ? `${value.length >= COLUMN ? "  " : " "}${note}` : ""}`;
  const where = (found: Inferred) => (found.source === "typed" ? "typed by you" : found.source);
  const lines = [row("task", run.task)];
  if (run.check) {
    lines.push(row("check", run.check.command, where(run.check)));
    if (run.install) lines.push(row("install", run.install.command, where(run.install)));
  } else {
    lines.push(row("check", "none: review only", "not verified"));
  }
  for (const assignment of run.assignments) {
    const player = assignment.tool === null ? "mock" : toolNameOf(assignment.tool);
    const model = assignment.tool === null ? "scripted, not a real agent" : `${assignment.model ?? "default model"}${assignment.effort ? `, effort ${assignment.effort}` : ""}`;
    const note = assignment.reason === YOUR_DEFAULT ? " · your default" : assignment.reason.startsWith(`${YOUR_DEFAULT}, `) ? ` · ${assignment.reason.split(";")[0]}` : "";
    lines.push(row(assignment.role, player, `${model}${assignment.tool === null ? "" : note}`));
  }
  lines.push(row("result", run.remote === THIS_REPOSITORY ? `branch ${run.branch}, local only` : `branch ${run.branch}, pushed to ${run.remote} once you approve`));
  if (uncommitted > 0) lines.push(row("note", `${uncommitted} ${uncommitted === 1 ? "file" : "files"} not committed: the agents will not see them`));
  return lines;
}

/** Everything a task settles before an agent starts: the repository, the run it is, and the workflow that run is. */
export interface PreparedTask {
  repo: string;
  run: TaskRun;
  workflow: ReturnType<typeof buildTaskRun>;
}

/**
 * Works out the task from the project, the machine and the flags, says it (the summary, the first real-agents notice, a
 * check that already fails, the file saved) and starts nothing. Every refusal is thrown from here, before any agent.
 */
export async function prepareTask(task: string, values: Values, dir: string, io: Io): Promise<PreparedTask> {
  if (values.yes !== true) throw new UsageError("a task runs only once you say so: pass --yes (the app, `ahp`, shows what it will do and asks)");
  const mock = values.mock === true;
  const noCheck = values["no-check"] === true;
  const check = typeof values.check === "string" ? values.check.trim() : null;
  if (noCheck && check !== null) throw new UsageError("--no-check and --check cannot be used together: name a command, or ask for review only");
  const steps = stepFlagsOf(values as Record<string, string | boolean | undefined>);
  // Any plan flag asks for the plan step: naming its tool, model or effort means wanting it.
  const plan = values.plan !== undefined || steps.plan !== undefined;
  checkStepFlags(steps, mock);
  let save: string | null = null;
  if (typeof values.save === "string") {
    const named = workflowFileName(values.save);
    if ("error" in named) throw new UsageError(`--save: ${named.error}`);
    save = resolve(dir, named.name);
    if (existsSync(save)) throw new UsageError(`${save} already exists; --save never replaces a file`);
  }

  const repo = await repositoryOf(dir, values.repo !== undefined, io);
  const roles = stepsOf(plan);
  let assignments: RoleAssignment[];
  let report: DoctorReport | null = null;
  let realAgentsNoticed = true;
  if (mock) {
    assignments = mockCasting(roles);
  } else {
    report = await diagnose();
    // The person's saved defaults, never read by `ahp run` or `ahp eval`.
    const saved = await readSettings(settingsPath());
    if (saved.problem) io.stdout(`your saved defaults were not used: ${saved.problem}`);
    realAgentsNoticed = saved.settings.realAgentsNoticed === true;
    const cast = castRoles(report, saved.settings.steps);
    assignments = withStepFlags(roles.map((role) => cast.find((assignment) => assignment.role === role)!), steps, report);
    if (assignments.some((assignment) => assignment.tool === null)) {
      throw new UsageError(
        [
          "no coding agent tool is usable here (`ahp doctor` says why). Install one and log in with your own account:",
          ...TOOLS.map((tool) => `  ${tool.name.padEnd(12)} ${tool.install}, then ${tool.logIn}`),
          "`--mock` runs scripted agents that show the flow and do none of the work.",
        ].join("\n"),
      );
    }
  }
  const found = inferCommands(repo);
  const checking: Inferred | null = noCheck ? null : check === null ? found.check : { command: check, source: CHECK_FROM_FLAG };
  if (checking === null && !noCheck) {
    throw new UsageError("this project names no command that checks the work (no test script, pytest, cargo, go or make test target): pass --check <command>, or --no-check for review only");
  }
  const remote = typeof values.push === "string" ? values.push : THIS_REPOSITORY;
  const run: TaskRun = { task, check: checking, install: checking === null ? null : found.install, assignments, branch: branchFor(task, await branchesOf(repo, remote)), remote };
  const workflow = buildTaskRun(run);
  await checkRemotes(workflow, repo);
  for (const line of summaryLines(run, await uncommittedIn(repo))) io.stdout(line);
  if (!mock && !realAgentsNoticed) {
    io.stdout("  ! first run with real agents: they run commands on this machine, and their usage counts against your own plans");
    await markRealAgentsNoticed(settingsPath());
  }
  if (run.check !== null && values["no-precheck"] !== true) {
    const before = await precheck(repo, run.check.command, run.install?.command ?? null);
    if (!before.passed) io.stdout(`  ! the check already fails on your last commit: ${before.line}`);
  }
  if (save !== null) {
    try {
      await saveTaskWorkflow(dir, values.save as string, run);
    } catch (error) {
      if (error instanceof WorkflowFileExistsError) throw new UsageError(`${save} already exists; --save never replaces a file`);
      throw error;
    }
    io.stdout(`saved the workflow to ${save}: \`ahp run\` runs it again`);
  }
  return { repo, run, workflow };
}

/** `ahp "<task>"`: see the head of this file. */
export async function taskCommand(task: string, values: Values, dir: string, io: Io): Promise<number> {
  const { repo, workflow } = await prepareTask(task, values, dir, io);
  const { state } = await followRun(io, (following) => runWorkflow(workflow, { repo, ...following }));
  return exitCodeOf(state);
}
