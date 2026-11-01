// Verified success beside speed (inference-evaluation ticket 03): what `ahp eval` measured of each engine through OpenCode (the
// pilot tasks, scored by the independent validators) put beside what `ahp bench` measured of it directly. Pure over replayed
// views: nothing is read or written here. An evaluation names its engine through the record each trial made of it when it
// started (`ToolVersionRecord.engines`), never through its suite's name.

import { CONDITIONS, type ConditionId, type LocalEngineRecord } from "../evaluation/events.ts";
import type { EvaluationView } from "../evaluation/replay.ts";
import { reportOf as evaluationReportOf, talliesOf } from "../evaluation/report.ts";
import { comparePaired, type PairedComparison } from "../evaluation/statistics.ts";
import { ENGINES, ENGINE_NAMES, type EngineId } from "./engines.ts";
import type { BenchView } from "./replay.ts";

/** An evaluation in the report, and the one engine its trials ran on. */
export interface EvaluationReference {
  evaluationId: string;
  suite: string;
  state: EvaluationView["state"];
  reason: string | null;
  /** The seed of its trial order; null when no trial was scheduled. */
  seed: number | null;
  engine: EngineId;
  /** The model its steps requested of the engine. */
  model: string;
}

/** One condition's verified success on an engine: passes over scored trials, with what was left out beside it. */
export interface ConditionSuccess {
  condition: Exclude<ConditionId, "baseline">;
  /** Trials that ended, however they ended. */
  trials: number;
  scored: number;
  passes: number;
  /** `passes` over `scored`; null when nothing was scored. */
  successRate: number | null;
  harnessIncidents: number;
  /** Trials with nothing to score; an engine found unavailable when the trial started is one (`setup_failed`). */
  unscored: number;
  /** Cells left out for their incident rate (the suite's `maxIncidentRate`). */
  invalidCells: number;
}

/** What an evaluation says of one engine's verified success. */
export interface VerifiedSuccess {
  evaluationId: string;
  suite: string;
  model: string;
  /** Each version the engine said it was when a trial started, and the trials that read it. */
  versions: { version: string | null; trials: number }[];
  /** Trials that found the engine not serving the model; they were not scored. */
  unavailableTrials: number;
  conditions: ConditionSuccess[];
}

/** Two engines' verified success under one condition, task by task. */
export interface VerifiedComparison {
  condition: Exclude<ConditionId, "baseline">;
  a: EngineId;
  b: EngineId;
  comparison: PairedComparison;
}

/** The engine records of an evaluation's trials, every one. */
const recordsOf = (view: EvaluationView): LocalEngineRecord[] => view.trials.flatMap((trial) => trial.tools.flatMap((tool) => tool.engines ?? []));

/** The engine and model an evaluation ran on, when it ran on exactly one of each; else why it cannot be reported by engine. */
function engineOf(view: EvaluationView): { engine: EngineId; model: string } | { problem: string } {
  const records = recordsOf(view);
  const engines = [...new Set(records.map((record) => record.engine))];
  const models = [...new Set(records.map((record) => record.model))];
  if (engines.length === 0) return { problem: `evaluation ${view.evaluationId} ran on no local engine (its trials recorded none): only an evaluation through OpenCode's localEndpoint can be put beside a bench` };
  if (engines.length > 1) return { problem: `evaluation ${view.evaluationId} ran on more than one engine (${engines.join(", ")}): its verified success is not one engine's` };
  if (models.length > 1) return { problem: `evaluation ${view.evaluationId} asked ${ENGINE_NAMES[engines[0]!]} for more than one model (${models.join(", ")})` };
  return { engine: engines[0]!, model: models[0]! };
}

const tasksOf = (view: EvaluationView) => view.tasks.map((task) => ({ id: task.id, hash: task.hash })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

/**
 * Why these evaluations cannot be put beside these benches: one that ran on the mock adapter, on no local engine or on several, the same engine in
 * two of them, an engine none of the benches measured or measured with another model, or tasks that are not the same (by
 * freeze hash), since engines are compared task by task.
 */
export function verifiedProblems(benches: readonly BenchView[], evaluations: readonly EvaluationView[]): string[] {
  const problems: string[] = [];
  const benchModel = new Map(benches.flatMap((bench) => bench.engines.map((engine) => [engine.engine, engine.model] as const)));
  const seen = new Map<EngineId, string>();
  const [first] = evaluations;
  for (const view of evaluations) {
    if (view.mock) {
      problems.push(`evaluation ${view.evaluationId} ran on the mock adapter: its results are not evidence of any engine`);
      continue;
    }
    const found = engineOf(view);
    if ("problem" in found) {
      problems.push(found.problem);
      continue;
    }
    const earlier = seen.get(found.engine);
    if (earlier !== undefined) problems.push(`engine ${found.engine} is in both evaluation ${earlier} and evaluation ${view.evaluationId}: a report holds each engine once`);
    else seen.set(found.engine, view.evaluationId);
    const measured = benchModel.get(found.engine);
    if (measured === undefined) problems.push(`evaluation ${view.evaluationId} ran on ${found.engine}, which none of the benches measured: its verified success would stand beside no speed`);
    else if (measured !== found.model) problems.push(`evaluation ${view.evaluationId} asked ${found.engine} for ${found.model}, and the bench measured ${measured}: the success and the speed would be of different models`);
    if (first && view !== first && JSON.stringify(tasksOf(view)) !== JSON.stringify(tasksOf(first))) {
      problems.push(`evaluation ${view.evaluationId} differs from ${first.evaluationId} in its tasks (their ids or freeze hashes): engines are compared task by task`);
    }
  }
  return problems;
}

/** The reference of an evaluation that `verifiedProblems` accepted. */
export function evaluationReferenceOf(view: EvaluationView): EvaluationReference {
  const found = engineOf(view) as { engine: EngineId; model: string };
  return { evaluationId: view.evaluationId, suite: view.suite, state: view.state, reason: view.reason, seed: view.seed, engine: found.engine, model: found.model };
}

/** An accepted evaluation's verified success per condition, its engine's versions and the trials that found it unavailable. */
export function verifiedSuccessOf(view: EvaluationView): VerifiedSuccess {
  const records = recordsOf(view);
  const versions: VerifiedSuccess["versions"] = [];
  for (const record of records.filter((candidate) => candidate.available)) {
    const read = versions.find((candidate) => candidate.version === record.version);
    if (read) read.trials += 1;
    else versions.push({ version: record.version, trials: 1 });
  }
  const report = evaluationReportOf(view);
  return {
    evaluationId: view.evaluationId,
    suite: view.suite,
    model: evaluationReferenceOf(view).model,
    versions,
    unavailableTrials: view.trials.filter((trial) => trial.tools.some((tool) => (tool.engines ?? []).some((engine) => !engine.available))).length,
    conditions: report.conditions.map((condition) => ({
      condition: condition.condition,
      trials: condition.trials,
      scored: condition.scored,
      passes: condition.passes,
      successRate: condition.successRate,
      harnessIncidents: condition.harnessIncidents.count,
      unscored: condition.unscored.count,
      invalidCells: condition.invalidCells.length,
    })),
  };
}

/**
 * Each pair of engines, in `ENGINES` order, compared under each condition both evaluations ran (the baseline aside): the mean
 * over tasks of the difference in verified success, with its paired bootstrap interval, as `ahp eval` compares conditions.
 */
export function verifiedComparisonsOf(evaluations: readonly EvaluationView[], seed: number): VerifiedComparison[] {
  const byEngine = evaluations.map((view) => ({ view, engine: evaluationReferenceOf(view).engine })).sort((x, y) => ENGINES.indexOf(x.engine) - ENGINES.indexOf(y.engine));
  const comparisons: VerifiedComparison[] = [];
  for (const condition of CONDITIONS) {
    if (condition === "baseline") continue;
    const running = byEngine.filter(({ view }) => view.conditions.includes(condition));
    for (const [i, a] of running.entries()) {
      for (const b of running.slice(i + 1)) {
        comparisons.push({ condition, a: a.engine, b: b.engine, comparison: comparePaired(talliesOf(a.view, condition, null), talliesOf(b.view, condition, null), seed) });
      }
    }
  }
  return comparisons;
}
