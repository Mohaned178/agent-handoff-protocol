// The plain commands, for CI, scripts, pipes and agents: `ahp run|approve|reject|recover|runs|inspect|doctor|eval|bench|clean|
// demo` and `ahp "<task>" --yes`. They print lines, never colour or animation, and never ask. The app (`src/tui/`) is what a
// person at a terminal opens; both drive the same SDK, so a run started by one is read, decided and resumed by the other.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RECOVERY_ACTIONS, type RecoveryAction } from "../protocol/index.ts";
import { assignRoles, diagnose } from "../doctor/index.ts";
import { API_KEY_NOTICE, formatReport, readEvaluation, runEvaluation, SuiteInvalidError, TaskInvalidError, type EvaluationEvent, type EvaluationSuite, type EvaluationView } from "../evaluation/index.ts";
import { BenchesNotComparableError, BenchInvalidError, formatBenchReport, readBench, reportOf, runBench, type BenchFile } from "../inference/index.ts";
import { benchesRoot, demosRoot, evaluationsRoot, locateRepo } from "../runtime/index.ts";
import { approveStep, DISCARD_AND_RETRY_DEFERRED, inspectRun, isAttemptId, isRunId, listRuns, recoverAttempt, rejectStep, resumeRun, runWorkflow, validateWorkflow } from "../sdk/index.ts";
import { prepareDemo } from "../setup/demo.ts";
import { BENCH_REPORT_USAGE, COMMAND_SPECS, parseInvocation, seedOf, usageLineOf, UsageError, USAGE, type Values } from "./args.ts";
import { cleanRuns, formatClean } from "./clean.ts";
import { openGateOf } from "./decision.ts";
import { formatBenchEvent } from "./bench-text.ts";
import { formatDoctor } from "./doctor-text.ts";
import { formatEvaluationEvent } from "./evaluation-text.ts";
import { formatRun, formatRuns, formatUnresumed } from "./inspect-text.ts";
import { cancelOnInterrupt, exitCodeOf, followRun, type Io } from "./stream.ts";
import { checkRemotes, repositoryOf, taskCommand } from "./task-command.ts";

export type { Io };

const defaultIo: Io = {
  stdout: (text) => void process.stdout.write(`${text}\n`),
  stderr: (text) => void process.stderr.write(`${text}\n`),
};

/** Runs the plain `ahp` commands and returns the exit code: see `USAGE`. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let command: string | null = null;
  try {
    const invocation = parseInvocation(argv);
    switch (invocation.kind) {
      case "usage":
        io.stdout(USAGE);
        return 0;
      case "version":
        io.stdout(`${version()} (alpha)`);
        return 0;
      case "moved":
        throw new UsageError(`\`ahp ${invocation.command}\` has moved into the app: run \`ahp\` in a terminal (the plain commands are \`ahp --help\`)`);
      case "task":
        command = "<task>";
        return await taskCommand(invocation.task, invocation.values, resolve(stringOf(invocation.values.repo) ?? process.cwd()), io);
      case "command": {
        command = invocation.command;
        const { positionals: args, values } = invocation;
        const repo = resolve(stringOf(values.repo) ?? process.cwd());
        const named = values.repo !== undefined;
        switch (invocation.command) {
          case "help":
            io.stdout(USAGE);
            return 0;
          case "run":
            return await runCommand(args[0]!, repo, named, io);
          case "approve":
          case "reject":
            return await decideCommand(invocation.command, args[0]!, args[1], stringOf(values.reason), repo, io);
          case "recover":
            return await recoverCommand(args[0]!, stringOf(values.policy), repo, io);
          case "runs":
            return await runsCommand(repo, values.all === true, values.json === true, io);
          case "inspect":
            return await inspectCommand(args[0], repo, values.json === true, io);
          case "doctor":
            return await doctorCommand(values.json === true, io);
          case "clean":
            return await cleanCommand(repo, values["dry-run"] === true, io);
          case "demo":
            return await demoCommand(values.real === true, values.yes === true, io);
          case "eval":
            return await evalCommand(args[0]!, stringOf(values.out), seedOf(stringOf(values.seed)), values.json === true, io);
          case "bench":
            return await benchCommand(args, values, io);
        }
        throw new UsageError(`unknown command: ${invocation.command}`, { showUsage: true });
      }
    }
  } catch (error) {
    const spec = command === null ? undefined : COMMAND_SPECS.find((candidate) => candidate.name === command);
    if (error instanceof UsageError) {
      // A mistake in a command is answered with that command's usage line; an unknown command with the whole text.
      const hint = error.showUsage ? `\n\n${USAGE}` : spec && !error.message.includes("\nusage: ") ? `\nusage: ${usageLineOf(spec)}` : "";
      io.stderr(`ahp: ${error.message}${hint}`);
      return 2;
    }
    io.stderr(`ahp: ${(error as Error).message}`);
    return 1;
  }
}

const stringOf = (value: Values[string]): string | undefined => (typeof value === "string" ? value : undefined);

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/** Imports the module at `file` and returns what it exports by default. */
async function loadDefault(file: string, what: string): Promise<{ path: string; value: unknown }> {
  const path = resolve(file);
  try {
    return { path, value: ((await import(pathToFileURL(path).href)) as { default?: unknown }).default };
  } catch (error) {
    throw new UsageError(`cannot load ${what} ${path}: ${(error as Error).message}`);
  }
}

async function runCommand(file: string, dir: string, named: boolean, io: Io): Promise<number> {
  const { path, value: workflow } = await loadDefault(file, "workflow file");
  const problems = validateWorkflow(workflow);
  if (problems.length > 0) throw new UsageError(`invalid workflow in ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const repo = await repositoryOf(dir, named, io);
  await checkRemotes(workflow as { steps: { id: string; action?: { remote?: string } }[] }, repo);
  const { state } = await followRun(io, (following) => runWorkflow(workflow as Parameters<typeof runWorkflow>[0], { repo, ...following }));
  return exitCodeOf(state);
}

/**
 * `ahp approve <run> [<gate>]` and `ahp reject <run> [<gate>] --reason`: a person's decision at the gate a run waits at. The
 * gate is named only when it cannot be told: with one gate waiting it is that one.
 */
async function decideCommand(command: "approve" | "reject", runId: string, given: string | undefined, reason: string | undefined, repo: string, io: Io): Promise<number> {
  if (!isRunId(runId)) throw new UsageError(`not a run ID: ${runId}`);
  if (command === "approve" && reason !== undefined) throw new UsageError("approve takes no --reason; a rejection does: `ahp reject <run-id> [<gate>] --reason <text>`");
  if (command === "reject" && (reason === undefined || reason.trim() === "")) throw new UsageError("reject needs --reason <text>: it is sent back with the work");
  let stepId = given;
  if (stepId === undefined) {
    const { state } = await inspectRun({ repo, runId });
    const gate = openGateOf(state);
    if (!gate) throw new Error(`run ${runId} is not waiting for approval: it is ${state.state}`);
    stepId = gate.id;
  }
  const gate = stepId;
  const { state } = await followRun(io, (following) =>
    command === "approve" ? approveStep({ repo, runId, stepId: gate, ...following }) : rejectStep({ repo, runId, stepId: gate, reason: reason!, ...following }),
  );
  return exitCodeOf(state);
}

async function recoverCommand(target: string, policy: string | undefined, repo: string, io: Io): Promise<number> {
  if (isRunId(target)) {
    if (policy !== undefined) throw new UsageError("--policy decides an attempt: `ahp recover <attempt-id> --policy adopt|abort`");
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

/** The last lines of `ahp doctor`: where a bug goes and what it should carry. */
const BUG_REPORT_HINT =
  "To report a bug: https://github.com/Mohaned178/agent-handoff-protocol/issues/new/choose, with the command you ran, what it printed, and this report (`ahp doctor --json`; it holds no credentials, but read it first: it names paths on this machine).";

/** Exit 0 unless Node or git does not meet its requirement; a tool that is missing is reported, not a failure. */
async function doctorCommand(json: boolean, io: Io): Promise<number> {
  const report = await diagnose();
  // AHP's own version first: with the rest of the report, it is what a bug report needs.
  const ahp = `${version()} (alpha)`;
  io.stdout(json ? JSON.stringify({ ahp, ...report }, null, 2) : [`ahp ${ahp}`, "", formatDoctor(report), "", BUG_REPORT_HINT].join("\n"));
  return report.ok ? 0 : 1;
}

/** `ahp clean [--dry-run]`: the worktrees of runs that have ended; exit 1 when one could not be removed. */
async function cleanCommand(dir: string, dryRun: boolean, io: Io): Promise<number> {
  const repo = (await locateRepo(dir).catch(() => {
    throw new UsageError(`${dir} is not in a git repository: run ahp in your project's folder, or pass --repo <dir>`);
  })).repo;
  const report = await cleanRuns({ repo, dryRun });
  for (const line of formatClean(report)) io.stdout(line);
  return report.runs.some((run) => run.outcome === "failed") ? 1 : 0;
}

/**
 * `ahp demo`: the reference scenario in a sample project made for it, run as `ahp run` would. Scripted mock agents unless
 * `--real`, which casts the installed tools (and spends their usage, so it needs `--yes`).
 */
async function demoCommand(real: boolean, yes: boolean, io: Io): Promise<number> {
  if (real && !yes) throw new UsageError("`demo --real` runs your own tools, and their usage counts against your plans: pass --yes");
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
        : "  agents: scripted mock agents, free and instant; their output is no evidence (`ahp demo --real --yes` uses your own tools)",
      `  project: ${demo.project}`,
    ].join("\n"),
  );
  const code = await runCommand(demo.workflow, demo.project, true, io);
  io.stdout(`The demo is kept in ${demo.dir}: \`cd ${demo.project}\`, then \`ahp runs\` or \`ahp inspect\`${code === 4 ? ", and `ahp approve <run-id>` to finish it" : ""}.`);
  return code;
}

/**
 * `ahp eval <suite-file>`: loads the suite, runs it and prints the report. Ctrl+C cancels the trial in hand, as for a run. The
 * evaluation's own exit code is 0 when it completed, whatever its trials found: a harness incident or a failed condition is a
 * finding, not a failure of the command.
 */
async function evalCommand(file: string, out: string | undefined, seed: number | undefined, json: boolean, io: Io): Promise<number> {
  const { path, value: suite } = await loadDefault(file, "suite file");
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

/**
 * `ahp bench <bench-file>` runs a bench and prints its report; `ahp bench report <bench-dir>...` combines the benches already
 * made. Ctrl+C cancels the workload in hand and starts no other. Exit 0 when the bench completed with something measured; an
 * unavailable engine is a finding in the report, but a bench in which nothing could be measured exits 1.
 */
async function benchCommand(args: string[], values: Values, io: Io): Promise<number> {
  const [first, ...rest] = args;
  const options = { engine: stringOf(values.engine), out: stringOf(values.out), seed: seedOf(stringOf(values.seed)), json: values.json === true, evaluations: (values.eval as string[] | undefined) ?? [] };
  if (first === undefined) throw new UsageError("bench needs a bench file, or `bench report <bench-dir>...`");
  if (first === "report") {
    try {
      return await benchReportCommand(rest, options, io);
    } catch (error) {
      if (error instanceof UsageError && !error.message.includes("\nusage: ")) throw new UsageError(`${error.message}\nusage: ${BENCH_REPORT_USAGE}`);
      throw error;
    }
  }
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
  if (options.evaluations.length > 0) throw new UsageError("--eval puts evaluations beside benches already made: use it with `bench report <bench-dir>...`");
  const { path, value: file } = await loadDefault(first, "bench file");
  const interrupt = cancelOnInterrupt(io, "the bench", "waiting until the requests in flight and the workload in hand are seen ended");
  try {
    const result = await runBench(file as BenchFile, {
      out: options.out === undefined ? benchesRoot() : resolve(options.out),
      baseDir: dirname(path),
      signal: interrupt.signal,
      ...(options.engine !== undefined ? { engine: options.engine as never } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      onEvent: (event, state) => {
        if (!options.json) io.stdout(formatBenchEvent(event, state));
      },
    });
    const report = reportOf([result.state]);
    io.stdout(options.json ? JSON.stringify(report, null, 2) : `\n${formatBenchReport(report)}\nkept in ${result.dir}`);
    if (result.state.state === "cancelled") return 130;
    if (result.state.state !== "completed") return 1;
    if (!result.state.workloads.some((workload) => workload.status === "ended")) {
      io.stderr("ahp: nothing was measured: no engine of the bench was available (the report says why)");
      return 1;
    }
    return 0;
  } catch (error) {
    // A bench file or prompt set that is invalid is a mistake in how ahp was used, as an invalid suite is.
    if (error instanceof BenchInvalidError) throw new UsageError(`${error.message}\n(bench file ${path})`);
    throw error;
  } finally {
    interrupt.release();
  }
}

async function benchReportCommand(dirs: string[], options: { engine?: string | undefined; out?: string | undefined; seed?: number | undefined; json: boolean; evaluations: string[] }, io: Io): Promise<number> {
  if (dirs.length === 0) throw new UsageError("bench report needs the directory of at least one bench");
  if (options.engine !== undefined) throw new UsageError("--engine chooses what to run: `bench report` reports the benches it is given");
  const views = [];
  for (const dir of dirs) {
    if (!existsSync(join(resolve(dir), "ledger.jsonl"))) throw new UsageError(`not a bench directory (it has no ledger.jsonl): ${resolve(dir)}`);
    views.push(await readBench(dir));
  }
  const evaluations: EvaluationView[] = [];
  for (const dir of options.evaluations) {
    if (!existsSync(join(resolve(dir), "ledger.jsonl"))) throw new UsageError(`not an evaluation directory (it has no ledger.jsonl): ${resolve(dir)}`);
    evaluations.push(await readEvaluation(dir));
  }
  let report;
  try {
    report = reportOf(views, { ...(options.seed === undefined ? {} : { seed: options.seed }), evaluations });
  } catch (error) {
    if (error instanceof BenchesNotComparableError) throw new UsageError(error.message);
    throw error;
  }
  if (options.out !== undefined) {
    const out = resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, "report.txt"), `${formatBenchReport(report)}\n`);
  }
  io.stdout(options.json ? JSON.stringify(report, null, 2) : `${formatBenchReport(report)}${options.out !== undefined ? `\nwritten to ${resolve(options.out)}` : ""}`);
  return 0;
}
