import { afterEach, describe, expect, it } from "vitest";
import { COMPARISON_FINDINGS } from "../src/evaluation/statistics.ts";
import {
  BenchesNotComparableError,
  DEFAULT_REPORT_SEED,
  formatBenchReport,
  percentile,
  percentilesOf,
  readBench,
  reportOf,
  type BenchEvent,
  type BenchView,
} from "../src/inference/index.ts";
import { answerOf, bench, benchOf, closeEngines, engineAt, fakeEngine, promptsDir, toolCasesDir, type Behaviour } from "./helpers/bench.ts";
import { closedBaseURL } from "./helpers/fake-engine.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(async () => {
  await closeEngines();
  removeTempRepos();
});

describe("nearest-rank percentiles", () => {
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("take the value at rank ceil(p/100 × n) of the sorted values", () => {
    expect(percentilesOf(upTo(100))).toEqual({ n: 100, p50: 50, p95: 95, p99: 99 });
    expect(percentilesOf(upTo(10))).toEqual({ n: 10, p50: 5, p95: 10, p99: 10 });
    expect(percentilesOf(upTo(7))).toEqual({ n: 7, p50: 4, p95: 7, p99: 7 });
    expect(percentilesOf([42])).toEqual({ n: 1, p50: 42, p95: 42, p99: 42 });
  });

  it("sort their input, and do not change it", () => {
    const values = [30, 10, 20];
    expect(percentilesOf(values).p50).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  it("are null for no value, never 0", () => {
    expect(percentilesOf([])).toEqual({ n: 0, p50: null, p95: null, p99: null });
    expect(percentile([], 50)).toBeNull();
  });
});

// Each workload of a bench stops its sampling tools, which takes a second or more on Windows, so the benches these tests read
// are made once and shared; what only needs a different view (another machine, other settings) edits a view in memory.
type EngineName = "vllm" | "sglang" | "ollama";
interface Made {
  benchId: string;
  view: BenchView;
}
const made = new Map<string, Promise<Made>>();

/** One bench of one engine, made on first use. Same prompt files and tool-call cases (by bytes) every time. */
function benchOnce(key: string, engine: EngineName, behaviour: Behaviour, overrides: Parameters<typeof benchOf>[2] = {}, container?: string): Promise<Made> {
  if (!made.has(key)) {
    made.set(
      key,
      (async () => {
        const fake = await fakeEngine({ chat: (body) => answerOf(body, behaviour), version: { path: "/version", version: `${engine}-1.0` } });
        const file = benchOf([engineAt(engine, fake.baseURL, container ? { container } : {})], promptsDir(), { tools: toolCasesDir(), workloads: ["quality", "tools"], concurrency: [1, 2], repeats: 1, ...overrides });
        const result = await bench(file);
        return { benchId: result.benchId, view: await readBench(result.dir) };
      })(),
    );
  }
  return made.get(key)!;
}

const full = () => benchOnce("full", "vllm", { wrong: ["sub"] }, { workloads: ["latency", "throughput", "quality", "tools"], repeats: 2 }, "ahp-vllm");
const perfect = () => benchOnce("perfect", "vllm", {});
const weak = () => benchOnce("weak", "sglang", { wrong: ["sub", "mul"], wrongTool: ["files"] });
const failing = () => benchOnce("failing", "sglang", { fail: { add: 500 } });

describe("the report of one bench", () => {
  it("counts, per engine, the requests, the outcomes and the rates, with the numbers beside the rates", async () => {
    const { view } = await full();

    const report = reportOf([view]);
    const [engine] = report.engines;

    expect(engine).toMatchObject({ engine: "vllm", version: "vllm-1.0", available: true, model: "fake-model", quantization: "awq", container: "ahp-vllm" });
    expect(engine!.workloads).toMatchObject({ scheduled: 2 * 5, ended: 2 * 5, skipped: 0, neverRun: 0 });
    // Latency: 2 repeats × 3 prompts; every request ran to [DONE].
    expect(engine!.latency).toMatchObject({ requests: 6, succeeded: 6, failed: 0 });
    expect(engine!.latency!.ttftMs.n).toBe(6);
    expect(engine!.latency!.latencyMs.p50).not.toBeNull();
    // Throughput: levels 1 and 2, 2 repeats each; 4 requests per worker, at least one per prompt.
    expect(engine!.throughput.map((level) => [level.concurrency, level.workloads, level.timing.requests])).toEqual([[1, 2, 2 * 4], [2, 2, 2 * 8]]);
    expect(engine!.throughput[0]!.outputTokensPerSecond).toMatchObject({ n: 2 });
    // Quality: 2 repeats × 3 prompts, one prompt always wrong.
    expect(engine!.quality).toMatchObject({ workloads: 2, requests: 6, errors: 0, unscored: 0, scored: 6, passes: 4, outcomes: { pass: 4, fail: 2 } });
    expect(engine!.quality!.passRate).toBeCloseTo(4 / 6);
    expect(engine!.quality!.byPrompt).toEqual([
      { id: "add", passes: 2, scored: 2, errors: 0 },
      { id: "mul", passes: 2, scored: 2, errors: 0 },
      { id: "sub", passes: 0, scored: 2, errors: 0 },
    ]);
    expect(engine!.tools).toMatchObject({ scored: 4, passes: 4, outcomes: { valid_call: 4 } });
    expect(engine!.resources!.gpu!.memoryUsedMiB).not.toBeNull();
    expect(engine!.resources!.docker?.container).toBe("ahp-vllm");
    expect(report.comparisons).toEqual([]);
  });

  it("is the text a person reads: the counts beside every rate, and the percentile method", async () => {
    const text = formatBenchReport(reportOf([(await full()).view]));

    expect(text).toContain("nearest-rank");
    expect(text).toContain("quality: pass 4/6 (66.7%); fail 2; 0 engine errors of 6 requests over 2 workloads");
    expect(text).toContain("sub: 0/2");
    expect(text).toContain("tool calls: valid_call 4/4 (100.0%)");
    expect(text).toContain("c=2:");
    expect(text).toContain("GPU (nvidia-smi)");
    expect(text).toContain("container ahp-vllm (docker stats)");
  });

  it("keeps an engine error out of the rate's denominator and says how many there were", async () => {
    const report = reportOf([(await failing()).view]);
    expect(report.engines[0]!.quality).toMatchObject({ requests: 3, errors: 1, scored: 2, passes: 2, passRate: 1 });
    expect(formatBenchReport(report)).toContain("pass 2/2 (100.0%); 1 engine error of 3 requests");
  });

  it("lists an engine that was unavailable with its error, and no number for it", async () => {
    const file = benchOf([engineAt("sglang", await closedBaseURL())], promptsDir(), { tools: toolCasesDir(), workloads: ["latency", "quality"] });
    const result = await bench(file);
    const report = reportOf([await readBench(result.dir)]);
    expect(report.engines[0]).toMatchObject({ engine: "sglang", available: false, latency: null, quality: null, throughput: [] });
    expect(report.engines[0]!.workloads).toMatchObject({ skipped: 2, ended: 0 });
    expect(formatBenchReport(report)).toMatch(/SGLang.*\n  UNAVAILABLE: GET http:\/\/127\.0\.0\.1:\d+\/v1\/models/);
  });

  it("says a cancelled bench was cancelled and how many workloads never ran", async () => {
    const controller = new AbortController();
    const fake = await fakeEngine({ chat: (body) => answerOf(body) });
    const file = benchOf([engineAt("vllm", fake.baseURL)], promptsDir(), { tools: toolCasesDir(), workloads: ["quality", "tools"], repeats: 2 });
    const result = await bench(file, {
      signal: controller.signal,
      onEvent: (event: BenchEvent) => {
        if (event.type === "workload_ended") controller.abort();
      },
    });
    const report = reportOf([await readBench(result.dir)]);
    expect(report.benches[0]!.state).toBe("cancelled");
    expect(report.engines[0]!.workloads.neverRun).toBeGreaterThan(0);
    const text = formatBenchReport(report);
    expect(text).toMatch(/bench bench_\w+: cancelled/);
    expect(text).toMatch(/never run/);
  });
});

describe("the report of several benches", () => {
  it("combines the engines of benches made apart, in the order of the engine list, and compares them per prompt", async () => {
    const sglang = await weak();
    const vllm = await perfect();

    const report = reportOf([sglang.view, vllm.view]);

    expect(report.engines.map((engine) => engine.engine)).toEqual(["vllm", "sglang"]);
    expect(report.benches.map((bench) => bench.benchId)).toEqual([sglang.benchId, vllm.benchId]);
    expect(report.comparisonSeed).toBe(DEFAULT_REPORT_SEED);
    const quality = report.comparisons.find((c) => c.workload === "quality")!;
    expect([quality.a, quality.b]).toEqual(["vllm", "sglang"]);
    // Per prompt: add 1 vs 1, sub 1 vs 0, mul 1 vs 0 → mean difference 2/3 over 3 prompts.
    expect(quality.comparison.tasks.map((task) => [task.taskId, task.difference])).toEqual([["add", 0], ["mul", 1], ["sub", 1]]);
    expect(quality.comparison.meanDifference).toBeCloseTo(2 / 3);
    expect(COMPARISON_FINDINGS).toContain(quality.comparison.finding);
    expect(quality.comparison.interval).not.toBeNull();
    const tools = report.comparisons.find((c) => c.workload === "tools")!;
    expect(tools.comparison.tasks.map((task) => [task.taskId, task.difference])).toEqual([["files", 1], ["weather", 0]]);
    const text = formatBenchReport(report);
    expect(text).toContain("quality: vLLM (fake-model, awq) vs SGLang (fake-model, awq): mean difference +0.667");
    expect(quality.served).toEqual({ a: { model: "fake-model", quantization: "awq" }, b: { model: "fake-model", quantization: "awq" } });
    expect(text).toContain("seed 0");
  });

  it("makes the same comparison every time it is asked, and another seed is recorded", async () => {
    const [a, b] = [await perfect(), await weak()];
    const first = reportOf([a.view, b.view]);
    expect(reportOf([a.view, b.view])).toEqual(first);
    expect(reportOf([a.view, b.view], { seed: 99 }).comparisonSeed).toBe(99);
  });

  it("leaves a prompt out of a comparison that has no valid answer on a side", async () => {
    const quality = reportOf([(await perfect()).view, (await failing()).view]).comparisons.find((c) => c.workload === "quality")!;
    expect(quality.comparison.excluded).toEqual([{ taskId: "add", reason: "none_in_b" }]);
    expect(quality.comparison.tasks.map((task) => task.taskId)).toEqual(["mul", "sub"]);
  });

  describe("refuses benches that would not be comparable, listing every difference", () => {
    const problemsOf = (views: Parameters<typeof reportOf>[0]) => {
      try {
        reportOf(views);
      } catch (error) {
        expect(error).toBeInstanceOf(BenchesNotComparableError);
        return (error as BenchesNotComparableError).problems.join("\n");
      }
      throw new Error("the benches were combined");
    };
    const withChange = (view: BenchView, change: Partial<BenchView>): BenchView => ({ ...view, ...change });

    it("the same engine in two benches", async () => {
      const [a, b] = [await perfect(), await full()];
      expect(problemsOf([a.view, b.view])).toContain(`engine vllm is in both ${a.benchId} and ${b.benchId}`);
    });

    it("another prompt set (by hash), another test, or other tool-call cases", async () => {
      const [a, b] = [await perfect(), await weak()];
      const prompts = b.view.prompts.map((prompt, i) => (i === 0 ? { ...prompt, testSha256: "f".repeat(64) } : prompt));
      expect(problemsOf([a.view, withChange(b.view, { prompts })])).toContain("in its prompts");
      const toolCases = b.view.toolCases.map((c, i) => (i === 0 ? { ...c, sha256: "e".repeat(64) } : c));
      expect(problemsOf([a.view, withChange(b.view, { toolCases })])).toContain("in its tool-call cases");
    });

    it("tool-call cases and prompts written again with the same bytes are the same", async () => {
      const [a, b] = [await perfect(), await weak()];
      expect(a.view.prompts).toEqual(b.view.prompts);
      expect(a.view.toolCases).toEqual(b.view.toolCases);
      expect(() => reportOf([a.view, b.view])).not.toThrow();
    });

    it("other settings", async () => {
      const [a, b] = [await perfect(), await weak()];
      expect(problemsOf([a.view, withChange(b.view, { settings: { ...b.view.settings, repeats: 2 } })])).toContain("in its settings");
      expect(problemsOf([a.view, withChange(b.view, { request: { ...b.view.request, temperature: 1 } as never })])).toContain("in what every request sends");
    });

    it("another machine", async () => {
      const [a, b] = [await perfect(), await weak()];
      const fingerprint = { ...b.view.fingerprint, gpu: null, gpuReason: "nvidia-smi was not found" };
      expect(problemsOf([a.view, withChange(b.view, { fingerprint })])).toContain("in its hardware fingerprint");
      expect(problemsOf([a.view, withChange(b.view, { fingerprint: { ...b.view.fingerprint, ramBytes: 1 } })])).toContain("in its hardware fingerprint");
    });

    it("every difference at once", async () => {
      const [a, b] = [await perfect(), await full()];
      const problems = problemsOf([a.view, withChange(b.view, { fingerprint: { ...b.view.fingerprint, os: "Linux" }, prompts: [], settings: { ...b.view.settings, warmup: 9 } })]);
      for (const part of ["is in both", "hardware fingerprint", "in its prompts", "in its settings"]) expect(problems).toContain(part);
    });

    it("how often resources were sampled, and why a GPU was not read, are not differences", async () => {
      const [a, b] = [await perfect(), await weak()];
      const changed = withChange(b.view, { settings: { ...b.view.settings, sampleIntervalMs: 999 }, fingerprint: { ...b.view.fingerprint, gpuReason: "another reason" } });
      expect(() => reportOf([a.view, changed])).not.toThrow();
    });
  });
});
