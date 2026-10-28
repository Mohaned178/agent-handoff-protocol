import { afterEach, describe, expect, it } from "vitest";
import { formatReport, replayEvaluation, SuiteInvalidError, type EvaluationEvent, type TrialSlot } from "../src/evaluation/index.ts";
import { APPROVES, DOES_NOTHING, evaluate, GREETS, greetingTaskDir, IMPLEMENTS, PLANS, runOf, scripted, suiteOf, writeTree } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";
import { runEvaluation } from "../src/evaluation/index.ts";

afterEach(removeTempRepos);

const scheduledOf = (events: EvaluationEvent[]) => {
  const scheduled = events.find((event) => event.type === "trials_scheduled");
  if (scheduled?.type !== "trials_scheduled") throw new Error("no trials_scheduled");
  return scheduled;
};
const slotOf = (trial: { taskId: string; condition: string; repeat: number }) => `${trial.taskId} ${trial.condition} #${trial.repeat}`;

describe("repeats in a seeded order", () => {
  const twoTasks = () => suiteOf([greetingTaskDir({ id: "one" }), greetingTaskDir({ id: "two" })], { implement: scripted(GREETS) }, { conditions: ["C0"], repeats: 3 });

  it("runs every task under every condition once per repeat, in the shuffled order recorded before the first trial", async () => {
    const { events, types, state, report } = await evaluate(twoTasks(), { seed: 2026 });

    const scheduled = scheduledOf(events);
    expect(types.indexOf("trials_scheduled")).toBe(types.lastIndexOf("task_frozen") + 1);
    expect(types.indexOf("trials_scheduled")).toBeLessThan(types.indexOf("trial_started"));
    expect(scheduled.seed).toBe(2026);
    expect(scheduled.order.map(slotOf).sort()).toEqual(["one C0 #1", "one C0 #2", "one C0 #3", "two C0 #1", "two C0 #2", "two C0 #3"]);
    // The trials ran in exactly the recorded order.
    expect(state.trials.map(slotOf)).toEqual(scheduled.order.map(slotOf));
    expect(report).toMatchObject({ repeats: 3, seed: 2026, conditions: [{ condition: "C0", trials: 6, scored: 6, passes: 6 }] });
  });

  it("gives the same order for the same seed, another for another seed, and records a seed it drew when none is given", async () => {
    // The order is recorded before the first trial, so these evaluations are cancelled before any trial runs.
    const cancelled = new AbortController();
    cancelled.abort();
    const orderOf = async (seed: number | undefined) => scheduledOf((await evaluate(twoTasks(), { seed, signal: cancelled.signal })).events);

    const [first, again, other, drawn] = [await orderOf(11), await orderOf(11), await orderOf(12), await orderOf(undefined)];

    expect(again.order).toEqual(first.order);
    expect(other.order.map(slotOf)).not.toEqual(first.order.map(slotOf));
    expect(Number.isSafeInteger(drawn.seed) && drawn.seed >= 0 && drawn.seed <= 0xffffffff).toBe(true);
  });

  it("refuses a seed or a number of repeats it cannot use, before anything is written", async () => {
    const out = writeTree({});
    await expect(runEvaluation(twoTasks(), { out, seed: -1 })).rejects.toThrow(SuiteInvalidError);
    await expect(runEvaluation({ ...twoTasks(), repeats: 0 }, { out })).rejects.toThrow(/`repeats` must be a positive integer/);
  });

  it("refuses to replay a ledger whose trials did not start in the recorded order", async () => {
    const { events } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"], repeats: 3 }));
    const started = events.filter((event) => event.type === "trial_started");
    // The second trial to start claims to be the third scheduled.
    const third = started[2]!;
    const tampered = events.map((event) => (event === started[1] ? { ...event, taskId: third.taskId, repeat: third.repeat } : event)) as EvaluationEvent[];

    expect(slotOf(third)).not.toBe(slotOf(started[1]!));
    expect(() => replayEvaluation(tampered)).toThrow(/the next trial scheduled is/);
  });
});

describe("the matched-budget baseline", () => {
  // C3's agents for every trial; C0's implementer passes only in the baseline trial named, so a cell's verdict can be steered.
  const agentsPassingIn = (passingIndex: number | null, more: { lost?: boolean } = {}) => ({
    plan: scripted(PLANS),
    review: scripted(APPROVES),
    implement: (_task: unknown, slot: TrialSlot) => {
      if (slot.condition === "C3") return scripted(IMPLEMENTS)();
      if (more.lost && slot.baselineIndex === 1) return scripted({ ...DOES_NOTHING, loseContact: true })();
      return scripted(slot.baselineIndex === passingIndex ? GREETS : DOES_NOTHING)();
    },
  });

  it("runs C0 as many times as the C3 trial made attempts, each drawn into the trials still to start, and passes the cell when any passes", async () => {
    const { dir, events, state, report } = await evaluate(suiteOf([greetingTaskDir()], agentsPassingIn(3), { conditions: ["C3", "baseline"], repeats: 2 }));

    const c3 = state.trials.filter((trial) => trial.condition === "C3");
    expect(c3.map((trial) => trial.ended!.attempts)).toEqual([3, 3]);
    const scheduled = events.filter((event) => event.type === "baseline_scheduled");
    expect(scheduled).toHaveLength(2);
    for (const [index, event] of scheduled.entries()) {
      expect(event).toMatchObject({ forTrialId: c3[index]!.id, taskId: "greeting", repeat: c3[index]!.repeat, trials: 3, positions: [expect.any(Number), expect.any(Number), expect.any(Number)] });
    }
    const baseline = state.trials.filter((trial) => trial.condition === "baseline");
    expect(baseline).toHaveLength(6);
    for (const trial of c3) {
      const cell = baseline.filter((candidate) => candidate.baseline!.forTrialId === trial.id);
      expect(cell.map((candidate) => [candidate.repeat, candidate.baseline!.index, candidate.baseline!.of]).sort()).toEqual([[trial.repeat, 1, 3], [trial.repeat, 2, 3], [trial.repeat, 3, 3]]);
      // Each starts after the trial it matches has ended.
      for (const candidate of cell) expect(candidate.startedAtSeq).toBeGreaterThan(trial.startedAtSeq);
    }
    // A baseline trial is C0's workflow, run on its own.
    const run = await runOf(dir, baseline[0]!);
    expect(run.workflowName).toBe("greeting-baseline");
    expect(run.steps.map((step) => step.id)).toEqual(["solve"]);
    // One trial in three passed in each cell: each cell passes.
    expect(report.baseline).toMatchObject({ completeCells: 2, passingCells: 2, successRate: 1, trials: 6 });
    expect(report.baseline!.cells.map((cell) => [cell.trials, cell.scored, cell.passes, cell.verdict])).toEqual([[3, 3, 1, "pass"], [3, 3, 1, "pass"]]);
    expect(formatReport(report)).toContain("verified success: 2 of 2 complete cells (100%), a cell passing when any of its trials passed");
  });

  it("fails a cell none of whose trials passed, and leaves out a cell one of whose trials was a harness incident", async () => {
    const failing = await evaluate(suiteOf([greetingTaskDir()], agentsPassingIn(null), { conditions: ["C3", "baseline"] }));
    expect(failing.report.baseline).toMatchObject({ completeCells: 1, passingCells: 0, successRate: 0 });

    const lost = await evaluate(suiteOf([greetingTaskDir()], agentsPassingIn(2, { lost: true }), { conditions: ["C3", "baseline"] }));
    // Its second trial passed, but the cell was not given all three of its attempts: it is not scored either way.
    expect(lost.report.baseline).toMatchObject({ completeCells: 0, successRate: null, harnessIncidents: { count: 1 } });
    expect(lost.report.baseline!.cells[0]).toMatchObject({ passes: 1, verdict: null, incomplete: "1 of its 3 trials were not scored" });
    expect(formatReport(lost.report)).toContain("greeting #1: incomplete, left out: 1 of its 3 trials were not scored");
  });

  it("schedules no baseline for a C3 trial that was not scored", async () => {
    const agents = { plan: scripted(PLANS), review: scripted(APPROVES), implement: scripted({ ...IMPLEMENTS, loseContact: true }) };

    const { types, report } = await evaluate(suiteOf([greetingTaskDir()], agents, { conditions: ["C3", "baseline"] }));

    expect(types).not.toContain("baseline_scheduled");
    expect(report.baseline).toMatchObject({ cells: [], completeCells: 0, successRate: null });
  });

  it("needs C3 to match", async () => {
    await expect(runEvaluation(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0", "baseline"] }), { out: writeTree({}) })).rejects.toThrow(/`baseline`\) needs C3/);
  });
});
