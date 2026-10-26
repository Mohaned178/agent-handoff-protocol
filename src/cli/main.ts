import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DISCARD_AND_RETRY_DEFERRED, RECOVERY_ACTIONS, type LedgerEvent, type RecoveryAction, type RunView } from "../protocol/index.ts";
import { inspectRun, isAttemptId, isRunId, recoverAttempt, resumeRun, runWorkflow, validateWorkflow } from "../sdk/index.ts";
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

Options:
  --repo <dir>          The git repository to use (default: the current directory)
  --json                inspect: print the derived state, the ledger check and the run's lock as JSON
  --policy <decision>   recover: adopt or abort
  -h, --help            Show this help
  -v, --version         Show the version

Exit codes: 0 the run succeeded, 1 it failed or ahp failed, 2 usage error,
3 the run stopped for a recovery decision`;

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
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    const repo = resolve(values.repo ?? process.cwd());
    const [command, target, ...extra] = positionals;

    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (values.version) {
      io.stdout(version());
      return 0;
    }
    if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`);
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

/** The exit code for a run in `state`: 0 succeeded, 3 stopped for a recovery decision, 1 anything else. */
function exitCodeOf(state: Readonly<RunView>): number {
  if (state.state === "succeeded") return 0;
  return state.state === "needs_recovery" ? 3 : 1;
}

/**
 * Streams a progress line for each event `go` records, and the mock note at the end if any came from the mock
 * adapter, also when `go` throws partway.
 */
async function followRun<R>(io: Io, go: (onEvent: (event: LedgerEvent, state: Readonly<RunView>) => void) => Promise<R>): Promise<R> {
  let usedMock = false;
  try {
    return await go((event, current) => {
      usedMock = current.mock;
      io.stdout(formatEvent(event, current));
    });
  } finally {
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
  const { state } = await followRun(io, (onEvent) => runWorkflow(workflow as Parameters<typeof runWorkflow>[0], { repo, onEvent }));
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
    const result = await followRun(io, (onEvent) => resumeRun({ repo, runId: target, onEvent }));
    if (!result.resumed) io.stdout(formatUnresumed(result));
    return exitCodeOf(result.state);
  }
  if (!isAttemptId(target)) throw new UsageError(`not a run ID or an attempt ID: ${target}`);
  if (policy === undefined) throw new UsageError(`recover ${target} needs --policy adopt or --policy abort`);
  if (policy === "discard_and_retry") throw new UsageError(DISCARD_AND_RETRY_DEFERRED);
  if (!RECOVERY_ACTIONS.includes(policy as RecoveryAction)) throw new UsageError(`--policy must be adopt or abort, not ${policy}`);
  const { state } = await followRun(io, (onEvent) => recoverAttempt({ repo, attemptId: target, policy: policy as RecoveryAction, onEvent }));
  return exitCodeOf(state);
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
