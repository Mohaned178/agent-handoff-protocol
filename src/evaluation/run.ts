import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LedgerWriter, readCheckedLedger, type ChainedEvent } from "../ledger/index.ts";
import { PROTOCOL_VERSION } from "../protocol/index.ts";
import { newId, systemClock, type Clock } from "../runtime/index.ts";
import { validateWorkflow } from "../sdk/index.ts";
import { workflowFor } from "./conditions.ts";
import type { EvaluationEvent, EvaluationEventBody, ScheduledTrial } from "./events.ts";
import { changesBetween, fileListOf, hashOfFiles } from "./freeze.ts";
import { applyEvaluationEvent, replayEvaluation, type EvaluationView } from "./replay.ts";
import { formatReport, reportOf, type EvaluationReport } from "./report.ts";
import { drawIndex, isSeed, seededRandom, seededShuffle } from "./statistics.ts";
import { conditionsOf, DEFAULT_RETRY_BUDGET, validateSuite, type EvaluationSuite } from "./suite.ts";
import { loadTask, parseTask, readTaskFiles, type LoadedTask } from "./task.ts";
import { runTrial } from "./trial.ts";

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
  /**
   * The seed of the trial order and of the comparisons' resampling: an integer from 0 to 2^32 − 1, recorded in the ledger.
   * Default: one drawn at random.
   */
  seed?: number;
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
 * evaluation ledger, schedules every task under every condition once per repeat in an order shuffled from the seed, then
 * runs them in that order, a trial at a time, drawing a scored C3 trial's baseline into the trials still to come and
 * checking the task against its freeze before each one. Every trial is scored by the independent validators. Throws
 * before writing anything if the suite, a task or the seed is invalid.
 */
export async function runEvaluation(suite: EvaluationSuite, options: RunEvaluationOptions): Promise<EvaluationResult> {
  const shapeProblems = validateSuite(suite);
  if (shapeProblems.length > 0) throw new SuiteInvalidError(shapeProblems);
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
        const slot = { condition, repeat: 1, baselineIndex: condition === "baseline" ? 1 : null };
        for (const problem of validateWorkflow(workflowFor(condition, task, suite, slot))) problems.push(`task "${task.id}", ${condition}: ${problem}`);
      } catch (error) {
        problems.push(`task "${task.id}", ${condition}: ${(error as Error).message}`);
      }
    }
  }
  if (options.seed !== undefined && !isSeed(options.seed)) problems.push(`the seed must be an integer from 0 to ${0xffffffff}`);
  if (problems.length > 0) throw new SuiteInvalidError(problems);
  const seed = options.seed ?? randomInt(0, 0x100000000);
  const repeats = suite.repeats ?? 1;

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
    await record({ type: "evaluation_created", evaluationId, protocolVersion: PROTOCOL_VERSION, suite: suite.name, conditions, retryBudget: suite.retryBudget ?? DEFAULT_RETRY_BUDGET, repeats });
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

    // Every trial but the baseline's, in an order drawn from the seed; the baseline's are drawn into it as C3 trials are scored.
    const random = seededRandom(seed);
    const planned: ScheduledTrial[] = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const { task } of tasks) for (const condition of conditions) if (condition !== "baseline") planned.push({ taskId: task.id, condition, repeat, baseline: null });
    }
    await record({ type: "trials_scheduled", seed, order: seededShuffle(planned, random) });

    const ctx = { suite, dir, record, signal: options.signal, clock };
    let end: Extract<EvaluationEventBody, { type: "evaluation_ended" }> = { type: "evaluation_ended", state: "completed", reason: null };
    // The next trial is always the first of those the ledger says are still to start.
    for (let next = view!.pending![0]; next; next = view!.pending![0]) {
      if (options.signal?.aborted) {
        end = { type: "evaluation_ended", state: "cancelled", reason: "cancelled before the next trial" };
        break;
      }
      const fresh = await recheck(tasks.find(({ task }) => task.id === next!.taskId)!, record);
      if (!fresh) {
        end = { type: "evaluation_ended", state: "stopped", reason: "task_changed" };
        break;
      }
      const { trialId, ended } = await runTrial(ctx, fresh, next);
      if (ended.outcome === "cancelled") {
        end = { type: "evaluation_ended", state: "cancelled", reason: "cancelled during a trial" };
        break;
      }
      if (next.condition === "C3" && conditions.includes("baseline") && ended.outcome === "scored") {
        // As many C0 trials as attempts the C3 trial made, each put at a drawn position among the trials still to start.
        const remaining = view!.pending!.length;
        const positions = Array.from({ length: ended.attempts }, (_, index) => drawIndex(random, remaining + index + 1));
        await record({ type: "baseline_scheduled", forTrialId: trialId, taskId: next.taskId, repeat: next.repeat, trials: ended.attempts, positions });
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
