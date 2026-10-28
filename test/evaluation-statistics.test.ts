import { describe, expect, it } from "vitest";
import { BOOTSTRAP_RESAMPLES, comparePaired, pairedBootstrap, seededRandom, seededShuffle, type TaskTally } from "../src/evaluation/index.ts";

// A reference written from ticket 21's implementer notes, not imported: mulberry32 as published, a Fisher-Yates shuffle, and a
// paired bootstrap over tasks with 10,000 resamples and a percentile interval (the 250th and the 9,750th of the sorted means).
function referenceRandom(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function referenceBootstrap(differences: number[], seed: number) {
  const random = referenceRandom(seed);
  const means: number[] = [];
  for (let r = 0; r < 10000; r++) {
    let sum = 0;
    for (let i = 0; i < differences.length; i++) sum += differences[Math.floor(random() * differences.length)]!;
    means.push(sum / differences.length);
  }
  means.sort((x, y) => x - y);
  return [means[250]!, means[9749]!];
}

const tally = (taskId: string, passes: number, valid: number, incidents = 0): TaskTally => ({ taskId, passes, valid, incidents });

describe("the seeded generator and shuffle", () => {
  it("gives the same numbers for the same seed, mulberry32's, and others for another seed", () => {
    const first = seededRandom(42);
    const reference = referenceRandom(42);
    const numbers = Array.from({ length: 5 }, () => first());
    expect(numbers).toEqual(Array.from({ length: 5 }, () => reference()));
    expect(numbers[0]).toBe(0.6011037519201636);
    expect(seededRandom(43)()).not.toBe(numbers[0]);
    for (const n of numbers) expect(n >= 0 && n < 1).toBe(true);
  });

  it("shuffles into a fixed order for a seed, a permutation of the input, leaving the input alone", () => {
    const items = ["a", "b", "c", "d", "e", "f"];

    const once = seededShuffle(items, seededRandom(7));

    expect(once).toEqual(seededShuffle(items, seededRandom(7)));
    expect(once).toEqual(["e", "b", "c", "d", "f", "a"]);
    expect([...once].sort()).toEqual(items);
    expect(items).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("the paired bootstrap over tasks", () => {
  it("gives a fixed interval for fixed differences and a fixed seed, the reference's", () => {
    const differences = [0.5, 0, 1, -0.5, 0.25, 0, 0.75];

    const result = pairedBootstrap(differences, 2026);

    expect(result.mean).toBeCloseTo(2 / 7, 12);
    expect(result.interval).toEqual(referenceBootstrap(differences, 2026));
    expect(result.interval).toEqual([-0.07142857142857142, 0.6428571428571429]);
    expect(pairedBootstrap(differences, 2026)).toEqual(result);
    expect(BOOTSTRAP_RESAMPLES).toBe(10000);
  });

  it("has an interval of one point when every task differs by the same amount", () => {
    expect(pairedBootstrap([0.5, 0.5, 0.5], 1)).toEqual({ mean: 0.5, interval: [0.5, 0.5] });
    expect(pairedBootstrap([0, 0, 0, 0], 1)).toEqual({ mean: 0, interval: [0, 0] });
  });
});

describe("a paired comparison of two conditions", () => {
  it("finds a difference of 0, and says there is no detectable difference, for identical conditions", () => {
    const counts = [tally("a", 2, 3), tally("b", 0, 3), tally("c", 3, 3)];

    const comparison = comparePaired(counts, counts, 99);

    expect(comparison).toMatchObject({ meanDifference: 0, interval: [0, 0], finding: "no_detectable_difference", seed: 99, resamples: 10000 });
    expect(comparison.tasks.map((task) => task.difference)).toEqual([0, 0, 0]);
  });

  it("pairs by task, rates as passes over valid trials, keeps the raw counts, and leaves out a task with no valid trial on a side", () => {
    const a = [tally("t2", 1, 2, 1), tally("t1", 3, 3), tally("t3", 1, 1)];
    const b = [tally("t1", 0, 3), tally("t2", 1, 2), tally("t3", 0, 0, 2)];

    const comparison = comparePaired(a, b, 5);

    // Ordered by task id, whatever order the tallies came in, so the interval depends on the counts alone.
    expect(comparison.tasks).toEqual([
      { taskId: "t1", a: { passes: 3, valid: 3, incidents: 0, rate: 1 }, b: { passes: 0, valid: 3, incidents: 0, rate: 0 }, difference: 1 },
      { taskId: "t2", a: { passes: 1, valid: 2, incidents: 1, rate: 0.5 }, b: { passes: 1, valid: 2, incidents: 0, rate: 0.5 }, difference: 0 },
    ]);
    expect(comparison.excluded).toEqual([{ taskId: "t3", reason: "none_in_b" }]);
    expect(comparison.meanDifference).toBe(0.5);
    expect(comparison.interval).toEqual(referenceBootstrap([1, 0], 5));
  });

  it("reports a higher or a lower rate only when the interval excludes 0, and too few tasks below two", () => {
    expect(comparePaired([tally("a", 1, 1), tally("b", 1, 1)], [tally("a", 0, 1), tally("b", 0, 1)], 1).finding).toBe("higher");
    expect(comparePaired([tally("a", 0, 1), tally("b", 0, 1)], [tally("a", 1, 1), tally("b", 1, 1)], 1).finding).toBe("lower");
    expect(comparePaired([tally("a", 1, 1), tally("b", 0, 1)], [tally("a", 0, 1), tally("b", 1, 1)], 1).finding).toBe("no_detectable_difference");

    const one = comparePaired([tally("a", 1, 1)], [tally("a", 0, 1)], 1);
    expect(one).toMatchObject({ finding: "too_few_tasks", meanDifference: 1, interval: null });
  });
});
