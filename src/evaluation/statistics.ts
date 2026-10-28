// The statistics of an evaluation, exactly as ticket 21 fixes them, so that a report can be recomputed from its ledger:
// a seeded generator (mulberry32) for the trial order and the bootstrap, and paired per-task comparisons of success rates
// with a 95% percentile interval from a paired bootstrap over tasks. Pure: nothing here reads a clock or a file.

import { byPath } from "./freeze.ts";

/** How many times the tasks are resampled for an interval. */
export const BOOTSTRAP_RESAMPLES = 10_000;

/** A seed is an unsigned 32-bit integer, recorded in the evaluation's ledger. */
export const isSeed = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;

/** Mulberry32: a small, fast generator of numbers in [0, 1) that is the same everywhere for the same seed. Not for secrets. */
export function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number in [0, n), drawn from `random`. */
export const drawIndex = (random: () => number, n: number) => Math.floor(random() * n);

/** A copy of `items` in a Fisher-Yates order drawn from `random`: the last position first, each from those not yet placed. */
export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = drawIndex(random, i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * The mean of `differences` and its 95% percentile interval from `BOOTSTRAP_RESAMPLES` resamples, each drawing as many
 * differences as there are, with replacement, from a generator seeded with `seed`. The interval's ends are the 250th and the
 * 9,750th of the resampled means in ascending order (indices 250 and 9,749 counted from 0): 250 means lie below it and 250
 * above. `differences` must not be empty.
 */
export function pairedBootstrap(differences: readonly number[], seed: number): { mean: number; interval: [number, number] } {
  const n = differences.length;
  if (n === 0) throw new Error("a bootstrap needs at least one difference");
  const random = seededRandom(seed);
  const means = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += differences[drawIndex(random, n)]!;
    means[r] = sum / n;
  }
  means.sort();
  const sum = differences.reduce((total, difference) => total + difference, 0);
  return { mean: sum / n, interval: [means[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)]!, means[Math.ceil(0.975 * BOOTSTRAP_RESAMPLES) - 1]!] };
}

/** One task's trials under one side of a comparison: valid trials are the scored ones (harness incidents are never valid). */
export interface TaskTally {
  taskId: string;
  passes: number;
  valid: number;
  incidents: number;
}

/** A task's counts on one side of a comparison, with the rate they give. */
export type SideCounts = Omit<TaskTally, "taskId"> & { rate: number };

/** What a comparison concludes. Only an interval that excludes 0 says a rate is higher or lower. */
export const COMPARISON_FINDINGS = ["higher", "lower", "no_detectable_difference", "too_few_tasks"] as const;
export type ComparisonFinding = (typeof COMPARISON_FINDINGS)[number];

/** Why a task is left out of a comparison: no valid trial under `a`, under `b`, or under either. */
export const PAIRING_GAPS = ["none_in_a", "none_in_b", "none_in_either"] as const;
export type PairingGap = (typeof PAIRING_GAPS)[number];

/** Fewer tasks than this give no interval: every resample of one task is that task. */
export const MIN_PAIRED_TASKS = 2;

export interface PairedComparison {
  /** The tasks with a valid trial on both sides, by task id, each side's raw counts beside its rate. */
  tasks: { taskId: string; a: SideCounts; b: SideCounts; difference: number }[];
  /** The tasks left out, with the side or sides that had no valid trial of them. */
  excluded: { taskId: string; reason: PairingGap }[];
  /** The mean over `tasks` of rate(a) − rate(b); null with no task to pair. */
  meanDifference: number | null;
  /** The 95% interval of that mean; null with fewer than `MIN_PAIRED_TASKS` tasks. */
  interval: [number, number] | null;
  finding: ComparisonFinding;
  seed: number;
  resamples: number;
}

/**
 * Compares side `a` with side `b` task by task: each task's success rate on a side is its passes over its valid trials, the
 * paired difference is rate(a) − rate(b), and the headline is the mean difference over the tasks with a valid trial on both
 * sides, with its bootstrap interval. Tasks are taken in order of their id, so the interval depends on the counts alone.
 */
export function comparePaired(a: readonly TaskTally[], b: readonly TaskTally[], seed: number): PairedComparison {
  const ids = [...new Set([...a, ...b].map((tally) => tally.taskId))].sort(byPath);
  const tasks: PairedComparison["tasks"] = [];
  const excluded: PairedComparison["excluded"] = [];
  const sideOf = (tallies: readonly TaskTally[], taskId: string): SideCounts | null => {
    const found = tallies.find((tally) => tally.taskId === taskId);
    return found && found.valid > 0 ? { passes: found.passes, valid: found.valid, incidents: found.incidents, rate: found.passes / found.valid } : null;
  };
  for (const taskId of ids) {
    const left = sideOf(a, taskId);
    const right = sideOf(b, taskId);
    if (left && right) tasks.push({ taskId, a: left, b: right, difference: left.rate - right.rate });
    else excluded.push({ taskId, reason: !left && !right ? "none_in_either" : !left ? "none_in_a" : "none_in_b" });
  }
  const base = { tasks, excluded, seed, resamples: BOOTSTRAP_RESAMPLES };
  if (tasks.length === 0) return { ...base, meanDifference: null, interval: null, finding: "too_few_tasks" };
  const differences = tasks.map((task) => task.difference);
  if (tasks.length < MIN_PAIRED_TASKS) {
    return { ...base, meanDifference: differences.reduce((total, d) => total + d, 0) / differences.length, interval: null, finding: "too_few_tasks" };
  }
  const { mean, interval } = pairedBootstrap(differences, seed);
  const finding: ComparisonFinding = interval[0] > 0 ? "higher" : interval[1] < 0 ? "lower" : "no_detectable_difference";
  return { ...base, meanDifference: mean, interval, finding };
}
