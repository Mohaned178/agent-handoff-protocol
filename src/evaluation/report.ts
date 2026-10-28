// The report: what an evaluation's ledger says, per condition, with the raw counts beside every rate, and the paired per-task
// comparisons of verified success between conditions (ticket 21). A comparison says a rate is higher or lower only when its
// interval excludes 0; otherwise it says there is no detectable difference, and with too few tasks it says that.

import type { FailureClass, PathChange } from "../protocol/index.ts";
import type { AttemptUsage, ConditionId, UnscoredReason } from "./events.ts";
import type { EvaluationState, EvaluationView, TrialView } from "./replay.ts";
import { byPath } from "./freeze.ts";
import { BOOTSTRAP_RESAMPLES, comparePaired, type PairedComparison, type PairingGap, type TaskTally } from "./statistics.ts";

/**
 * How the run of a scored trial that failed ended: the failure class of its failed step, or, when no step failed,
 * `run_succeeded` (the run passed its own checks and the validators did not) or `run_failed` (it failed with no class).
 */
export type FailureOutcome = FailureClass | "run_succeeded" | "run_failed";

/** A condition proper, which is scored trial by trial; the baseline is scored by cell (`BaselineReport`). */
export type TrialCondition = Exclude<ConditionId, "baseline">;

/** The token counts a tool may report; each is summed only over the attempts that reported it, and says how many did. */
export const USAGE_COUNTS = ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"] as const;
export type UsageCount = (typeof USAGE_COUNTS)[number];

/**
 * What the attempts on one adapter reported using, as reported: never estimated, never summed across adapters (their units
 * differ: one counts cached input inside its input tokens, another outside), and not compared between conditions.
 */
export interface UsageSummary {
  adapter: string;
  attempts: number;
  /** Of those, the attempts that reported any usage. */
  reported: number;
  /** The sources the numbers came from, in the adapter's words. */
  sources: string[];
  counts: Record<UsageCount, { sum: number; attempts: number }>;
  /** Per currency, as reported. */
  cost: { currency: string; amount: number; attempts: number }[];
}

/** A run's wall time, from its creation to its end, over the trials that measured one. */
export interface WallTime {
  measured: number;
  medianMs: number | null;
  meanMs: number | null;
}

/** Trials that did not end in a score, which no rate counts. */
interface Exclusions {
  /** Trials ended by an `unknown` attempt: excluded from every count and reported apart (glossary: harness incident). */
  harnessIncidents: { count: number; trials: { trialId: string; taskId: string; attemptId: string; reason: string; detail: string }[] };
  /** Trials with nothing to score, by reason: excluded as well, and never counted as a pass or a fail. */
  unscored: { count: number; byReason: Partial<Record<UnscoredReason, number>>; trials: { trialId: string; taskId: string; reason: UnscoredReason; detail: string }[] };
  cancelled: number;
  /** Trials that were scheduled and never started: the evaluation stopped or was cancelled first. */
  notRun: number;
}

/**
 * A cell (one task under one condition) whose harness incidents are more than the suite's `maxIncidentRate` of its ended
 * trials (cancelled ones aside): its trials are in no rate and no comparison, because what is left of it is a biased sample.
 */
export interface InvalidCell {
  taskId: string;
  incidents: number;
  /** The cell's ended trials, incidents included. */
  trials: number;
  /** The scored trials left out of the rates because of it. */
  leftOut: number;
}

/** What the tools reported spending, against the suite's cap; present only for a suite with a `spendCap`. */
export interface SpendReport {
  cap: { amount: number; currency: string };
  /** The cost the tools reported in the cap's currency; an attempt that reported none adds nothing, not zero. */
  reported: number;
  attemptsWithoutCost: number;
  /** True when the evaluation stopped because `reported` reached the cap. */
  capReached: boolean;
}

/** A tool the evaluation's trials ran on: the versions found across them, against the suite's pin. */
export interface ToolVersionReport {
  tool: string;
  pinned: string | null;
  /** Each version found and the trials that found it; `version` null for a trial that could not read one. */
  found: { version: string | null; trials: number }[];
  /** Trials whose version is not the pin (zero for an unpinned tool). */
  mismatchedTrials: number;
}

export interface ConditionReport extends Exclusions {
  condition: TrialCondition;
  /** Cells left out of every rate below and every comparison for their incident rate. */
  invalidCells: InvalidCell[];
  /** Trials that ended, however they ended. */
  trials: number;
  /** The valid trials: the validators ran to a result. Only these are in the rates and the measures below. */
  scored: number;
  passes: number;
  /** `passes` over `scored`; null when nothing was scored. */
  successRate: number | null;
  /**
   * The scored trials of tasks that plant at least one constraint, whose result changed something: the denominator of the
   * violation rate. A result that changed nothing holds every constraint vacuously (nothing was written to break one), so
   * counting it would lower the rate by failing to produce anything.
   */
  constraintTrials: number;
  /** Of those, the trials in which any planted constraint was violated. */
  constraintViolations: number;
  constraintViolationRate: number | null;
  /** The scored trials of tasks that plant a constraint whose result changed nothing, which `constraintTrials` leaves out. */
  unchangedResults: number;
  /** The scored trials that failed, by how their run ended. */
  failures: Partial<Record<FailureOutcome, number>>;
  /** Over the scored trials: their attempts, and the attempts beyond each step's first. */
  attempts: number;
  retries: number;
  /** `retries` over `passes`; null with no pass. */
  retriesPerSuccess: number | null;
  /** Lines of work over the scored trials whose work was counted (`TrialWork`). */
  work: { trials: number; result: number; duplicated: number; reverted: number };
  wallTime: WallTime;
  /** Over every trial that ended. */
  usage: UsageSummary[];
}

/** One cell of the matched-budget baseline: the C0 trials matching one scored C3 trial. */
export interface BaselineCell {
  forTrialId: string;
  taskId: string;
  repeat: number;
  /** The C0 trials scheduled: the attempts the C3 trial made. */
  trials: number;
  scored: number;
  passes: number;
  /** `pass` when any of its trials passed, `fail` when every one was scored and none did; null when it is incomplete. */
  verdict: "pass" | "fail" | null;
  /** Why the cell is left out: a trial that was not scored, or not run. Null for a complete cell. */
  incomplete: string | null;
  /** The sum of its trials' wall times; null unless every one measured one. */
  wallTimeMs: number | null;
}

export interface BaselineReport extends Exclusions {
  condition: "baseline";
  /** Tasks whose baseline trials had too high an incident rate: their cells are incomplete. */
  invalidCells: InvalidCell[];
  /** One per scored C3 trial whose baseline was scheduled. */
  cells: BaselineCell[];
  /** The cells whose every trial was scored: only these are in the rate. */
  completeCells: number;
  passingCells: number;
  successRate: number | null;
  /** The baseline's trials that ended, however they ended. */
  trials: number;
  /** Per complete cell: the sum of its trials' run wall times. */
  wallTime: WallTime;
  usage: UsageSummary[];
}

/** A paired comparison of verified success between two conditions, `a` against `b`. */
export interface ConditionComparison extends PairedComparison {
  a: ConditionId;
  b: ConditionId;
}

/**
 * The comparisons a report makes, `a` against `b`, when the evaluation ran both: full AHP against each alternative, and each
 * step of the ladder against the one below it (C2 against C1 is the envelope's effect, C3 against C2 the acceptance checks').
 */
export const COMPARISONS: readonly (readonly [ConditionId, ConditionId])[] = [
  ["C3", "C0"],
  ["C3", "baseline"],
  ["C3", "C1"],
  ["C3", "C2"],
  ["C2", "C1"],
  ["C1", "C0"],
];

export interface EvaluationReport {
  evaluationId: string;
  suite: string;
  state: EvaluationState;
  reason: string | null;
  /** True when any trial ran on the mock adapter: nothing in the report is evidence. */
  mock: boolean;
  repeats: number;
  /** The seed of the trial order and of the comparisons' resampling; null when no trial was scheduled. */
  seed: number | null;
  maxIncidentRate: number | null;
  spend: SpendReport | null;
  tools: ToolVersionReport[];
  conditions: ConditionReport[];
  /** Null when the evaluation had no matched-budget baseline. */
  baseline: BaselineReport | null;
  comparisons: ConditionComparison[];
  taskChanges: { taskId: string; frozenHash: string; foundHash: string | null; changed: { path: string; change: PathChange }[] }[];
}

const rateOf = (part: number, whole: number) => (whole === 0 ? null : part / whole);

const isScored = (trial: TrialView) => trial.ended?.outcome === "scored";
const isPass = (trial: TrialView) => isScored(trial) && trial.ended!.score!.verdict === "pass";

function wallTimeOf(times: readonly (number | null)[]): WallTime {
  const measured = times.filter((time): time is number => time !== null).sort((x, y) => x - y);
  if (measured.length === 0) return { measured: 0, medianMs: null, meanMs: null };
  const middle = Math.floor(measured.length / 2);
  const medianMs = measured.length % 2 === 1 ? measured[middle]! : (measured[middle - 1]! + measured[middle]!) / 2;
  return { measured: measured.length, medianMs, meanMs: measured.reduce((total, time) => total + time, 0) / measured.length };
}

function usageOf(trials: readonly TrialView[]): UsageSummary[] {
  const byAdapter = new Map<string, UsageSummary>();
  const attempts: AttemptUsage[] = trials.flatMap((trial) => trial.ended?.usage ?? []);
  for (const { adapter, usage } of attempts) {
    let summary = byAdapter.get(adapter);
    if (!summary) {
      const counts = Object.fromEntries(USAGE_COUNTS.map((count) => [count, { sum: 0, attempts: 0 }])) as UsageSummary["counts"];
      summary = { adapter, attempts: 0, reported: 0, sources: [], counts, cost: [] };
      byAdapter.set(adapter, summary);
    }
    summary.attempts += 1;
    if (!usage) continue;
    summary.reported += 1;
    if (!summary.sources.includes(usage.source)) summary.sources.push(usage.source);
    for (const count of USAGE_COUNTS) {
      const value = usage[count];
      if (value === null) continue;
      summary.counts[count].sum += value;
      summary.counts[count].attempts += 1;
    }
    if (usage.cost) {
      const cost = summary.cost.find((entry) => entry.currency === usage.cost!.currency);
      if (cost) {
        cost.amount += usage.cost.amount;
        cost.attempts += 1;
      } else summary.cost.push({ currency: usage.cost.currency, amount: usage.cost.amount, attempts: 1 });
    }
  }
  return [...byAdapter.values()].sort((x, y) => byPath(x.adapter, y.adapter));
}

function exclusionsOf(ended: readonly TrialView[], notRun: number): Exclusions {
  const incidents = ended.filter((trial) => trial.ended!.outcome === "harness_incident");
  const unscored = ended.filter((trial) => trial.ended!.outcome === "unscored");
  const byReason: Partial<Record<UnscoredReason, number>> = {};
  for (const trial of unscored) byReason[trial.ended!.unscored!.reason] = (byReason[trial.ended!.unscored!.reason] ?? 0) + 1;
  return {
    harnessIncidents: {
      count: incidents.length,
      trials: incidents.map((trial) => ({ trialId: trial.id, taskId: trial.taskId, attemptId: trial.incident!.attemptId, reason: trial.incident!.unknownReason, detail: trial.incident!.detail })),
    },
    unscored: {
      count: unscored.length,
      byReason,
      trials: unscored.map((trial) => ({ trialId: trial.id, taskId: trial.taskId, reason: trial.ended!.unscored!.reason, detail: trial.ended!.unscored!.detail })),
    },
    cancelled: ended.filter((trial) => trial.ended!.outcome === "cancelled").length,
    notRun,
  };
}

/** The cells of `condition` (one per task) that the suite's incident threshold makes invalid. */
function invalidCellsOf(view: EvaluationView, condition: ConditionId): InvalidCell[] {
  const max = view.safeguards.maxIncidentRate;
  if (max === null) return [];
  const cells: InvalidCell[] = [];
  for (const { id: taskId } of view.tasks) {
    const trials = view.trials.filter((trial) => trial.condition === condition && trial.taskId === taskId && trial.ended && trial.ended.outcome !== "cancelled");
    const incidents = trials.filter((trial) => trial.ended!.outcome === "harness_incident").length;
    if (trials.length > 0 && incidents / trials.length > max) cells.push({ taskId, incidents, trials: trials.length, leftOut: trials.filter(isScored).length });
  }
  return cells;
}

function conditionReportOf(view: EvaluationView, condition: TrialCondition, constrained: ReadonlySet<string>): ConditionReport {
  const ended = view.trials.filter((trial) => trial.condition === condition && trial.ended);
  const invalidCells = invalidCellsOf(view, condition);
  const invalid = new Set(invalidCells.map((cell) => cell.taskId));
  const scored = ended.filter(isScored).filter((trial) => !invalid.has(trial.taskId));
  const passes = scored.filter(isPass);
  const withConstraints = scored.filter((trial) => constrained.has(trial.taskId));
  const constrainedTrials = withConstraints.filter((trial) => trial.ended!.result!.changed);
  const violating = constrainedTrials.filter((trial) => trial.ended!.score!.constraints.some((constraint) => constraint.outcome === "violated"));
  const failures: Partial<Record<FailureOutcome, number>> = {};
  for (const trial of scored) {
    if (trial.ended!.score!.verdict !== "fail") continue;
    const how: FailureOutcome = trial.ended!.failureClass ?? (trial.ended!.runState === "succeeded" ? "run_succeeded" : "run_failed");
    failures[how] = (failures[how] ?? 0) + 1;
  }
  const retries = scored.reduce((total, trial) => total + trial.ended!.retries, 0);
  const counted = scored.filter((trial) => trial.ended!.work !== null);
  const sum = (part: "result" | "duplicated" | "reverted") => counted.reduce((total, trial) => total + trial.ended!.work![part], 0);
  return {
    condition,
    invalidCells,
    trials: ended.length,
    scored: scored.length,
    passes: passes.length,
    successRate: rateOf(passes.length, scored.length),
    constraintTrials: constrainedTrials.length,
    constraintViolations: violating.length,
    constraintViolationRate: rateOf(violating.length, constrainedTrials.length),
    unchangedResults: withConstraints.length - constrainedTrials.length,
    failures,
    attempts: scored.reduce((total, trial) => total + trial.ended!.attempts, 0),
    retries,
    retriesPerSuccess: rateOf(retries, passes.length),
    work: { trials: counted.length, result: sum("result"), duplicated: sum("duplicated"), reverted: sum("reverted") },
    wallTime: wallTimeOf(scored.map((trial) => trial.ended!.wallTimeMs)),
    usage: usageOf(ended),
    ...exclusionsOf(ended, (view.pending ?? []).filter((trial) => trial.condition === condition).length),
  };
}

function baselineReportOf(view: EvaluationView): BaselineReport {
  const trials = view.trials.filter((trial) => trial.condition === "baseline");
  const ended = trials.filter((trial) => trial.ended);
  const pending = (view.pending ?? []).filter((trial) => trial.condition === "baseline");
  const invalidCells = invalidCellsOf(view, "baseline");
  const invalid = new Set(invalidCells.map((cell) => cell.taskId));
  const cells = view.baselines.map((baseline): BaselineCell => {
    const ofCell = ended.filter((trial) => trial.baseline!.forTrialId === baseline.forTrialId);
    const scored = ofCell.filter(isScored).length;
    const passes = ofCell.filter(isPass).length;
    // A cell is scored only whole: one with a trial missing could not have had all of the C3 trial's attempts.
    const missing = baseline.trials - ofCell.length;
    const incomplete = invalid.has(baseline.taskId)
      ? "the baseline's trials of this task had too many harness incidents, so its cell is invalid"
      : missing > 0 ? `${missing} of its ${baseline.trials} trials never ended` : scored < baseline.trials ? `${baseline.trials - scored} of its ${baseline.trials} trials were not scored` : null;
    const times = ofCell.map((trial) => trial.ended!.wallTimeMs);
    return {
      forTrialId: baseline.forTrialId,
      taskId: baseline.taskId,
      repeat: baseline.repeat,
      trials: baseline.trials,
      scored,
      passes,
      verdict: incomplete !== null ? null : passes > 0 ? "pass" : "fail",
      incomplete,
      wallTimeMs: missing === 0 && times.every((time) => time !== null) ? times.reduce((total: number, time) => total + time!, 0) : null,
    };
  });
  const complete = cells.filter((cell) => cell.verdict !== null);
  const passing = complete.filter((cell) => cell.verdict === "pass");
  return {
    condition: "baseline",
    invalidCells,
    cells,
    completeCells: complete.length,
    passingCells: passing.length,
    successRate: rateOf(passing.length, complete.length),
    trials: ended.length,
    wallTime: wallTimeOf(complete.map((cell) => cell.wallTimeMs)),
    usage: usageOf(ended),
    ...exclusionsOf(ended, pending.length),
  };
}

/** Each task's passes, valid trials and incidents under `condition`: for the baseline, its complete cells and their verdicts. */
function talliesOf(view: EvaluationView, condition: ConditionId, baseline: BaselineReport | null): TaskTally[] {
  return view.tasks.map(({ id: taskId }) => {
    const trials = view.trials.filter((trial) => trial.condition === condition && trial.taskId === taskId && trial.ended);
    const incidents = trials.filter((trial) => trial.ended!.outcome === "harness_incident").length;
    if (condition !== "baseline" && invalidCellsOf(view, condition).some((cell) => cell.taskId === taskId)) return { taskId, passes: 0, valid: 0, incidents };
    if (condition === "baseline") {
      const cells = (baseline?.cells ?? []).filter((cell) => cell.taskId === taskId && cell.verdict !== null);
      return { taskId, passes: cells.filter((cell) => cell.verdict === "pass").length, valid: cells.length, incidents };
    }
    return { taskId, passes: trials.filter(isPass).length, valid: trials.filter(isScored).length, incidents };
  });
}

function spendOf(view: EvaluationView): SpendReport | null {
  const cap = view.safeguards.spendCap;
  if (!cap) return null;
  const reported = view.spend?.amount ?? 0;
  return { cap, reported, attemptsWithoutCost: view.spend?.attemptsWithoutCost ?? 0, capReached: view.reason?.startsWith("spend_cap") === true };
}

function toolsOf(view: EvaluationView): ToolVersionReport[] {
  const byTool = new Map<string, ToolVersionReport>();
  for (const trial of view.trials) {
    for (const record of trial.tools) {
      const entry = byTool.get(record.tool) ?? { tool: record.tool, pinned: record.pinned, found: [], mismatchedTrials: 0 };
      byTool.set(record.tool, entry);
      const version = entry.found.find((candidate) => candidate.version === record.found);
      if (version) version.trials += 1;
      else entry.found.push({ version: record.found, trials: 1 });
      if (record.matches === false) entry.mismatchedTrials += 1;
    }
  }
  return [...byTool.values()].sort((x, y) => byPath(x.tool, y.tool));
}

export function reportOf(view: EvaluationView): EvaluationReport {
  const constrained = new Set(view.tasks.filter((task) => task.constraints.length > 0).map((task) => task.id));
  const conditions = view.conditions.filter((condition): condition is TrialCondition => condition !== "baseline").map((condition) => conditionReportOf(view, condition, constrained));
  const baseline = view.conditions.includes("baseline") ? baselineReportOf(view) : null;
  const seed = view.seed;
  const comparisons =
    seed === null
      ? []
      : COMPARISONS.filter(([a, b]) => view.conditions.includes(a) && view.conditions.includes(b)).map(([a, b]): ConditionComparison => ({
          a,
          b,
          ...comparePaired(talliesOf(view, a, baseline), talliesOf(view, b, baseline), seed),
        }));
  return {
    evaluationId: view.evaluationId,
    suite: view.suite,
    state: view.state,
    reason: view.reason,
    mock: view.mock,
    repeats: view.repeats,
    seed,
    maxIncidentRate: view.safeguards.maxIncidentRate,
    spend: spendOf(view),
    tools: toolsOf(view),
    conditions,
    baseline,
    comparisons,
    taskChanges: view.taskChanges.map(({ taskId, frozenHash, foundHash, changed }) => ({ taskId, frozenHash, foundHash, changed })),
  };
}

/**
 * What `ahp eval` says before it starts: a scripted evaluation expects each tool to be logged in with an API key, so that the
 * trials stay within the vendors' terms and are billed where the provider's own limits can cap them. AHP reads no credential and
 * cannot check this.
 */
export const API_KEY_NOTICE =
  "ahp eval expects each coding-agent tool to be logged in with an API key configured in that tool, not a subscription login (a subscription's use falls under the vendor's terms, and its cost is not reported). AHP stores and reads no credential and cannot check this. Set a spend limit in each provider's console too: AHP only sees the cost a tool reports.";

export const MOCK_REPORT_NOTE = "These results come from the mock adapter. They are labelled [mock] and are not evidence.";

const CONDITION_NAMES: Record<ConditionId, string> = {
  C0: "single agent",
  C1: "plain-text pipeline",
  C2: "AHP handoffs, no acceptance checks or retry",
  C3: "full AHP",
  baseline: "matched-budget baseline: C0 as many times as C3 made attempts",
};

/** `n of d what (p%)`, or why there is no rate. */
const ratio = (part: number, whole: number, what: string) =>
  whole === 0 ? `n/a: no ${what}` : `${part} of ${whole} ${what} (${Math.round((100 * part) / whole)}%)`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A sum of money for reading: floating-point noise from adding many costs is rounded off (the ledger keeps the exact numbers). */
export const money = (amount: number): string => String(Number(amount.toFixed(6)));

/**
 * Source labels that differ only in their numbers (an adapter names per-attempt counts in its label) shown once, with
 * each number that varies between them replaced by "…".
 */
export function sourcesText(sources: readonly string[]): string {
  const groups = new Map<string, string[][]>();
  for (const source of sources) {
    const shape = source.replace(/\d+(\.\d+)?/g, "#");
    groups.set(shape, [...(groups.get(shape) ?? []), source.match(/\d+(\.\d+)?/g) ?? []]);
  }
  return [...groups].map(([shape, numbers]) => {
    let index = 0;
    return shape.replace(/#/g, () => {
      const values = new Set(numbers.map((list) => list[index]));
      index += 1;
      return values.size === 1 ? [...values][0]! : "…";
    });
  }).join("; ");
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;

function wallTimeLine(wallTime: WallTime, over: string): string {
  if (wallTime.medianMs === null) return `  wall time: n/a: no ${over} measured one`;
  return `  wall time: median ${seconds(wallTime.medianMs)}, mean ${seconds(wallTime.meanMs!)}, over ${wallTime.measured} ${over}`;
}

function usageLines(usage: readonly UsageSummary[]): string[] {
  if (usage.length === 0) return [];
  const lines = ["  usage, as each tool reported it (per adapter, not summed across adapters and not compared):"];
  for (const summary of usage) {
    if (summary.reported === 0) {
      lines.push(`    ${summary.adapter}: none reported by ${plural(summary.attempts, "attempt")}`);
      continue;
    }
    const counts = USAGE_COUNTS.filter((count) => summary.counts[count].attempts > 0).map((count) => `${count} ${summary.counts[count].sum} (${summary.counts[count].attempts})`);
    const costs = summary.cost.map((cost) => `cost ${money(cost.amount)} ${cost.currency} (${cost.attempts})`);
    lines.push(`    ${summary.adapter}: ${summary.reported} of ${plural(summary.attempts, "attempt")} reported; ${[...counts, ...costs].join(", ")}; source: ${sourcesText(summary.sources)}`);
  }
  return lines;
}

function exclusionLines(report: Exclusions & { invalidCells: InvalidCell[] }): string[] {
  const lines: string[] = [];
  for (const cell of report.invalidCells) {
    lines.push(`  INVALID CELL ${cell.taskId}: ${cell.incidents} of ${plural(cell.trials, "ended trial")} were harness incidents, over the threshold; its ${plural(cell.leftOut, "scored trial")} left out of every rate and comparison`);
  }
  lines.push(`  harness incidents (excluded, not failures): ${report.harnessIncidents.count}`);
  for (const incident of report.harnessIncidents.trials) lines.push(`    ${incident.taskId}: attempt ${incident.attemptId} unknown (${incident.reason}): ${incident.detail}`);
  lines.push(`  unscored (excluded, not failures): ${report.unscored.count}`);
  for (const trial of report.unscored.trials) lines.push(`    ${trial.taskId}: ${trial.reason}: ${trial.detail}`);
  if (report.cancelled > 0) lines.push(`  cancelled: ${report.cancelled}`);
  if (report.notRun > 0) lines.push(`  scheduled and never run: ${report.notRun}`);
  return lines;
}

function findingText(comparison: ConditionComparison): string {
  const { a, b } = comparison;
  switch (comparison.finding) {
    case "higher":
      return `${a}'s success rate is higher than ${b}'s`;
    case "lower":
      return `${a}'s success rate is lower than ${b}'s`;
    case "no_detectable_difference":
      return "no detectable difference";
    case "too_few_tasks":
      return `inconclusive: ${plural(comparison.tasks.length, "task")} with valid trials under both, too few for an interval`;
  }
}

function comparisonLines(comparison: ConditionComparison): string[] {
  const { a, b } = comparison;
  const headline =
    comparison.meanDifference === null
      ? ""
      : `: mean paired difference ${signed(comparison.meanDifference)}${comparison.interval ? `, 95% interval ${signed(comparison.interval[0])} to ${signed(comparison.interval[1])}` : ""}, over ${plural(comparison.tasks.length, "task")}`;
  const lines = [`  ${a} vs ${b}: ${findingText(comparison)}${headline}`];
  const valid = (side: ConditionId) => (side === "baseline" ? "complete cells" : "scored trials");
  for (const task of comparison.tasks) {
    const side = (name: ConditionId, counts: (typeof task)["a"]) => `${name} ${ratio(counts.passes, counts.valid, valid(name))}, ${plural(counts.incidents, "incident")}`;
    lines.push(`    ${task.taskId}: ${side(a, task.a)}; ${side(b, task.b)}; difference ${signed(task.difference)}`);
  }
  const gap: Record<PairingGap, string> = { none_in_a: `no valid trial under ${a}`, none_in_b: `no valid trial under ${b}`, none_in_either: "no valid trial under either" };
  for (const task of comparison.excluded) lines.push(`    ${task.taskId}: left out, ${gap[task.reason]}`);
  return lines;
}

/** The report as text for a person: rates always with their counts, exclusions always shown, comparisons said plainly. */
export function formatReport(report: EvaluationReport): string {
  const lines = [`Evaluation ${report.evaluationId}: suite "${report.suite}", ${report.state}${report.reason ? ` (${report.reason})` : ""}`];
  if (report.mock) lines.push(`[mock] ${MOCK_REPORT_NOTE}`);
  for (const change of report.taskChanges) {
    const found = change.foundHash === null ? "no longer readable" : `now hashes ${change.foundHash.slice(0, 12)}`;
    lines.push(`TASK CHANGED: "${change.taskId}" was frozen as ${change.frozenHash.slice(0, 12)} and ${found}; no further trial was started.`);
    for (const { path, change: how } of change.changed) lines.push(`  ${how}: ${path}`);
  }
  if (report.spend) {
    const { cap, reported, attemptsWithoutCost } = report.spend;
    lines.push(`Reported spend: ${money(reported)} ${cap.currency} of a cap of ${cap.amount}${report.spend.capReached ? ", reached: no further trial was started" : ""}. Only cost a tool reports is counted (${plural(attemptsWithoutCost, "attempt")} reported none in ${cap.currency}); the real limit is the one set in each provider's console.`);
  }
  for (const tool of report.tools) {
    const found = tool.found.map(({ version, trials }) => `${version ?? "unreadable"} (${plural(trials, "trial")})`).join(", ");
    const pin = tool.pinned === null ? "not pinned" : tool.mismatchedTrials > 0 ? `PINNED ${tool.pinned}, MISMATCH in ${plural(tool.mismatchedTrials, "trial")}` : `pinned ${tool.pinned}, matched`;
    lines.push(`Tool ${tool.tool}: ${found}; ${pin}`);
  }
  for (const condition of report.conditions) {
    lines.push("", `${condition.condition} (${CONDITION_NAMES[condition.condition]}): ${plural(condition.trials, "trial")}`);
    lines.push(`  verified success: ${ratio(condition.passes, condition.scored, "scored trials")}`);
    lines.push(`  constraint violations: ${ratio(condition.constraintViolations, condition.constraintTrials, "scored trials of tasks with planted constraints")}`);
    if (condition.unchangedResults > 0) lines.push(`  scored trials whose result changed nothing, left out of the violation rate: ${condition.unchangedResults}`);
    const failed = Object.entries(condition.failures);
    if (failed.length > 0) lines.push(`  failed trials by how their run ended: ${failed.map(([how, count]) => `${how} ${count}`).join(", ")}`);
    if (condition.scored > 0) {
      const perSuccess = condition.retriesPerSuccess === null ? "n/a: no pass" : `${condition.retriesPerSuccess.toFixed(2)} (${condition.retries} over ${plural(condition.passes, "pass")})`;
      lines.push(`  retries: ${condition.retries} in ${plural(condition.attempts, "attempt")} of ${plural(condition.scored, "scored trial")}; per success: ${perSuccess}`);
      if (condition.work.trials > 0) {
        lines.push(`  work in lines, over ${plural(condition.work.trials, "scored trial")}: result ${condition.work.result}, duplicated ${condition.work.duplicated}, reverted ${condition.work.reverted}`);
      }
    }
    lines.push(wallTimeLine(condition.wallTime, "scored trials"));
    lines.push(...usageLines(condition.usage));
    lines.push(...exclusionLines(condition));
  }
  const { baseline } = report;
  if (baseline) {
    lines.push("", `baseline (${CONDITION_NAMES.baseline}): ${plural(baseline.cells.length, "cell")} of ${plural(baseline.trials, "trial")} ended`);
    lines.push(`  verified success: ${ratio(baseline.passingCells, baseline.completeCells, "complete cells")}, a cell passing when any of its trials passed`);
    for (const cell of baseline.cells.filter((candidate) => candidate.incomplete !== null)) lines.push(`    ${cell.taskId} #${cell.repeat}: incomplete, left out: ${cell.incomplete}`);
    lines.push(wallTimeLine(baseline.wallTime, "complete cells (the sum of each cell's trials)"));
    lines.push(...usageLines(baseline.usage));
    lines.push(...exclusionLines(baseline));
  }
  if (report.comparisons.length > 0) {
    lines.push(
      "",
      `Paired comparisons of verified success, task by task (rate = passes over valid trials; 95% percentile bootstrap over tasks, ${BOOTSTRAP_RESAMPLES.toLocaleString("en-US")} resamples, seed ${report.seed}; each interval stands alone, with no correction for making several):`,
    );
    for (const comparison of report.comparisons) lines.push(...comparisonLines(comparison));
  }
  lines.push("", "Rates count only scored trials, and the baseline's only complete cells. An interval that includes 0 is no detectable difference.");
  return lines.join("\n");
}
