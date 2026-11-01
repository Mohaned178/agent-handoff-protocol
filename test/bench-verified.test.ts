import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { EvaluationView, LocalEngineRecord } from "../src/evaluation/index.ts";
import { BenchesNotComparableError, formatBenchReport, readBench, reportOf, type BenchView } from "../src/inference/index.ts";
import { answerOf, bench, benchOf, closeEngines, engineAt, fakeEngine, promptsDir } from "./helpers/bench.ts";
import { DOES_NOTHING, evaluate, GREETS, greetingTaskDir, scripted, suiteOf } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

// The evaluations are made once and shared (each is four trials); only the engine records differ between tests, set on a copy.
afterEach(closeEngines);
afterAll(removeTempRepos);

type Engine = "vllm" | "sglang" | "ollama";

/** A bench of one engine with the latency workload only (each workload's sampling stop costs seconds on Windows). */
async function benchOf1(engine: Engine): Promise<BenchView> {
  const fake = await fakeEngine({ chat: (body) => answerOf(body), version: { path: "/version", version: `${engine}-1.0` } });
  const result = await bench(benchOf([engineAt(engine, fake.baseURL)], promptsDir(), { workloads: ["latency"], repeats: 1, warmup: 0 }));
  return readBench(result.dir);
}

const record = (engine: Engine, extra: Partial<LocalEngineRecord> = {}): LocalEngineRecord => ({
  engine,
  name: { vllm: "vLLM", sglang: "SGLang", ollama: "Ollama" }[engine],
  baseURL: "http://127.0.0.1:1/v1",
  model: "fake-model",
  available: true,
  version: `${engine}-1.0`,
  error: null,
  ...extra,
});

/**
 * An evaluation over two tasks under C0 and C0V, played by the mock, then given the engine records its trials would have made on
 * `engine`: the report reads an evaluation's engine from those records alone. Not evidence of anything: a fixture for the report.
 */
const made = new Map<boolean, Promise<EvaluationView>>();
function evaluationOnce(passes: boolean): Promise<EvaluationView> {
  if (!made.has(passes)) {
    const script = passes ? GREETS : DOES_NOTHING;
    made.set(passes, evaluate(suiteOf([greetingTaskDir(), greetingTaskDir({ id: "greeting-2" })], { implement: scripted(script, script, script) }, { conditions: ["C0", "C0V"], retryBudget: 0 })).then(({ state }) => state));
  }
  return made.get(passes)!;
}

async function evaluationOn(engine: Engine, passes: boolean, records: (trialIndex: number) => LocalEngineRecord[] = () => [record(engine)]): Promise<EvaluationView> {
  const state = await evaluationOnce(passes);
  return { ...state, mock: false, trials: state.trials.map((trial, i) => ({ ...trial, tools: [{ tool: "opencode", pinned: null, found: "1.18.35", matches: null, problem: null, engines: records(i) }] })) };
}

describe("verified success beside speed (`bench report --eval`)", () => {
  it("puts each engine's verified success per condition beside its speed, and compares the engines task by task", async () => {
    const [vllm, sglang] = await Promise.all([benchOf1("vllm"), benchOf1("sglang")]);
    const [good, bad] = [await evaluationOn("vllm", true), await evaluationOn("sglang", false)];

    const report = reportOf([vllm, sglang], { evaluations: [bad, good] });

    expect(report.evaluations.map((e) => [e.engine, e.model])).toEqual([["sglang", "fake-model"], ["vllm", "fake-model"]]);
    const [first, second] = report.engines;
    expect(first!.verified).toMatchObject({ evaluationId: good.evaluationId, model: "fake-model", versions: [{ version: "vllm-1.0", trials: 4 }], unavailableTrials: 0 });
    expect(first!.verified!.conditions).toEqual([
      { condition: "C0", trials: 2, scored: 2, passes: 2, successRate: 1, harnessIncidents: 0, unscored: 0, invalidCells: 0 },
      { condition: "C0V", trials: 2, scored: 2, passes: 2, successRate: 1, harnessIncidents: 0, unscored: 0, invalidCells: 0 },
    ]);
    expect(second!.verified!.conditions.map((c) => [c.condition, c.passes, c.scored])).toEqual([["C0", 0, 2], ["C0V", 0, 2]]);
    // vLLM against SGLang (in ENGINES order), per condition, over the two tasks: every task passes on one side and fails on the other.
    expect(report.verifiedComparisons.map(({ condition, a, b, comparison }) => [condition, a, b, comparison.meanDifference, comparison.tasks.length, comparison.finding])).toEqual([
      ["C0", "vllm", "sglang", 1, 2, "higher"],
      ["C0V", "vllm", "sglang", 1, 2, "higher"],
    ]);

    const text = formatBenchReport(report);
    expect(text).toContain(`evaluation ${good.evaluationId} (suite "test-suite"): completed, seed 1, through OpenCode on vLLM (fake-model)`);
    expect(text).toContain("verified success on the evaluation's tasks");
    expect(text).toContain(`  vLLM (fake-model), evaluation ${good.evaluationId}; engine vllm-1.0 in 4 trials:\n    C0 2/2 (100.0%); C0V 2/2 (100.0%)\n    speed: time to first token p50 `);
    expect(text).toContain("  SGLang (fake-model)");
    expect(text).toContain("C0: vLLM vs SGLang: mean difference +1.000 [1.000, 1.000] over 2 tasks: vLLM higher");
  });

  it("counts the trials that found the engine unavailable apart, and says when an engine has no evaluation", async () => {
    const [vllm, sglang] = await Promise.all([benchOf1("vllm"), benchOf1("sglang")]);
    const down = await evaluationOn("vllm", true, (i) => [record("vllm", i === 0 ? { available: false, version: null, error: "GET x/models: connection refused" } : {})]);

    const report = reportOf([vllm, sglang], { evaluations: [down] });

    expect(report.engines[0]!.verified!.unavailableTrials).toBe(1);
    expect(report.engines[0]!.verified!.versions).toEqual([{ version: "vllm-1.0", trials: 3 }]);
    expect(report.verifiedComparisons).toEqual([]);
    expect(formatBenchReport(report)).toContain("  SGLang: no evaluation given");
  });

  it("refuses an evaluation that is the mock's, on no engine or several, on an engine twice, on one no bench measured or with another model, or on other tasks", async () => {
    const vllm = await benchOf1("vllm");
    const base = await evaluationOn("vllm", true);
    const problems = async (evaluations: EvaluationView[]) => {
      try {
        reportOf([vllm], { evaluations });
      } catch (error) {
        expect(error).toBeInstanceOf(BenchesNotComparableError);
        return (error as BenchesNotComparableError).problems;
      }
      return [];
    };

    const mock = { ...base, mock: true };
    expect(await problems([mock])).toEqual([expect.stringContaining("ran on the mock adapter")]);
    expect(await problems([await evaluationOn("vllm", true, () => [])])).toEqual([expect.stringContaining("ran on no local engine")]);
    expect(await problems([await evaluationOn("vllm", true, (i) => [record(i === 0 ? "sglang" : "vllm")])])).toEqual([expect.stringContaining("ran on more than one engine (sglang, vllm)")]);
    expect(await problems([base, base])).toEqual([expect.stringContaining("engine vllm is in both evaluation")]);
    expect(await problems([await evaluationOn("ollama", true)])).toEqual([expect.stringContaining("ran on ollama, which none of the benches measured")]);
    expect(await problems([await evaluationOn("vllm", true, () => [record("vllm", { model: "other" })])])).toEqual([expect.stringContaining("asked vllm for other, and the bench measured fake-model")]);
    const otherTasks = { ...(await evaluationOn("sglang", true)), evaluationId: "eval_other", tasks: base.tasks.map((task) => ({ ...task, hash: "0".repeat(64) })) };
    const sglang = await benchOf1("sglang");
    expect(() => reportOf([vllm, sglang], { evaluations: [base, otherTasks] })).toThrow(/differs from .* in its tasks/);
  });
});
