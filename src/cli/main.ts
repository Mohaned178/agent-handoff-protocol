import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { formatEvent, formatRun, formatUnresumed, MOCK_NOTE } from "./format.ts";

const USAGE = `Usage: ahp <command> [options]

Commands:
  run <workflow-file>   Run the workflow exported by default from <workflow-file>
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
  --json                inspect: print the derived state, the ledger check and the run's lock as JSON
  --policy <decision>   recover: adopt or abort
  --reason <text>       reject: why the work is rejected (required)
  -h, --help            Show this help
  -v, --version         Show the version

Ctrl+C during run, recover, approve or reject cancels the run: the running agent and every
process it started are stopped, and the run ends cancelled.

Exit codes: 0 the run succeeded, 1 it failed or ahp failed, 2 usage error,
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
      case "run":
        if (!target) throw new UsageError("run needs a workflow file");
        return await runCommand(target, repo, io);
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
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) {
      io.stderr("ahp: still cancelling: waiting until the agent and every process it started are seen gone");
      return;
    }
    io.stderr("ahp: cancelling the run (Ctrl+C)");
    controller.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return await execute({
      signal: controller.signal,
      onEvent: (event, current) => {
        usedMock = current.mock;
        io.stdout(formatEvent(event, current));
      },
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (usedMock) io.stdout(MOCK_NOTE);
  }
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
