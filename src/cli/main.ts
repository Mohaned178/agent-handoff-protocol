import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RECOVERY_ACTIONS, type LedgerEvent, type RecoveryAction, type RunView } from "../protocol/index.ts";
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
import { diagnose, initWorkflow } from "../doctor/index.ts";
import { API_KEY_NOTICE, formatReport, isSeed, runEvaluation, SuiteInvalidError, TaskInvalidError, type EvaluationEvent, type EvaluationSuite, type EvaluationView } from "../evaluation/index.ts";
import { evaluationsRoot, locateRepo, toolCallLogPath, transcriptPaths } from "../runtime/index.ts";
import { changesBetween, describeChanges, diffBetween, formatDiff } from "./diff.ts";
import { watchProgress } from "./progress.ts";
import { describeApprovalChoices, formatEvent, formatRun, formatRunUsage, formatRuns, formatUnresumed, MOCK_NOTE } from "./format.ts";
import { LiveView, type Terminal } from "./live.ts";
import { formatDoctor, formatInit } from "./format-doctor.ts";
import { formatEvaluationEvent } from "./format-evaluation.ts";
import { modelsFor, runSetup, terminalPrompter } from "../setup/index.ts";

const USAGE = `Usage: ahp <command> [options]

Commands:
  doctor                Report this machine and which coding agent tools AHP can use (--json for data)
  init [file]           Write the password-reset example workflow (default ahp.workflow.mjs), cast from
                        the tools doctor found, the mock adapter standing in for any it did not
  setup                 Choose, in menus, a workflow or an evaluation and the tool and model of each
                        step; writes the file (never replacing one) and offers to start it
  run <workflow-file>   Run the workflow exported by default from <workflow-file>
  eval <suite-file>     Run the evaluation suite exported by default from <suite-file>: its tasks are frozen,
                        then each runs under conditions C0-C3 and the matched-budget baseline, repeated, in a
                        shuffled order, each trial scored by independent validators, conditions compared by task
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
  --all                 runs: list every run, not only the newest 20
  --policy <decision>   recover: adopt or abort
  --reason <text>       reject: why the work is rejected (required)
  --diff                run, recover, approve, reject: print the whole diff of every attempt (each attempt
                        always shows which files it changed; an approval gate always shows its diff)
  --verbose             run, recover, approve, reject: print every event of the run, as when the output is
                        not a terminal, instead of one line per step
  -h, --help            Show this help
  -v, --version         Show the version

Ctrl+C during run, recover, approve or reject cancels the run: the running agent and every
process it started are stopped, and the run ends cancelled. Ctrl+C during eval cancels the
trial in hand and starts no other.

Exit codes: 0 the run succeeded (eval: the evaluation completed, whatever its trials found),
1 it failed or ahp failed (eval: it stopped because a frozen task changed), 2 usage error,
3 the run stopped for a recovery decision, 4 the run stopped at an approval gate,
130 the run was cancelled`;

/** What `ahp` alone prints: the three commands a new user needs, not the whole reference. */
const GETTING_STARTED = `AHP runs AI coding agents one after another (plan, implement, review), checks each step's
work with your tests, and pushes only what you approve.

Get started, in your project's folder (a git repository with a remote named origin):
  1. ahp doctor   which coding agent tools are installed and logged in
  2. ahp setup    say what to build and which agent does each step; it writes the workflow
  3. ahp run ahp.workflow.mjs
                  run it; it stops for your approval, showing the code, before anything is pushed

Every command and option: ahp --help`;

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

/** Runs the `ahp` CLI and returns its exit code: see `USAGE`. */
export async function main(argv: string[], given: Io = defaultIo): Promise<number> {
  let io = given;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        out: { type: "string" },
        seed: { type: "string" },
        json: { type: "boolean" },
        policy: { type: "string" },
        reason: { type: "string" },
        diff: { type: "boolean" },
        verbose: { type: "boolean" },
        all: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    if (values.verbose && io.terminal) io = { ...io, terminal: { ...io.terminal, compact: false } };
    const repo = resolve(values.repo ?? process.cwd());
    const [command, target, step, ...extra] = positionals;

    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (values.version) {
      io.stdout(version());
      return 0;
    }
    if (command === undefined) {
      io.stdout(GETTING_STARTED);
      return 0;
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
      const usage = error instanceof UsageError && !error.showUsage ? "(`ahp --help` lists the commands and options)" : USAGE;
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
            const lines = [live.approvalHeading()];
            if (found) {
              try {
                lines.push(`  what you are approving: ${describeChanges(await changesBetween(found.repo, current.baseCommit, event.commit))}`);
                const diff = await diffBetween(found.repo, current.baseCommit, event.commit);
                if (diff) lines.push(formatDiff(diff, { color, more: `ahp inspect ${current.runId}` }));
              } catch {
                // The diff is shown where it can be read; the decision does not depend on it.
              }
            }
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
    const usage = last && !waitsHere ? formatRunUsage(last) : null;
    if (usage) io.stdout(usage);
    if (usedMock && !waitsHere) io.stdout(MOCK_NOTE);
  }
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
      // The run stops here after all: what it used so far, as `followRun` would have said.
      const usage = formatRunUsage(current);
      if (usage) io.stdout(usage);
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
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError("setup asks questions: run it in an interactive terminal (or write the file by hand, or use `ahp init`)");
  io.stdout("Looking at the tools on this machine (as ahp doctor does)...");
  try {
    const result = await runSetup({ prompter: terminalPrompter(io.stdout), dir: repo, report: await diagnose(), models: (tool) => modelsFor(tool) });
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
  const home = await realpath(homedir()).catch(() => homedir());
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!named && same(top, home)) {
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
  const { state } = await followRun(io, repo, (following) => runWorkflow(workflow as Parameters<typeof runWorkflow>[0], { repo, ...following }), { diff });
  return await decideHere(io, repo, state, diff);
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
