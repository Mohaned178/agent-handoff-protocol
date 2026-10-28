import { afterEach, describe, expect, it } from "vitest";
import { formatReport, type TrialSlot } from "../src/evaluation/index.ts";
import { MOCK_USAGE_SOURCE } from "../src/index.ts";
import { money, sourcesText } from "../src/evaluation/report.ts";
import { APPROVES, DOES_NOTHING, evaluate, GREETS, greetingTaskDir, IMPLEMENTS, PLANS, REQUESTS_CHANGES, scripted, suiteOf } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const c3Agents = (...implement: Parameters<typeof scripted>) => ({ plan: scripted(PLANS), implement: scripted(...implement), review: scripted(APPROVES) });

describe("what a trial measures beside its score", () => {
  it("counts a failed attempt's lines as duplicated work, and its retry toward retries per success", async () => {
    const wrong = { ...IMPLEMENTS, edits: [{ path: "greeting.txt", content: "wrong\nwrong\n" }] };

    const { state, report } = await evaluate(suiteOf([greetingTaskDir()], c3Agents(wrong, IMPLEMENTS), { conditions: ["C3"] }));

    // The first implement attempt wrote two lines that the retry, from the same base, wrote again differently.
    expect(state.trials[0]!.ended).toMatchObject({ attempts: 4, retries: 1, work: { result: 1, duplicated: 2, reverted: 0 } });
    expect(report.conditions[0]).toMatchObject({ attempts: 4, retries: 1, passes: 1, retriesPerSuccess: 1, work: { trials: 1, result: 1, duplicated: 2, reverted: 0 } });
    expect(formatReport(report)).toContain("retries: 1 in 4 attempts of 1 scored trial; per success: 1.00 (1 over 1 pass)");
    expect(formatReport(report)).toContain("work in lines, over 1 scored trial: result 1, duplicated 2, reverted 0");
  });

  it("counts lines a later step took back out of the result as reverted work, and a sent-back result as duplicated", async () => {
    const withDraft = { ...IMPLEMENTS, edits: [...IMPLEMENTS.edits!, { path: "draft.txt", content: "one\ntwo\n" }] };
    // The mock does nothing about the review's read-only limit: this reviewer deletes the draft the implementer left.
    const tidies = { ...APPROVES, deletes: ["draft.txt"] };
    const agents = { plan: scripted(PLANS), implement: scripted(withDraft, IMPLEMENTS), review: scripted(REQUESTS_CHANGES, tidies) };

    const { state } = await evaluate(suiteOf([greetingTaskDir()], agents, { conditions: ["C3"] }));

    // Sent back once: the first implement attempt's 3 lines are not in the result's history, so they are duplicated work. The
    // second attempt wrote no draft, so the review that deletes it takes nothing out: nothing is reverted.
    expect(state.trials[0]!.ended!.work).toEqual({ result: 1, duplicated: 3, reverted: 0 });

    const reverting = { plan: scripted(PLANS), implement: scripted(withDraft), review: scripted(tidies) };
    const second = await evaluate(suiteOf([greetingTaskDir()], reverting, { conditions: ["C3"] }));
    // Implement wrote 3 lines and the review deleted 2 of them: 5 lines of work in the result's history for a result of 1.
    expect(second.state.trials[0]!.ended!.work).toEqual({ result: 1, duplicated: 0, reverted: 4 });
  });

  it("measures each run's wall time and reports its median and mean over the scored trials", async () => {
    const { state, report } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"], repeats: 2 }));

    for (const trial of state.trials) expect(trial.ended!.wallTimeMs).toBeGreaterThan(0);
    expect(report.conditions[0]!.wallTime).toMatchObject({ measured: 2, medianMs: expect.any(Number), meanMs: expect.any(Number) });
    expect(formatReport(report)).toMatch(/wall time: median \d+\.\d s, mean \d+\.\d s, over 2 scored trials/);
  });

  it("sums usage only as reported, per adapter, saying how many attempts reported each number, and estimates nothing", async () => {
    const reports = { ...GREETS, usage: { inputTokens: 100, outputTokens: 20, cost: { amount: 0.5, currency: "USD" } } };
    const silent = GREETS;
    const implement = (_task: unknown, slot: TrialSlot) => scripted(slot.repeat === 1 ? reports : silent)();

    const { state, report } = await evaluate(suiteOf([greetingTaskDir()], { implement }, { conditions: ["C0"], repeats: 2 }));

    expect(state.trials.flatMap((trial) => trial.ended!.usage.map((entry) => entry.usage === null))).toEqual(expect.arrayContaining([true, false]));
    expect(report.conditions[0]!.usage).toEqual([
      {
        adapter: "mock",
        attempts: 2,
        reported: 1,
        sources: [MOCK_USAGE_SOURCE],
        counts: { inputTokens: { sum: 100, attempts: 1 }, outputTokens: { sum: 20, attempts: 1 }, cachedInputTokens: { sum: 0, attempts: 0 }, totalTokens: { sum: 0, attempts: 0 } },
        cost: [{ currency: "USD", amount: 0.5, attempts: 1 }],
      },
    ]);
    expect(formatReport(report)).toContain(`mock: 1 of 2 attempts reported; inputTokens 100 (1), outputTokens 20 (1), cost 0.5 USD (1); source: ${MOCK_USAGE_SOURCE}`);
  });
});

describe("the paired comparisons in the report", () => {
  // C0's implementer passes on the tasks named; C3's always does.
  const suiteWhereC0Passes = (passing: string[], tasks = ["one", "two"]) =>
    suiteOf(
      tasks.map((id) => greetingTaskDir({ id })),
      {
        plan: scripted(PLANS),
        review: scripted(APPROVES),
        implement: (task: { id: string }, slot: TrialSlot) => scripted(slot.condition === "C3" ? IMPLEMENTS : passing.includes(task.id) ? GREETS : DOES_NOTHING)(),
      },
      { conditions: ["C0", "C3"] },
    );

  it("says C3's rate is higher when it passes every task C0 fails, with the raw counts beside each rate", async () => {
    const { report } = await evaluate(suiteWhereC0Passes([]), { seed: 3 });

    expect(report.comparisons).toEqual([
      expect.objectContaining({ a: "C3", b: "C0", meanDifference: 1, interval: [1, 1], finding: "higher", seed: 3, resamples: 10000 }),
    ]);
    const text = formatReport(report);
    expect(text).toContain("C3 vs C0: C3's success rate is higher than C0's: mean paired difference +1.00, 95% interval +1.00 to +1.00, over 2 tasks");
    expect(text).toContain("one: C3 1 of 1 scored trials (100%), 0 incidents; C0 0 of 1 scored trials (0%), 0 incidents; difference +1.00");
    expect(text).toContain("10,000 resamples, seed 3");
  });

  it("says there is no detectable difference when the interval includes 0, and inconclusive with one task", async () => {
    const mixed = await evaluate(suiteWhereC0Passes(["one", "two"]));
    expect(mixed.report.comparisons[0]).toMatchObject({ meanDifference: 0, finding: "no_detectable_difference" });
    expect(formatReport(mixed.report)).toContain("C3 vs C0: no detectable difference: mean paired difference 0.00, 95% interval 0.00 to 0.00, over 2 tasks");

    const single = await evaluate(suiteWhereC0Passes([], ["one"]));
    expect(single.report.comparisons[0]).toMatchObject({ finding: "too_few_tasks", interval: null });
    expect(formatReport(single.report)).toContain("C3 vs C0: inconclusive: 1 task with valid trials under both, too few for an interval");
  });

  it("compares the baseline by its complete cells, and leaves out a task with no valid trial on a side", async () => {
    const agents = {
      plan: scripted(PLANS),
      review: scripted(APPROVES),
      implement: (task: { id: string }, slot: TrialSlot) =>
        slot.condition === "C3" ? scripted(task.id === "lost" ? { ...IMPLEMENTS, loseContact: true } : IMPLEMENTS)() : scripted(GREETS)(),
    };

    const { report } = await evaluate(suiteOf([greetingTaskDir({ id: "fine" }), greetingTaskDir({ id: "lost" })], agents, { conditions: ["C3", "baseline"] }));

    const comparison = report.comparisons.find((candidate) => candidate.b === "baseline")!;
    expect(comparison.tasks).toEqual([{ taskId: "fine", a: { passes: 1, valid: 1, incidents: 0, rate: 1 }, b: { passes: 1, valid: 1, incidents: 0, rate: 1 }, difference: 0 }]);
    expect(comparison.excluded).toEqual([{ taskId: "lost", reason: "none_in_either" }]);
    expect(formatReport(report)).toContain("lost: left out, no valid trial under either");
  });
});

describe("the report's display of usage", () => {
  it("shows source labels that differ only in numbers once, and rounds money sums", () => {
    const a = "result event (usage); cache writes (5305 reported, not included); apiKeySource none";
    const b = "result event (usage); cache writes (11508 reported, not included); apiKeySource none";
    expect(sourcesText([a, b])).toBe("result event (usage); cache writes (… reported, not included); apiKeySource none");
    expect(sourcesText([a, "another source"])).toBe(`${a}; another source`);
    expect(money(0.7613190000000001)).toBe("0.761319");
    expect(money(12)).toBe("12");
  });
});
