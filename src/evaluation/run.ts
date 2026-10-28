import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LedgerWriter, readCheckedLedger, type ChainedEvent } from "../ledger/index.ts";
import { PROTOCOL_VERSION } from "../protocol/index.ts";
import { systemClock, type Clock } from "../runtime/index.ts";
import { validateWorkflow } from "../sdk/index.ts";
import { workflowFor } from "./conditions.ts";
import type { EvaluationEvent, EvaluationEventBody } from "./events.ts";
import { changesBetween, fileListOf, hashOfFiles } from "./freeze.ts";
import { applyEvaluationEvent, replayEvaluation, type EvaluationView } from "./replay.ts";
import { formatReport, reportOf, type EvaluationReport } from "./report.ts";
import { conditionsOf, DEFAULT_RETRY_BUDGET, validateSuite, type EvaluationSuite } from "./suite.ts";
import { loadTask, parseTask, readTaskFiles, type LoadedTask } from "./task.ts";
import { newId, runTrial } from "./trial.ts";

/** A suite that cannot be run: its own shape, or a workflow a condition would build from it, is invalid. Nothing was written. */
export class SuiteInvalidError extends Error {
  override name = "SuiteInvalidError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid suite:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

export interface RunEvaluationOptions {
  /** The directory the evaluation's own directory (`<out>/<evaluation id>`) is made in. */
  out: string;
  /** Task directories in the suite that are relative are resolved against this. Default: the working directory. */
  baseDir?: string;
  /** Called after each event is durably recorded in the evaluation's ledger, with the state derived so far. */
  onEvent?: (event: EvaluationEvent, state: Readonly<EvaluationView>) => void;
  /** Cancels the evaluation once aborted: the trial in hand is cancelled, and no further trial starts. */
  signal?: AbortSignal;
  clock?: Clock;
}

export interface EvaluationResult {
  evaluationId: string;
  /** Where the ledger, the trials, `report.json` and `report.txt` are. */
  dir: string;
  state: EvaluationView;
  report: EvaluationReport;
}

/**
 * Runs a suite: loads and validates every task and every workflow the conditions build, freezes the tasks in a new
 * evaluation ledger, then runs each task under each condition in turn, a trial at a time, checking the task against its
 * freeze before each one. Every trial is scored by the independent validators. Throws before writing anything if the
 * suite or a task is invalid.
 */
export async function runEvaluation(suite: EvaluationSuite, options: RunEvaluationOptions): Promise<EvaluationResult> {
  const shape = validateSuite(suite);
  if (shape.length > 0) throw new SuiteInvalidError(shape);
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const tasks: LoadedTask[] = [];
  for (const dir of suite.tasks) tasks.push(await loadTask(resolve(baseDir, dir)));
  const conditions = conditionsOf(suite);
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const { task } of tasks) {
    if (ids.has(task.id)) problems.push(`two tasks are named "${task.id}"`);
    ids.add(task.id);
    for (const condition of conditions) {
      try {
        for (const problem of validateWorkflow(workflowFor(condition, task, suite))) problems.push(`task "${task.id}", ${condition}: ${problem}`);
      } catch (error) {
        problems.push(`task "${task.id}", ${condition}: ${(error as Error).message}`);
      }
    }
  }
  if (problems.length > 0) throw new SuiteInvalidError(problems);

  const clock = options.clock ?? systemClock;
  const evaluationId = newId("eval");
  const dir = join(resolve(options.out), evaluationId);
  await mkdir(dir, { recursive: true });
  const ledger = await LedgerWriter.create<EvaluationEventBody>(join(dir, "ledger.jsonl"), () => clock.now());
  let view: EvaluationView | undefined;
  const record = async (body: EvaluationEventBody): Promise<ChainedEvent<EvaluationEventBody>> => {
    const event = await ledger.append(body);
    view = applyEvaluationEvent(view, event);
    options.onEvent?.(event, view);
    return event;
  };
  try {
    await record({ type: "evaluation_created", evaluationId, protocolVersion: PROTOCOL_VERSION, suite: suite.name, conditions, retryBudget: suite.retryBudget ?? DEFAULT_RETRY_BUDGET });
    // Every task is frozen before any trial starts, so nothing a trial shows can be used to tune one.
    for (const { task, dir: taskDir, hash, hiddenTestsHash, files } of tasks) {
      await record({
        type: "task_frozen",
        taskId: task.id,
        dir: taskDir,
        taskHash: hash,
        hiddenTestsHash,
        files,
        hiddenTests: task.hiddenTests.map((test) => test.path),
        constraints: task.constraints.map((constraint) => constraint.id),
        seededDefects: task.seededDefects.map((defect) => defect.id),
      });
    }

    const ctx = { suite, dir, record, signal: options.signal, clock };
    let end: Extract<EvaluationEventBody, { type: "evaluation_ended" }> = { type: "evaluation_ended", state: "completed", reason: null };
    trials: for (const frozen of tasks) {
      for (const condition of conditions) {
        if (options.signal?.aborted) {
          end = { type: "evaluation_ended", state: "cancelled", reason: "cancelled before the next trial" };
          break trials;
        }
        const fresh = await recheck(frozen, record);
        if (!fresh) {
          end = { type: "evaluation_ended", state: "stopped", reason: "task_changed" };
          break trials;
        }
        const ended = await runTrial(ctx, fresh, condition);
        if (ended.outcome === "cancelled") {
          end = { type: "evaluation_ended", state: "cancelled", reason: "cancelled during a trial" };
          break trials;
        }
      }
    }
    await record(end);
  } catch (error) {
    // The ledger says it stopped, rather than leave an evaluation that reads as still running; the error is still the caller's.
    await record({ type: "evaluation_ended", state: "stopped", reason: `error: ${(error as Error).message}`.slice(0, 500) }).catch(() => undefined);
    throw error;
  } finally {
    await ledger.close();
  }
  const state = view!;
  const report = reportOf(state);
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.txt"), `${formatReport(report)}\n`);
  return { evaluationId, dir, state, report };
}

/**
 * Reads the task directory again and checks it against its freeze. The bytes that are hashed are the bytes the trial then
 * uses, so the task cannot change between the check and the trial. A task that has changed, or cannot be read, is recorded
 * as such and null is returned: it is never frozen again.
 */
async function recheck(frozen: LoadedTask, record: (body: EvaluationEventBody) => Promise<unknown>): Promise<LoadedTask | null> {
  const taskId = frozen.task.id;
  let files: Map<string, Buffer>;
  try {
    files = await readTaskFiles(frozen.dir);
  } catch {
    await record({ type: "task_changed", taskId, frozenHash: frozen.hash, foundHash: null, changed: [] });
    return null;
  }
  const found = fileListOf(files);
  const hash = hashOfFiles(found);
  if (hash === frozen.hash) return parseTask(frozen.dir, files);
  await record({ type: "task_changed", taskId, frozenHash: frozen.hash, foundHash: hash, changed: changesBetween(frozen.files, found) });
  return null;
}

/** Reads an evaluation's ledger, every event checked against the hash chain, and derives its state. */
export async function readEvaluation(dir: string): Promise<EvaluationView> {
  return replayEvaluation((await readCheckedLedger<EvaluationEventBody>(join(resolve(dir), "ledger.jsonl"))).events);
}
