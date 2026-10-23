import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readRun, runWorkflow, validateWorkflow } from "../sdk/index.ts";
import { formatEvent, formatRun, MOCK_NOTE } from "./format.ts";

const USAGE = `Usage: ahp <command> [options]

Commands:
  run <workflow-file>   Run the workflow exported by default from <workflow-file>
  inspect <run-id>      Show a run's state, derived from its ledger

Options:
  --repo <dir>          The git repository to use (default: the current directory)
  --json                inspect: print the derived state as JSON
  -h, --help            Show this help
  -v, --version         Show the version`;

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

/** Runs the `ahp` CLI and returns its exit code: 0 success, 1 failed run or error, 2 usage error. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
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
  let usedMock = false;
  try {
    const { state } = await runWorkflow(workflow as Parameters<typeof runWorkflow>[0], {
      repo,
      onEvent: (event, current) => {
        usedMock = current.mock;
        io.stdout(formatEvent(event, current));
      },
    });
    return state.state === "succeeded" ? 0 : 1;
  } finally {
    // Also when the run throws partway: whatever was printed came from the mock adapter.
    if (usedMock) io.stdout(MOCK_NOTE);
  }
}

async function inspectCommand(runId: string, repo: string, json: boolean, io: Io): Promise<number> {
  const state = await readRun({ repo, runId });
  io.stdout(json ? JSON.stringify(state, null, 2) : formatRun(state));
  return 0;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
