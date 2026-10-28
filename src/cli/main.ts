import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RECOVERY_ACTIONS, type LedgerEvent, type RecoveryAction, type RunView } from "../protocol/index.ts";
import {
  approveStep,
  DISCARD_AND_RETRY_DEFERRED,
  inspectRun,
  isAttemptId,
  isRunId,
  recoverAttempt,
  rejectStep,
  resumeRun,
  runWorkflow,
  validateWorkflow,
} from "../sdk/index.ts";
import { diagnose, initWorkflow } from "../doctor/index.ts";
import { formatReport, runEvaluation, SuiteInvalidError, TaskInvalidError, type EvaluationEvent, type EvaluationSuite, type EvaluationView } from "../evaluation/index.ts";
import { evaluationsRoot } from "../runtime/index.ts";
import { formatEvent, formatRun, formatUnresumed, MOCK_NOTE } from "./format.ts";
import { formatDoctor, formatInit } from "./format-doctor.ts";
import { formatEvaluationEvent } from "./format-evaluation.ts";

const USAGE = `Usage: ahp <command> [options]

Commands:
  doctor                Report this machine and which coding agent tools AHP can use (--json for data)
  init [file]           Write the password-reset example workflow (default ahp.workflow.mjs), cast from
                        the tools doctor found, the mock adapter standing in for any it did not
  run <workflow-file>   Run the workflow exported by default from <workflow-file>
  eval <suite-file>     Run the evaluation suite exported by default from <suite-file>: its tasks are frozen,
                        then each runs under conditions C0 and C3 and is scored by independent validators
  inspect <run-id>      Show a run's state, derived from its ledger, and who is writing it
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
  --json                inspect: print the derived state, the ledger check and the run's lock as JSON;
                        doctor: print the report as JSON; eval: print only the report, as JSON
  --policy <decision>   recover: adopt or abort
  --reason <text>       reject: why the work is rejected (required)
  -h, --help            Show this help
  -v, --version         Show the version

Ctrl+C during run, recover, approve or reject cancels the run: the running agent and every
process it started are stopped, and the run ends cancelled. Ctrl+C during eval cancels the
trial in hand and starts no other.

Exit codes: 0 the run succeeded (eval: the evaluation completed, whatever its trials found),
1 it failed or ahp failed (eval: it stopped because a frozen task changed), 2 usage error,
3 the run stopped for a recovery decision, 4 the run stopped at an approval gate,
130 the run was cancelled`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** A problem with how ahp was invoked; exits 2. */
class UsageError extends Error {}

/** Runs the `ahp` CLI and returns its exit code: see `USAGE`. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean" },
        policy: { type: "string" },
        reason: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
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
    const deciding = command === "approve" || command === "reject";
    // Only a decision takes a second argument, the gate's step ID.
    if (extra.length > 0 || (step !== undefined && !deciding)) throw new UsageError(`unexpected argument: ${extra[0] ?? step}`);
    switch (command) {
      case "doctor":
        if (target) throw new UsageError(`unexpected argument: ${target}`);
        return await doctorCommand(values.json ?? false, io);
      case "init":
        return await initCommand(target, repo, io);
      case "run":
        if (!target) throw new UsageError("run needs a workflow file");
        return await runCommand(target, repo, io);
      case "eval":
        if (!target) throw new UsageError("eval needs a suite file");
        return await evalCommand(target, values.out, values.json ?? false, io);
      case "inspect":
        if (!target) throw new UsageError("inspect needs a run ID");
        return await inspectCommand(target, repo, values.json ?? false, io);
      case "recover":
        if (!target) throw new UsageError("recover needs a run ID, or an attempt ID and --policy");
        return await recoverCommand(target, values.policy, repo, io);
      case "approve":
      case "reject":
        return await decideCommand(command, target, step, values.reason, repo, io);
      default:
        throw new UsageError(command ? `unknown command: ${command}` : "no command given");
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`ahp: ${(error as Error).message}\n\n${USAGE}`);
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
async function followRun<R>(io: Io, execute: (following: Following) => Promise<R>): Promise<R> {
  let usedMock = false;
  const interrupt = cancelOnInterrupt(io, "the run", "waiting until the agent and every process it started are seen gone");
  try {
    return await execute({
      signal: interrupt.signal,
      onEvent: (event, current) => {
        usedMock = current.mock;
        io.stdout(formatEvent(event, current));
      },
    });
  } finally {
    interrupt.release();
    if (usedMock) io.stdout(MOCK_NOTE);
  }
}

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

async function runCommand(file: string, repo: string, io: Io): Promise<number> {
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
  const { state } = await followRun(io, (following) => runWorkflow(workflow as Parameters<typeof runWorkflow>[0], { repo, ...following }));
  return exitCodeOf(state);
}

/**
 * `ahp eval <suite-file>`: loads the suite, runs it and prints the report. Ctrl+C cancels the trial in hand, as for a run. The
 * evaluation's own exit code is 0 when it completed, whatever its trials found: a harness incident or a failed condition is a
 * finding, not a failure of the command.
 */
async function evalCommand(file: string, out: string | undefined, json: boolean, io: Io): Promise<number> {
  const path = resolve(file);
  let suite: unknown;
  try {
    suite = ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  } catch (error) {
    throw new UsageError(`cannot load suite file ${path}: ${(error as Error).message}`);
  }
  const interrupt = cancelOnInterrupt(io, "the evaluation", "waiting until the trial in hand and every process it started are seen gone");
  try {
    const result = await runEvaluation(suite as EvaluationSuite, {
      out: out === undefined ? evaluationsRoot() : resolve(out),
      baseDir: dirname(path),
      signal: interrupt.signal,
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

async function inspectCommand(runId: string, repo: string, json: boolean, io: Io): Promise<number> {
  const inspection = await inspectRun({ repo, runId });
  io.stdout(json ? JSON.stringify(inspection, null, 2) : formatRun(inspection));
  return 0;
}

async function recoverCommand(target: string, policy: string | undefined, repo: string, io: Io): Promise<number> {
  if (isRunId(target)) {
    if (policy !== undefined) throw new UsageError(`--policy decides an attempt: \`ahp recover <attempt-id> --policy adopt|abort\``);
    const result = await followRun(io, (following) => resumeRun({ repo, runId: target, ...following }));
    if (!result.resumed) io.stdout(formatUnresumed(result));
    return exitCodeOf(result.state);
  }
  if (!isAttemptId(target)) throw new UsageError(`not a run ID or an attempt ID: ${target}`);
  if (policy === undefined) throw new UsageError(`recover ${target} needs --policy adopt or --policy abort`);
  if (policy === "discard_and_retry") throw new UsageError(DISCARD_AND_RETRY_DEFERRED);
  if (!RECOVERY_ACTIONS.includes(policy as RecoveryAction)) throw new UsageError(`--policy must be adopt or abort, not ${policy}`);
  const { state } = await followRun(io, (following) => recoverAttempt({ repo, attemptId: target, policy: policy as RecoveryAction, ...following }));
  return exitCodeOf(state);
}

/** `ahp approve <run> <step>` and `ahp reject <run> <step> --reason`: a person's decision at the gate a run waits at. */
async function decideCommand(
  command: "approve" | "reject",
  runId: string | undefined,
  stepId: string | undefined,
  reason: string | undefined,
  repo: string,
  io: Io,
): Promise<number> {
  if (!runId || !stepId) throw new UsageError(`${command} needs a run ID and the approval gate's step ID: ahp ${command} <run-id> <step-id>${command === "reject" ? " --reason <text>" : ""}`);
  if (!isRunId(runId)) throw new UsageError(`not a run ID: ${runId}`);
  if (command === "approve" && reason !== undefined) throw new UsageError("approve takes no --reason; a rejection does: `ahp reject <run-id> <step-id> --reason <text>`");
  if (command === "reject" && (reason === undefined || reason.trim() === "")) throw new UsageError("reject needs --reason <text>: it is sent back with the work");
  const { state } = await followRun(io, (following) =>
    command === "approve" ? approveStep({ repo, runId, stepId, ...following }) : rejectStep({ repo, runId, stepId, reason: reason!, ...following }),
  );
  return exitCodeOf(state);
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
