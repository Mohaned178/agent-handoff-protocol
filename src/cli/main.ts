import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REMOTE, isRemoteName, RECOVERY_ACTIONS, THIS_REPOSITORY, type LedgerEvent, type RecoveryAction, type RunView } from "../protocol/index.ts";
import {
  approveStep,
  DISCARD_AND_RETRY_DEFERRED,
  inspectRun,
  isAttemptId,
  listRuns,
  isRunId,
  recoverAttempt,
  rejectStep,
  resumeRun,
  runWorkflow,
  validateWorkflow,
} from "../sdk/index.ts";
import { assignRoles, diagnose, initWorkflow, publishRemoteOf, ROLES, TOOL_IDS, TOOLS, type DoctorReport, type Role, type RoleAssignment, type ToolId } from "../doctor/index.ts";
import { API_KEY_NOTICE, formatReport, isSeed, runEvaluation, SuiteInvalidError, TaskInvalidError, type EvaluationEvent, type EvaluationSuite, type EvaluationView } from "../evaluation/index.ts";
import { demosRoot, evaluationsRoot, git, locateRepo, settingsPath, toolCallLogPath, transcriptPaths } from "../runtime/index.ts";
import { changesBetween, describeChanges, diffBetween, formatDiff } from "./diff.ts";
import { watchProgress } from "./progress.ts";
import { describeApprovalChoices, formatEvent, formatReceipt, formatRun, formatRuns, formatUnresumed, MOCK_NOTE } from "./format.ts";
import { precheck } from "./precheck.ts";
import { formatBriefReceipt, nextStepOf } from "./receipt.ts";
import { LiveView, type Terminal } from "./live.ts";
import { formatDoctor, formatInit } from "./format-doctor.ts";
import { formatEvaluationEvent } from "./format-evaluation.ts";
import {
  branchFor,
  buildTaskRun,
  castRole,
  castRoles,
  clearSettings,
  effortsFor,
  formatSettings,
  markRealAgentsNoticed,
  readSettings,
  saveStepDefault,
  YOUR_DEFAULT,
  type RoleDefault,
  type SetupOptions,
  type SettingsRead,
  CHECK_FROM_FLAG,
  CHECK_TYPED,
  formatTaskSummary,
  inferCommands,
  mockCasting,
  modelsFor,
  prepareDemo,
  renderTaskRun,
  runSetup,
  stepsOf,
  terminalPrompter,
  writeNew,
  type Inferred,
  type Prompter,
  type TaskRun,
} from "../setup/index.ts";

const USAGE = `Usage: ahp <command> [options]
       ahp "<task>" [--plan [<tool>]] [--<step> <tool>] [--check <command>] [--push [<remote>]] [--yes]

Commands:
  "<task>"              Do a task, in words (in quotes, more than one word): AHP works out the check
                        command, the install command and who plays each step from the project and your
                        tools, shows them, and runs implement → review → your approval once you say
                        Run; the approved work goes on a local branch. Nothing runs before you say so
  (no command)          In a terminal, the same as setup; otherwise how to get started
  demo                  Try AHP in a sample project it makes, with nothing to set up: scripted agents, free;
                        --real casts your own installed tools instead (their usage counts)
  doctor                Report this machine and which coding agent tools AHP can use (--json for data)
  init [file]           Write the password-reset example workflow (default ahp.workflow.mjs), cast from
                        the tools doctor found, the mock adapter standing in for any it did not
  setup                 Choose, in menus, a workflow or an evaluation and the tool and model of each
                        step; writes the file (never replacing one) and offers to start it. A folder that
                        is not a git repository, or has no commit yet, is offered one first
  run <workflow-file>   Run the workflow exported by default from <workflow-file>
  eval <suite-file>     Run the evaluation suite exported by default from <suite-file>: its tasks are frozen,
                        then each runs under conditions C0-C3 and the matched-budget baseline, repeated, in a
                        shuffled order, each trial scored by independent validators, conditions compared by task
  settings              Print the tool, model and effort you chose to keep for each step of a task, and
                        where they are kept; --clear removes them
  runs                  List this repository's runs, newest first, with what to do next for any that waits
  inspect [run-id]      Show a run's state, derived from its ledger, and who is writing it (default: the newest run)
  recover <run-id>      Resume a run whose process stopped; an attempt it left with no
                        record of how it ended becomes unknown and gets a recovery report
  recover <attempt-id> --policy adopt|abort
                        Decide an attempt that awaits recovery, then resume its run: adopt
                        verifies its workspace as its result, abort ends its step
  approve <run-id> <step-id>
                        Approve the gate a run is waiting at, then resume the run
  reject <run-id> <step-id> --reason <text>
                        Reject it: the step before the gate is sent back with your reason

Options:
  --repo <dir>          The git repository to use (default: the current directory)
  --out <dir>           eval: where the evaluation is kept (default: AHP's per-user directory)
  --seed <n>            eval: the seed of the trial order and of the comparisons, 0 to 4294967295 (default: drawn)
  --json                inspect: print the derived state, the ledger check and the run's lock as JSON;
                        runs: every run as JSON; doctor: print the report as JSON; eval: print only the report, as JSON
  --all                 runs: list every run, not only the newest 20; --help: print this whole list
  --policy <decision>   recover: adopt or abort
  --reason <text>       reject: why the work is rejected (required)
  --diff                run, recover, approve, reject: print the whole diff of every attempt (each attempt
                        always shows which files it changed; an approval gate always shows its diff)
  --verbose             run, recover, approve, reject: print every event of the run, as when the output is
                        not a terminal, instead of one line per step
  --real                demo: use your own installed coding agent tools instead of the scripted mock
  --plan [<tool>]       task: a plan step (read-only) before implement, by <tool> if named
  --implement <tool>, --review <tool>
                        task: who does the step: claude-code, codex or opencode (for this run only)
  --<step>-model <name>, --<step>-effort <level>
                        task: the step's model and effort, for plan, implement or review (this run only;
                        "Change something" in the summary can keep a choice for next time)
  --clear               settings: remove the saved defaults
  --check <command>     task: the command that checks the work, instead of the one AHP finds (needed
                        without a terminal when the project names none)
  --push [<remote>]     task: push the approved branch to origin, or to <remote>, instead of making a
                        local branch
  -y, --yes             task: run without asking (needed without a terminal)
  --save <file>         task: also write the workflow to <file>, for \`ahp run\` to run again
  --mock                task: scripted agents that show the flow and do none of the work (no evidence)
  --no-precheck         task: start the agents without first running the check once on your last commit
  -h, --help            Show the commands to start with (--help --all: this whole list)
  -v, --version         Show the version

Ctrl+C during run, recover, approve or reject cancels the run: the running agent and every
process it started are stopped, and the run ends cancelled. Ctrl+C during eval cancels the
trial in hand and starts no other.

Exit codes: 0 the run succeeded (eval: the evaluation completed, whatever its trials found),
1 it failed or ahp failed (eval: it stopped because a frozen task changed), 2 usage error,
3 the run stopped for a recovery decision, 4 the run stopped at an approval gate,
130 the run was cancelled`;

/** What `ahp --help` prints: the commands a new user needs first; `USAGE` (`--help --all`) is the whole reference. */
const SHORT_USAGE = `Usage: ahp "<task>" [options]
       ahp <command> [options]

Start here:
  "<task>"              Do a task, in words (in quotes): AHP works out the check, the install and who does
                        each step, shows them, and runs implement → review → your approval once you say Run
  demo                  Try AHP in a sample project it makes: scripted agents, free (--real uses your tools)
  doctor                Show which coding agent tools AHP can use here, and how to install or log in to the rest

Follow a run:
  runs                  This repository's runs, newest first, with what to do next for any that waits
  inspect [run-id]      A run's receipt, then every attempt, check and handoff (default: the newest run)
  approve <run-id> <step-id>
                        Approve the gate a run is waiting at
  reject <run-id> <step-id> --reason <text>
                        Reject it: the step before the gate is sent back with your reason

Options for a task:
  --plan [<tool>]       Add a read-only plan step first
  --implement <tool>, --review <tool>
                        Who does the step: claude-code, codex or opencode (this run only)
  --check <command>     The command that checks the work, instead of the one AHP finds
  --push [<remote>]     Push the approved branch to origin, or <remote>, instead of a local branch
  -y, --yes             Run without asking (needed without a terminal)
  --mock                Scripted agents that show the flow and do none of the work

Every command and option (setup, run, recover, eval, settings, models, efforts, exit codes): ahp --help --all`;

/** What `ahp` alone prints: the three commands a new user needs, not the whole reference. */
const GETTING_STARTED = `AHP runs AI coding agents one after another (plan, implement, review), checks each step's
work with your tests, and keeps only what you approve.

  Try it, with nothing to set up:   ahp demo
                                    (free: scripted agents; \`ahp demo --real\` uses your own tools)
  Do a task in your project:        cd your-project, then ahp "fix the bug where the cart total ignores quantity"
                                    (it works out the check and who builds it, shows them, and runs once you say so)
  Write a workflow to keep:         cd your-project, then ahp
                                    (in a terminal it asks what to build and who builds it, then runs it)

More commands: ahp --help (every command and option: ahp --help --all)`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Set when stdout is a terminal (and not CI): runs get the compact view, and a gate is decided in place. */
  terminal?: Terminal;
}

const stdout = (text: string) => void process.stdout.write(`${text}\n`);
const defaultIo: Io = {
  stdout,
  stderr: (text) => process.stderr.write(`${text}\n`),
  ...(process.stdout.isTTY === true && !process.env.CI
    ? {
        terminal: {
          write: (text: string) => void process.stdout.write(text),
          columns: () => process.stdout.columns ?? 80,
          color: !process.env.NO_COLOR,
          compact: true,
          prompter: process.stdin.isTTY === true ? terminalPrompter(stdout) : null,
        },
      }
    : {}),
};

/**
 * A problem with how ahp was invoked; exits 2. The whole usage is printed only when the command itself is missing or
 * unknown: after any other mistake it would bury the one line that says what is wrong.
 */
class UsageError extends Error {
  readonly showUsage: boolean;
  constructor(message: string, { showUsage = false } = {}) {
    super(message);
    this.showUsage = showUsage;
  }
}

const COMMANDS = ["doctor", "init", "setup", "demo", "run", "eval", "runs", "inspect", "recover", "approve", "reject", "settings"];

/**
 * Whether the first argument is a task rather than a command (spec D1): not a command, and more than one word. A single
 * word that is not a command stays an unknown command, so a misspelt one never starts agents.
 */
const isTask = (argument: string) => !COMMANDS.includes(argument) && argument.trim().split(/\s+/).length > 1;

/**
 * The two options whose value may be left out, which `parseArgs` cannot express, written with their value: `--push`
 * alone means origin and `--push <remote>` that remote; `--plan` alone adds the plan step and `--plan <tool>` casts it
 * too. What follows is the value only when it could be one: a task has spaces in it.
 */
function withOptionalValues(argv: readonly string[]): string[] {
  return argv.map((arg, index) => {
    const next = argv[index + 1];
    const value = next !== undefined && !next.startsWith("-") && !/\s/.test(next) ? next : null;
    if (arg === "--push") return value !== null && isRemoteName(value) && value !== THIS_REPOSITORY ? arg : `--push=${DEFAULT_REMOTE}`;
    if (arg === "--plan") return value !== null ? arg : "--plan=";
    return arg;
  });
}

/** `--<step>`, `--<step>-model` and `--<step>-effort`: a step's tool, model and effort for one run, never saved. */
type StepFlags = Partial<Record<Role, { tool?: string; model?: string; effort?: string }>>;

function stepFlagsOf(values: Record<string, string | boolean | undefined>): StepFlags {
  const flags: StepFlags = {};
  for (const role of ROLES) {
    const tool = role === "plan" ? values.plan || undefined : values[role];
    const [model, effort] = [values[`${role}-model`], values[`${role}-effort`]];
    if (tool === undefined && model === undefined && effort === undefined) continue;
    flags[role] = { ...(typeof tool === "string" ? { tool } : {}), ...(typeof model === "string" ? { model } : {}), ...(typeof effort === "string" ? { effort } : {}) };
  }
  return flags;
}

/** Refuses step flags that are wrong whatever is installed, before anything runs; whether a tool is usable is checked later. */
function checkStepFlags(flags: StepFlags, mock: boolean): void {
  const given = Object.keys(flags);
  if (mock && given.length > 0) throw new UsageError(`--mock casts every step: leave out --mock, or the flags for ${given.join(", ")}`);
  for (const [role, change] of Object.entries(flags)) {
    if (change.tool !== undefined && !TOOL_IDS.includes(change.tool as ToolId)) {
      throw new UsageError(`--${role} must name ${TOOL_IDS.slice(0, -1).join(", ")} or ${TOOL_IDS.at(-1)}, not ${change.tool}`);
    }
    if (change.model !== undefined && change.model.trim() === "") throw new UsageError(`--${role}-model needs a model's name`);
  }
}

/** Why a tool cannot be cast here, as `ahp setup`'s menu says it, or null when it can. */
function unusableBecause(report: DoctorReport, tool: ToolId): string | null {
  const found = report.tools.find((candidate) => candidate.id === tool);
  if (found?.usable) return null;
  return !found?.installed ? "not installed" : !found.adapter ? "no adapter in this build" : found.login.state === "not_logged_in" ? "not logged in" : "not usable";
}

const toolNameOf = (tool: ToolId) => TOOLS.find((definition) => definition.id === tool)!.name;

/** The casting with the step flags applied: a new tool drops the model and effort cast for the old one. */
function withStepFlags(assignments: RoleAssignment[], flags: StepFlags, report: DoctorReport): RoleAssignment[] {
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

/** Runs the `ahp` CLI and returns its exit code: see `USAGE`. */
export async function main(argv: string[], given: Io = defaultIo): Promise<number> {
  let io = given;
  try {
    const { values, positionals } = parseArgs({
      args: withOptionalValues(argv),
      allowPositionals: true,
      options: {
        yes: { type: "boolean", short: "y" },
        plan: { type: "string" },
        implement: { type: "string" },
        review: { type: "string" },
        "plan-model": { type: "string" },
        "implement-model": { type: "string" },
        "review-model": { type: "string" },
        "plan-effort": { type: "string" },
        "implement-effort": { type: "string" },
        "review-effort": { type: "string" },
        clear: { type: "boolean" },
        push: { type: "string" },
        check: { type: "string" },
        save: { type: "string" },
        mock: { type: "boolean" },
        "no-precheck": { type: "boolean" },
        repo: { type: "string" },
        out: { type: "string" },
        seed: { type: "string" },
        json: { type: "boolean" },
        policy: { type: "string" },
        reason: { type: "string" },
        diff: { type: "boolean" },
        verbose: { type: "boolean" },
        all: { type: "boolean" },
        real: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    if (values.verbose && io.terminal) io = { ...io, terminal: { ...io.terminal, compact: false } };
    const repo = resolve(values.repo ?? process.cwd());
    const [command, target, step, ...extra] = positionals;

    if (values.help) {
      io.stdout(values.all ? USAGE : SHORT_USAGE);
      return 0;
    }
    if (values.version) {
      io.stdout(version());
      return 0;
    }
    if (command === undefined) {
      // Someone at a terminal is asked what to run; a pipe or a script gets the guide.
      if (!io.terminal?.prompter) {
        io.stdout(GETTING_STARTED);
        return 0;
      }
      io.stdout("ahp: setting up a run for this folder (`ahp --help` lists the commands; `ahp demo` tries AHP with nothing to set up)");
      return await setupCommand(repo, io);
    }
    if (isTask(command)) {
      if (target !== undefined) throw new UsageError(`unexpected argument: ${target} (a task is one argument, in quotes)`);
      const { yes = false, push, check, save, mock = false } = values;
      const steps = stepFlagsOf(values);
      // Any plan flag asks for the plan step: naming its tool, model or effort means wanting it.
      const plan = values.plan !== undefined || steps.plan !== undefined;
      return await taskCommand(command.trim(), { yes, plan, push: push ?? null, check: check?.trim() || null, save: save ?? null, mock, steps, noPrecheck: values["no-precheck"] ?? false }, repo, values.repo !== undefined, io, values.diff ?? false);
    }
    if (!COMMANDS.includes(command) && target !== undefined) {
      // Words given unquoted arrive one by one: the first is not a command, and must never be read as a task's start.
      throw new UsageError(`unknown command: ${command} (a task is one argument, in quotes: ahp "${positionals.join(" ")}")`);
    }
    const deciding = command === "approve" || command === "reject";
    // Only a decision takes a second argument, the gate's step ID.
    if (extra.length > 0 || (step !== undefined && !deciding)) throw new UsageError(`unexpected argument: ${extra[0] ?? step}`);
    switch (command) {
      case "doctor":
        if (target) throw new UsageError(`unexpected argument: ${target}`);
        return await doctorCommand(values.json ?? false, io);
      case "init":
        return await initCommand(target, repo, io);
      case "setup":
        if (target) throw new UsageError(`unexpected argument: ${target}`);
        return await setupCommand(repo, io);
      case "demo":
        if (target) throw new UsageError(`unexpected argument: ${target}`);
        return await demoCommand(values.real ?? false, io);
      case "settings":
        if (target) throw new UsageError(`unexpected argument: ${target}`);
        return await settingsCommand(values.clear ?? false, io);
      case "run":
        if (!target) throw new UsageError("run needs a workflow file");
        return await runCommand(target, repo, values.repo !== undefined, io, values.diff ?? false);
      case "eval":
        if (!target) throw new UsageError("eval needs a suite file");
        return await evalCommand(target, values.out, seedOf(values.seed), values.json ?? false, io);
      case "runs":
        if (target) throw new UsageError(`unexpected argument: ${target}`);
        return await runsCommand(repo, values.all ?? false, values.json ?? false, io);
      case "inspect":
        return await inspectCommand(target, repo, values.json ?? false, io);
      case "recover":
        if (!target) throw new UsageError("recover needs a run ID, or an attempt ID and --policy");
        return await recoverCommand(target, values.policy, repo, io, values.diff ?? false);
      case "approve":
      case "reject":
        return await decideCommand(command, target, step, values.reason, repo, io, values.diff ?? false);
      default:
        throw new UsageError(`unknown command: ${command}`, { showUsage: true });
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      const usage = error instanceof UsageError && !error.showUsage ? "(`ahp --help` lists the commands and options)" : SHORT_USAGE;
      io.stderr(`ahp: ${(error as Error).message}\n\n${usage}`);
      return 2;
    }
    io.stderr(`ahp: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * The exit code for a run in `state`: 0 succeeded, 3 stopped for a recovery decision, 4 stopped at an approval gate, 130
 * cancelled, 1 anything else.
 */
function exitCodeOf(state: Readonly<RunView>): number {
  switch (state.state) {
    case "succeeded":
      return 0;
    case "needs_recovery":
      return 3;
    case "waiting_approval":
      return 4;
    case "cancelled":
      // What a shell reports for a command Ctrl+C stopped: 128 + SIGINT.
      return 130;
    default:
      return 1;
  }
}

interface Following {
  onEvent: (event: LedgerEvent, state: Readonly<RunView>) => void;
  /** Aborted on Ctrl+C (SIGINT) or SIGTERM: the run is cancelled. */
  signal: AbortSignal;
}

/**
 * Streams a progress line for each event `execute` records, and the mock note at the end if any came from the mock
 * adapter, also when `execute` throws partway. Ctrl+C meanwhile cancels the run instead of killing ahp, so the agent's
 * processes are stopped and the cancel is recorded; a second Ctrl+C only says that it is under way.
 */
async function followRun<R>(io: Io, repo: string, execute: (following: Following) => Promise<R>, options: { diff?: boolean; continued?: boolean } = {}): Promise<R> {
  let usedMock = false;
  let waitsHere = false;
  let last: Readonly<RunView> | null = null;
  const interrupt = cancelOnInterrupt(io, "the run", "waiting until the agent and every process it started are seen gone");
  // While an agent runs, what it does and that it is alive (`progress.ts`), until its attempt has an end.
  let watching: { attemptId: string; stop: () => void } | null = null;
  const location = locateRepo(repo).catch(() => null);
  const stopWatching = () => {
    watching?.stop();
    watching = null;
  };
  // Lines that need git (what a snapshot changed, the diff at a gate) are read as their event arrives; every event's
  // lines go through one queue so they still print in order.
  const color = io.terminal?.color ?? false;
  // In a terminal, one line per step (`live.ts`); else every event's line, as before.
  const live = io.terminal?.compact
    ? new LiveView(io.terminal, {
        repo,
        heading: !options.continued,
        changesOf: async (commit) => {
          const found = await location;
          return found ? describeChanges(await changesBetween(found.repo, `${commit}^`, commit)) : null;
        },
      })
    : null;
  const emit = live ? (text: string) => live.say(text, io.stdout) : io.stdout;
  let printing = Promise.resolve();
  const print = (lines: () => Promise<string | null> | string | null) => {
    printing = printing
      .then(async () => {
        const text = await lines();
        if (text !== null) emit(text);
      })
      .catch(() => undefined);
  };
  try {
    return await execute({
      signal: interrupt.signal,
      onEvent: (event, current) => {
        usedMock = current.mock;
        last = current;
        // A person will be asked at the gate here, and the run goes on: the mock note waits for its end.
        waitsHere = current.state === "waiting_approval" && live !== null && io.terminal?.prompter != null;
        const text = formatEvent(event, current);
        if (live && event.type === "approval_requested") {
          print(async () => {
            const found = await location;
            const lines: string[] = [];
            let changes: string | null = null;
            if (found) {
              try {
                changes = describeChanges(await changesBetween(found.repo, current.baseCommit, event.commit));
                const diff = await diffBetween(found.repo, current.baseCommit, event.commit);
                if (diff) lines.push(formatDiff(diff, { color, more: `ahp inspect ${current.runId}`, brief: true }));
              } catch {
                // The diff is shown where it can be read; the decision does not depend on it.
              }
            }
            lines.unshift(live.approvalHeading(changes));
            if (!io.terminal?.prompter) lines.push(`  ${describeApprovalChoices(current.runId, event.stepId)}`);
            return lines.join("\n");
          });
        } else if (live) {
          for (const output of live.onEvent(event, current)) print(typeof output === "function" ? output : () => output);
          if (options.diff && event.type === "workspace_snapshot_committed") {
            print(async () => {
              const found = await location;
              const diff = found ? await diffBetween(found.repo, `${event.commit}^`, event.commit) : "";
              return diff ? formatDiff(diff, { color, more: `git diff ${short(event.commit)}^ ${short(event.commit)}` }) : null;
            });
          }
        } else if (event.type === "workspace_snapshot_committed") {
          print(async () => {
            const found = await location;
            if (!found) return text;
            try {
              const changes = describeChanges(await changesBetween(found.repo, `${event.commit}^`, event.commit));
              if (!options.diff) return `${text}: ${changes}`;
              const diff = await diffBetween(found.repo, `${event.commit}^`, event.commit);
              return diff ? `${text}: ${changes}\n${formatDiff(diff, { color, more: `git diff ${short(event.commit)}^ ${short(event.commit)}` })}` : `${text}: ${changes}`;
            } catch {
              return text;
            }
          });
        } else if (event.type === "approval_requested") {
          // What is being approved, before the choices: the gate's diff from the run's base to the commit AHP would push.
          print(async () => {
            const found = await location;
            const lines = text.split("\n");
            if (!found) return text;
            try {
              const changes = describeChanges(await changesBetween(found.repo, current.baseCommit, event.commit));
              const diff = await diffBetween(found.repo, current.baseCommit, event.commit);
              const shown = [`  what you are approving: ${changes}`, ...(diff ? [formatDiff(diff, { color, more: `ahp inspect ${current.runId}` })] : [])];
              return [...lines.slice(0, -1), ...shown, lines.at(-1)!].join("\n");
            } catch {
              return text;
            }
          });
        } else {
          print(() => text);
        }
        if (event.type === "attempt_running") {
          stopWatching();
          const { attemptId } = event;
          const stepId = current.steps.find((step) => step.attempts.some((attempt) => attempt.id === attemptId))?.id ?? "?";
          const watch = { attemptId, stop: () => undefined as void };
          watching = watch;
          void location.then((found) => {
            if (!found || watching !== watch) return;
            const files = { output: transcriptPaths(found, current.runId, attemptId).output, toolCalls: toolCallLogPath(found, current.runId, attemptId) };
            // The compact view shows the tool's last call on the step's own line, and its spinner says it is alive.
            watch.stop = live
              ? watchProgress(files, "", (line) => live.activity(stepId, line.replace(/^: /, "")), { heartbeatMs: Number.MAX_SAFE_INTEGER }).stop
              : watchProgress(files, `step ${stepId}: attempt ${attemptId}`, io.stdout).stop;
          });
        } else if ("attemptId" in event && event.attemptId === watching?.attemptId && event.type !== "ref_snapshot_taken") {
          stopWatching();
        }
      },
    });
  } finally {
    stopWatching();
    await printing;
    live?.stop();
    interrupt.release();
    // Once the run stops here, not at a gate the person decides in place: the run goes on then, and says it at its end.
    // What the checks found, and the usage (`receipt.ts`): briefly in the compact view, in full in the plain log.
    if (last && !waitsHere) io.stdout(endOfRun(last, usedMock, live !== null));
  }
}

/**
 * What a run's end says once it stops in this process: in a terminal, a line per check, a line of usage per tool, the
 * one command to run next and a short mock note; elsewhere the full receipt and note, for logs and scripts.
 */
function endOfRun(state: Readonly<RunView>, usedMock: boolean, compact: boolean): string {
  if (!compact) return [formatReceipt(state), ...(usedMock ? [MOCK_NOTE] : [])].join("\n");
  const next = nextStepOf(state);
  return [...formatBriefReceipt(state), ...(next ? [`next: ${next}`] : []), ...(usedMock ? ["scripted mock agents: their results are not evidence"] : [])].map((line) => `  ${line}`).join("\n");
}

/**
 * A run that stopped at an approval gate, with a person at the terminal: they decide it here (approve, reject with a
 * reason, read the whole diff, or leave it for later), and the run goes on as `ahp approve`/`ahp reject` would take it,
 * gate after gate. Without a person, or once they leave it, the exit code says the run waits.
 */
async function decideHere(io: Io, repo: string, state: Readonly<RunView>, diff: boolean): Promise<number> {
  const prompter = io.terminal?.prompter;
  let current = state;
  while (prompter && current.state === "waiting_approval") {
    const gate = current.steps.find((step) => step.kind === "approval_gate" && step.approvals.at(-1)?.decision === null);
    const request = gate?.approvals.at(-1);
    if (!gate || !request) break;
    const { runId } = current;
    const ask = async <T>(question: () => Promise<T>): Promise<T | null> => {
      try {
        return await question();
      } catch (error) {
        if ((error as Error).name === "ExitPromptError") return null;
        throw error;
      }
    };
    const choice = await ask(() =>
      prompter.select({
        message: "Approve this change?",
        choices: [
          { name: "Approve", value: "approve" as const, description: "the run goes on: the steps after the gate run" },
          { name: "Reject", value: "reject" as const, description: "the step before the gate is sent back with your reason" },
          { name: "Show the whole diff", value: "diff" as const },
          { name: "Decide later", value: "later" as const, description: "the run waits; ahp approve or ahp reject decides it" },
        ],
      }),
    );
    if (choice === "diff") {
      const found = await locateRepo(repo);
      const text = await diffBetween(found.repo, request.base, request.commit);
      io.stdout(text ? formatDiff(text, { color: io.terminal?.color ?? false, maxLines: Number.MAX_SAFE_INTEGER, more: "" }) : "  (no changes)");
      continue;
    }
    const reason = choice === "reject" ? await ask(() => prompter.input({ message: "Why? (the agent is given this)", validate: (value) => (value.trim() === "" ? "a reason is needed" : true) })) : undefined;
    if (choice === null || choice === "later" || reason === null) {
      io.stdout(`  ${describeApprovalChoices(runId, gate.id)}`);
      // The run stops here after all: its receipt so far, as `followRun` would have said.
      io.stdout(endOfRun(current, current.mock, io.terminal?.compact === true));
      break;
    }
    ({ state: current } = await followRun(io, repo, (following) =>
      choice === "approve" ? approveStep({ repo, runId, stepId: gate.id, ...following }) : rejectStep({ repo, runId, stepId: gate.id, reason: reason!, ...following }),
    { diff, continued: true }));
  }
  return exitCodeOf(current);
}

const short = (commit: string) => commit.slice(0, 12);

/**
 * Makes Ctrl+C (SIGINT) and SIGTERM abort the returned signal instead of killing ahp, so what is running can be stopped and the
 * cancel recorded; the first says so on stderr, a later one only that it is under way. `release` gives the signals back.
 */
function cancelOnInterrupt(io: Io, what: string, whileWaiting: string): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) {
      io.stderr(`ahp: still cancelling: ${whileWaiting}`);
      return;
    }
    io.stderr(`ahp: cancelling ${what} (Ctrl+C)`);
    controller.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  return {
    signal: controller.signal,
    release: () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}

/** Exit 0 unless Node or git does not meet its requirement; a tool that is missing is reported, not a failure. */
async function doctorCommand(json: boolean, io: Io): Promise<number> {
  const report = await diagnose();
  io.stdout(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

async function initCommand(file: string | undefined, repo: string, io: Io): Promise<number> {
  io.stdout(formatInit(await initWorkflow({ dir: repo, file })));
  return 0;
}

/**
 * `ahp setup`: the questions need a terminal. What it writes is started through the same `run` and `eval` commands, so it
 * runs exactly as the file would by hand. Ctrl+C at a question ends it with nothing started.
 */
async function setupCommand(repo: string, io: Io): Promise<number> {
  const prompter = io.terminal?.prompter;
  if (!prompter) throw new UsageError("setup asks questions: run it in an interactive terminal (or write the file by hand, or use `ahp init`)");
  try {
    if (!(await readyRepository(repo, prompter))) {
      io.stdout("setup stopped: AHP works on a git repository with a commit, and nothing was changed");
      return 0;
    }
    io.stdout("Looking at the tools on this machine (as ahp doctor does)...");
    const result = await runSetup({ prompter, dir: repo, report: await diagnose(), models: (tool) => modelsFor(tool), remote: await publishRemoteOf(repo) });
    const command = result.kind === "workflow" ? `ahp run ${result.path}` : `ahp eval ${result.path}`;
    if (!result.start) {
      io.stdout(`Start it when you are ready: ${command}`);
      return 0;
    }
    io.stdout(`$ ${command}`);
    return result.kind === "workflow" ? await runCommand(result.path, repo, false, io) : await evalCommand(result.path, undefined, undefined, false, io);
  } catch (error) {
    if ((error as Error).name === "ExitPromptError") {
      io.stdout("setup cancelled: nothing was started");
      return 130;
    }
    throw error;
  }
}

/** Whether `path` is the user's home folder, which is rarely the project they mean. */
async function isHomeFolder(path: string): Promise<boolean> {
  const home = await realpath(homedir()).catch(() => homedir());
  const real = await realpath(path).catch(() => path);
  return process.platform === "win32" ? real.toLowerCase() === home.toLowerCase() : real === home;
}

/**
 * Makes `dir` something a run can start from, asking first: a folder that is not in a git repository is offered `git
 * init`, and a repository with no commit yet a first commit of what is in it (AHP's runs start from a commit, and agents
 * see only what is committed). False when the person said no; nothing is changed then. The home folder is never made one.
 */
async function readyRepository(dir: string, prompter: Prompter): Promise<boolean> {
  if (await isHomeFolder(dir)) {
    throw new UsageError(`${dir} is your home folder, not a project: run ahp in your project's folder, or \`ahp demo\` to try AHP with nothing to set up`);
  }
  let top: string | null = await locateRepo(dir).then((found) => found.repo, () => null);
  // A home folder kept under git holds every folder below it: that repository is not the project meant here.
  if (top !== null && (await isHomeFolder(top))) top = null;
  // A first commit is the person's: without a git identity it would fail after they said yes, so it is said first.
  const needsCommit = top === null || !(await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false));
  if (needsCommit) await requireGitIdentity(top ?? dir);
  if (top === null) {
    const yes = await prompter.confirm({ message: `${dir} is not a git repository, which AHP needs. Make it one (git init) and commit what is in it?`, default: true });
    if (!yes) return false;
    await git(dir, ["init", "--quiet"]);
    await firstCommit(dir);
    return true;
  }
  try {
    await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    const yes = await prompter.confirm({ message: `${top} has no commit yet, and a run starts from one. Commit what is in it now?`, default: true });
    if (!yes) return false;
    await firstCommit(top);
    return true;
  }
}

/** Refuses, with the commands that fix it, when git knows no name and email to commit as (`git var` fails then). */
async function requireGitIdentity(dir: string): Promise<void> {
  try {
    await git(dir, ["var", "GIT_AUTHOR_IDENT"]);
    await git(dir, ["var", "GIT_COMMITTER_IDENT"]);
  } catch {
    throw new UsageError(
      'git does not know who you are, and a first commit is made as you. Tell it, then run ahp again:\n  git config --global user.name "Your Name"\n  git config --global user.email you@example.com',
    );
  }
}

/** Commits everything in the repository not ignored, as the user (an empty commit when there is nothing). */
async function firstCommit(repo: string): Promise<void> {
  try {
    await git(repo, ["add", "--all"]);
    await git(repo, ["commit", "--quiet", "--allow-empty", "--message", "First commit"]);
  } catch (error) {
    throw new UsageError(
      `could not make the first commit: ${(error as Error).message}. If git does not know who you are, \`git config --global user.name "Your Name"\` and \`git config --global user.email you@example.com\` tell it`,
    );
  }
}

/**
 * `ahp demo`: the reference scenario in a sample project made for it, run as `ahp run` would. Scripted mock agents unless
 * `--real`, which casts the installed tools as `ahp init` does (and spends their usage).
 */
async function demoCommand(real: boolean, io: Io): Promise<number> {
  const usable = real ? (await diagnose()).tools.filter((tool) => tool.usable).map((tool) => tool.id) : [];
  const assignments = assignRoles(usable);
  const demo = await prepareDemo({ root: demosRoot(), assignments });
  const cast = assignments.map(({ role, adapter }) => `${role} ${adapter}`).join(", ");
  io.stdout(
    [
      "AHP demo: three coding agents build a small password-reset module in a sample project; each step is checked before the next starts, and nothing is pushed until you approve.",
      real
        ? usable.length > 0
          ? `  agents: ${cast} (your own tools: their usage counts)`
          : "  agents: none of your tools is usable here (`ahp doctor` says why), so the scripted mock plays every step"
        : "  agents: scripted mock agents, free and instant; their output is no evidence (`ahp demo --real` uses your own tools)",
      `  project: ${demo.project}`,
      "",
    ].join("\n"),
  );
  const code = await runCommand(demo.workflow, demo.project, true, io);
  io.stdout(
    [
      "",
      `The demo is kept in ${demo.dir}: \`cd ${demo.project}\`, then \`ahp runs\` or \`ahp inspect\` to look at what happened${code === 4 ? ", and `ahp approve` to finish it" : ""}.`,
      "To use AHP on your own code: cd your-project, then ahp",
    ].join("\n"),
  );
  return code;
}

/**
 * The repository a run will use, said before anything starts. git finds a repository by walking up from `dir`, so a
 * folder that is not one can be inside one the user did not mean, a home folder kept under git most often: that one is
 * refused unless `--repo` names it.
 */
async function repositoryOf(dir: string, named: boolean, io: Io): Promise<void> {
  let top: string;
  try {
    top = (await locateRepo(dir)).repo;
  } catch {
    throw new UsageError(`${dir} is not in a git repository: run ahp in your project's folder, or pass --repo <dir> (a folder becomes one with \`git init\` and a first commit)`);
  }
  if (!named && (await isHomeFolder(top))) {
    throw new UsageError(`the git repository around ${dir} is your home folder (${top}), which is rarely the project you mean: run ahp in your project's folder, or pass --repo "${top}" if it is`);
  }
  // The compact view names it in its heading.
  if (!io.terminal?.compact) io.stdout(`repository: ${top}`);
}

async function runCommand(file: string, repo: string, repoNamed: boolean, io: Io, diff = false): Promise<number> {
  const path = resolve(file);
  let workflow: unknown;
  try {
    workflow = ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  } catch (error) {
    throw new UsageError(`cannot load workflow file ${path}: ${(error as Error).message}`);
  }
  const problems = validateWorkflow(workflow);
  if (problems.length > 0) {
    throw new UsageError(`invalid workflow in ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  await repositoryOf(repo, repoNamed, io);
  await remotesOf(workflow as { steps: { id: string; action?: { remote?: string } }[] }, repo);
  const { state } = await followRun(io, repo, (following) => runWorkflow(workflow as Parameters<typeof runWorkflow>[0], { repo, ...following }), { diff });
  return await decideHere(io, repo, state, diff);
}

interface TaskFlags {
  yes: boolean;
  plan: boolean;
  /** The remote `--push` names (origin for a bare `--push`), or null for a local branch (spec D2). */
  push: string | null;
  check: string | null;
  /** `--save`'s file, relative to the repository directory given. */
  save: string | null;
  mock: boolean;
  steps: StepFlags;
  /** `--no-precheck`: start the agents without running the check on the last commit first. */
  noPrecheck: boolean;
}

/**
 * `ahp "<task>"`: the workflow is worked out from the project (`inferCommands`) and this machine's tools (`castRoles`),
 * shown with where each answer came from, and run like any other once the person says Run (or `--yes`). Only what cannot
 * be worked out is asked: the check, when the project names none. Nothing is written but the run's ledger, and `--save`'s
 * file when asked for.
 */
async function taskCommand(task: string, flags: TaskFlags, dir: string, repoNamed: boolean, io: Io, diff: boolean): Promise<number> {
  const prompter = io.terminal?.prompter ?? null;
  if (!prompter && !flags.yes) throw new UsageError("a task runs only once you say so: in a terminal ahp shows what it will do and asks; elsewhere pass --yes");
  checkStepFlags(flags.steps, flags.mock);
  const save = flags.save === null ? null : resolve(dir, flags.save);
  if (save !== null && existsSync(save)) throw new UsageError(`${save} already exists; --save never replaces a file`);
  let run: TaskRun;
  let workflow: ReturnType<typeof buildTaskRun>;
  let repo: string;
  try {
    if (prompter && !(await readyRepository(dir, prompter))) {
      io.stdout("nothing was started: AHP works on a git repository with a commit, and nothing was changed");
      return 0;
    }
    await repositoryOf(dir, repoNamed, io);
    repo = (await locateRepo(dir)).repo;
    const roles = stepsOf(flags.plan);
    let assignments: RoleAssignment[];
    let report: DoctorReport | null = null;
    let saved: SettingsRead | null = null;
    if (flags.mock) {
      assignments = mockCasting(roles);
    } else {
      report = await diagnose();
      // The person's saved defaults (ticket 03), never read by `ahp run` or `ahp eval`.
      saved = await readSettings(settingsPath());
      if (saved.problem) io.stdout(`your saved defaults were not used: ${saved.problem}`);
      const cast = castRoles(report, saved.settings.steps);
      assignments = withStepFlags(roles.map((role) => cast.find((assignment) => assignment.role === role)!), flags.steps, report);
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
    let check: Inferred | null = flags.check === null ? found.check : { command: flags.check, source: CHECK_FROM_FLAG };
    if (check === null) {
      if (!prompter) throw new UsageError("this project names no command that checks the work (no test script, pytest, cargo, go or make test target): pass --check <command>");
      check = await askCheck(prompter);
    }
    const remote = flags.push ?? THIS_REPOSITORY;
    run = { task, check, install: check === null ? null : found.install, assignments, branch: branchFor(task, await branchesOf(repo, remote)), remote };
    workflow = buildTaskRun(run);
    await remotesOf(workflow, repo);
    const uncommitted = (await git(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
    io.stdout(formatTaskSummary(run, uncommitted));
    if (!flags.mock && saved?.settings.realAgentsNoticed !== true) {
      io.stdout("  ! first run with real agents: they run commands on this machine, and their usage counts against your own plans");
      await markRealAgentsNoticed(settingsPath());
    }
    // One setup per command, so OpenCode's access is asked at most once however often a step is changed.
    const changing: (Omit<SetupOptions, "report"> & { report: DoctorReport | null }) | null = prompter ? { prompter, dir: repo, report, models: (tool: ToolId) => modelsFor(tool) } : null;
    while (!flags.yes) {
      const choice = await prompter!.select({
        message: "Run it?",
        choices: [
          { name: "Run", value: "run" as const, description: "the agents start; nothing lands before you approve the diff" },
          { name: "Change something", value: "change" as const, description: "a step's tool, model or effort" },
          { name: "Cancel", value: "cancel" as const },
        ],
      });
      if (choice === "run") break;
      if (choice === "cancel") {
        io.stdout("cancelled: nothing was started");
        return 0;
      }
      changing!.report ??= await diagnose();
      run = { ...run, assignments: await changeStep(run.assignments, changing as SetupOptions) };
      workflow = buildTaskRun(run);
      io.stdout(formatTaskSummary(run, uncommitted));
    }
    if (run.check !== null && !flags.noPrecheck) {
      if (io.terminal) io.stdout(`  checking \`${run.check.command}\` on your last commit…`);
      const found = await precheck(repo, run.check.command, run.install?.command ?? null);
      if (!found.passed) {
        io.stdout(`  ! the check already fails on your last commit: ${found.line}`);
        if (!flags.yes && !(await prompter!.confirm({ message: "Run it anyway? (the agents are asked to make it pass)", default: true }))) {
          io.stdout("cancelled: nothing was started");
          return 0;
        }
      }
    }
  } catch (error) {
    if ((error as Error).name === "ExitPromptError") {
      io.stdout("cancelled: nothing was started");
      return 130;
    }
    throw error;
  }
  if (save !== null) {
    try {
      await writeNew(save, renderTaskRun(run));
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") throw new UsageError(`${save} already exists; --save never replaces a file`);
      throw error;
    }
    io.stdout(`saved the workflow to ${save}: \`ahp run\` runs it again`);
  }
  const { state } = await followRun(io, repo, (following) => runWorkflow(workflow, { repo, ...following }), { diff });
  return await decideHere(io, repo, state, diff);
}

/**
 * The summary's "Change something": a step, then its tool, model and effort in `ahp setup`'s menus, then whether to keep
 * the choice for next time (spec D5: written only on yes). Returns the casting with the change.
 */
async function changeStep(assignments: RoleAssignment[], options: SetupOptions): Promise<RoleAssignment[]> {
  const { prompter } = options;
  const role = await prompter.select({
    message: "Which step?",
    choices: assignments.map((assignment) => ({ name: `${assignment.role.padEnd(10)} ${assignment.tool === null ? "Mock (scripted)" : toolNameOf(assignment.tool)}`, value: assignment.role })),
  });
  const cast = await castRole(options, role, false);
  const chosen: RoleDefault = { tool: cast.tool!, ...(cast.model ? { model: cast.model } : {}), ...(cast.effort ? { effort: cast.effort } : {}) };
  const keep = await prompter.confirm({ message: `Use ${toolNameOf(chosen.tool)} (${[chosen.model ?? "its default model", ...(chosen.effort ? [`effort ${chosen.effort}`] : [])].join(", ")}) for ${role} next time?`, default: false });
  if (keep) await saveStepDefault(settingsPath(), role, chosen);
  return assignments.map((assignment) => (assignment.role === role ? { ...cast, reason: keep ? YOUR_DEFAULT : "changed in the summary" } : assignment));
}

/** `ahp settings`: the saved defaults and where they are kept; with --clear, removes them. */
async function settingsCommand(clear: boolean, io: Io): Promise<number> {
  const path = settingsPath();
  if (clear) {
    io.stdout((await clearSettings(path)) ? `removed the saved defaults (${path})` : `no saved defaults to remove (${path})`);
    return 0;
  }
  io.stdout(formatSettings(path, await readSettings(path)));
  return 0;
}

/** The check for a project that names none (spec D3): a command typed in, or none, the work then being reviewed only. */
async function askCheck(prompter: Prompter): Promise<Inferred | null> {
  const how = await prompter.select({
    message: "This project has no command that checks the work that AHP can find (no test script, pytest, cargo, go or make test target). What checks it?",
    choices: [
      { name: "A command I type", value: "type" as const, description: "the work is done when it exits 0 in a fresh copy of the repository" },
      { name: "None: review only", value: "none" as const, description: "a reviewing agent reads the work; it is labelled not verified" },
    ],
  });
  if (how === "none") return null;
  const command = await prompter.input({ message: "Command that checks the work (exit code 0 means done):", validate: (value) => (value.trim() ? true : "a command, such as npm test or pytest") });
  return { command: command.trim(), source: CHECK_TYPED };
}

/** The branch names a new branch must not take: this repository's, and the remote's it is pushed to. */
async function branchesOf(repo: string, remote: string): Promise<string[]> {
  const local = await git(repo, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]);
  const remoteRefs = remote === THIS_REPOSITORY ? "" : await git(repo, ["for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/${remote}`]);
  return [...local.split("\n"), ...remoteRefs.split("\n")].filter(Boolean);
}

/**
 * Refuses, before any agent starts, a workflow that publishes to a remote the repository does not have: it would fail
 * only at its last step, after every agent's work. `.` is the repository itself and always there.
 */
async function remotesOf(workflow: { steps: { id: string; action?: { remote?: string } }[] }, repo: string): Promise<void> {
  for (const step of workflow.steps) {
    if (!step.action) continue;
    const remote = step.action.remote ?? DEFAULT_REMOTE;
    if (remote === THIS_REPOSITORY) continue;
    try {
      await git(repo, ["remote", "get-url", remote]);
    } catch {
      throw new UsageError(
        `step "${step.id}" publishes to the remote "${remote}", which this repository does not have: add it (\`git remote add ${remote} <url>\`), or set the step's \`action.remote\` to "." to put the approved work on a branch in this repository`,
      );
    }
  }
}

/** The `--seed` given, as a number: decimal digits naming an unsigned 32-bit integer. */
function seedOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seed = /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN;
  if (!isSeed(seed)) throw new UsageError(`--seed must be an integer from 0 to 4294967295, not ${value}`);
  return seed;
}

/**
 * `ahp eval <suite-file>`: loads the suite, runs it and prints the report. Ctrl+C cancels the trial in hand, as for a run. The
 * evaluation's own exit code is 0 when it completed, whatever its trials found: a harness incident or a failed condition is a
 * finding, not a failure of the command.
 */
async function evalCommand(file: string, out: string | undefined, seed: number | undefined, json: boolean, io: Io): Promise<number> {
  const path = resolve(file);
  let suite: unknown;
  try {
    suite = ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  } catch (error) {
    throw new UsageError(`cannot load suite file ${path}: ${(error as Error).message}`);
  }
  // The expectation is stated before anything runs; with --json stdout is the report alone, so it goes to stderr.
  (json ? io.stderr : io.stdout)(API_KEY_NOTICE);
  const interrupt = cancelOnInterrupt(io, "the evaluation", "waiting until the trial in hand and every process it started are seen gone");
  try {
    const result = await runEvaluation(suite as EvaluationSuite, {
      out: out === undefined ? evaluationsRoot() : resolve(out),
      baseDir: dirname(path),
      signal: interrupt.signal,
      ...(seed !== undefined ? { seed } : {}),
      onEvent: (event: EvaluationEvent, state: Readonly<EvaluationView>) => {
        if (!json) io.stdout(formatEvaluationEvent(event, state));
      },
    });
    io.stdout(json ? JSON.stringify(result.report, null, 2) : `\n${formatReport(result.report)}\nkept in ${result.dir}`);
    return result.state.state === "completed" ? 0 : result.state.state === "cancelled" ? 130 : 1;
  } catch (error) {
    // A suite or task that is invalid is a mistake in how ahp was used, as an invalid workflow is.
    if (error instanceof SuiteInvalidError || error instanceof TaskInvalidError) throw new UsageError(`${error.message} (suite file ${path})`);
    throw error;
  } finally {
    interrupt.release();
  }
}

/** `ahp runs`: the repository's runs, newest first; with --json every run, as `listRuns` gives them. */
async function runsCommand(repo: string, all: boolean, json: boolean, io: Io): Promise<number> {
  const listings = await listRuns({ repo });
  io.stdout(json ? JSON.stringify(listings, null, 2) : formatRuns(listings, (await locateRepo(repo)).repo, all));
  return 0;
}

/** `ahp inspect [run-id]`: with no ID, the newest run of the repository. */
async function inspectCommand(given: string | undefined, repo: string, json: boolean, io: Io): Promise<number> {
  const runId = given ?? (await listRuns({ repo }))[0]?.runId;
  if (!runId) throw new UsageError(`no runs in ${(await locateRepo(repo)).repo} yet: \`ahp run <workflow-file>\` starts one`);
  const inspection = await inspectRun({ repo, runId });
  io.stdout(json ? JSON.stringify(inspection, null, 2) : formatRun(inspection));
  return 0;
}

async function recoverCommand(target: string, policy: string | undefined, repo: string, io: Io, diff = false): Promise<number> {
  if (isRunId(target)) {
    if (policy !== undefined) throw new UsageError(`--policy decides an attempt: \`ahp recover <attempt-id> --policy adopt|abort\``);
    const result = await followRun(io, repo, (following) => resumeRun({ repo, runId: target, ...following }), { diff });
    if (!result.resumed) io.stdout(formatUnresumed(result));
    return result.resumed ? await decideHere(io, repo, result.state, diff) : exitCodeOf(result.state);
  }
  if (!isAttemptId(target)) throw new UsageError(`not a run ID or an attempt ID: ${target}`);
  if (policy === undefined) throw new UsageError(`recover ${target} needs --policy adopt or --policy abort`);
  if (policy === "discard_and_retry") throw new UsageError(DISCARD_AND_RETRY_DEFERRED);
  if (!RECOVERY_ACTIONS.includes(policy as RecoveryAction)) throw new UsageError(`--policy must be adopt or abort, not ${policy}`);
  const { state } = await followRun(io, repo, (following) => recoverAttempt({ repo, attemptId: target, policy: policy as RecoveryAction, ...following }), { diff });
  return await decideHere(io, repo, state, diff);
}

/** `ahp approve <run> <step>` and `ahp reject <run> <step> --reason`: a person's decision at the gate a run waits at. */
async function decideCommand(
  command: "approve" | "reject",
  runId: string | undefined,
  stepId: string | undefined,
  reason: string | undefined,
  repo: string,
  io: Io,
  diff = false,
): Promise<number> {
  if (!runId || !stepId) throw new UsageError(`${command} needs a run ID and the approval gate's step ID: ahp ${command} <run-id> <step-id>${command === "reject" ? " --reason <text>" : ""}`);
  if (!isRunId(runId)) throw new UsageError(`not a run ID: ${runId}`);
  if (command === "approve" && reason !== undefined) throw new UsageError("approve takes no --reason; a rejection does: `ahp reject <run-id> <step-id> --reason <text>`");
  if (command === "reject" && (reason === undefined || reason.trim() === "")) throw new UsageError("reject needs --reason <text>: it is sent back with the work");
  const { state } = await followRun(io, repo, (following) =>
    command === "approve" ? approveStep({ repo, runId, stepId, ...following }) : rejectStep({ repo, runId, stepId, reason: reason!, ...following }),
  { diff });
  return await decideHere(io, repo, state, diff);
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
