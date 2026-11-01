// The bench report: computed from replayed bench views alone (never from a live run), so it can be recomputed from the ledgers of
// one bench or combined from the benches of several engines. Percentiles are nearest-rank. Every rate has its count beside it;
// an engine that was unavailable is listed with its error; a figure no source gave is null, never filled in.

import { comparePaired, type PairedComparison, type TaskTally } from "../evaluation/statistics.ts";
import type { BenchSettings, WorkloadId } from "./bench.ts";
import { ENGINES, ENGINE_NAMES, type EngineId } from "./engines.ts";
import type { RequestRecord, WorkloadEnded } from "./events.ts";
import type { BenchView, WorkloadView } from "./replay.ts";
import type { HardwareFingerprint, Stat } from "./resources.ts";
import { summarizeWorkload } from "./workloads.ts";

/** The seed of the comparisons' bootstrap when none is given: fixed, so a report is the same every time it is made. */
export const DEFAULT_REPORT_SEED = 0;

export const PERCENTILES = [50, 95, 99] as const;

export interface Percentiles {
  /** How many values these are drawn from. */
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** The nearest-rank percentile: the value at rank ceil(p/100 × n) of the sorted values; null for none. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(Math.ceil((p / 100) * sorted.length), 1) - 1]!;
}

export function percentilesOf(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
}

/** The conventional median (the mean of the middle two of an even count); null for none. */
const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** One figure per repeat of a workload, summarized: the median, the extremes and how many repeats had it. */
export interface Spread {
  n: number;
  median: number;
  min: number;
  max: number;
}

const spreadOf = (values: readonly number[]): Spread | null => (values.length === 0 ? null : { n: values.length, median: medianOf(values)!, min: Math.min(...values), max: Math.max(...values) });

/** What the requests of a workload (or of the repeats of one) took, over those that ran to `[DONE]`. */
export interface TimingReport {
  requests: number;
  succeeded: number;
  failed: number;
  /** Over the succeeded requests that carried a first chunk. */
  ttftMs: Percentiles;
  latencyMs: Percentiles;
  /** Pooled over every gap between chunks that carried content (a chunk is not a token). */
  interChunkMs: Percentiles;
}

function timingOf(requests: readonly RequestRecord[]): TimingReport {
  const ok = requests.filter((request) => request.error === null);
  return {
    requests: requests.length,
    succeeded: ok.length,
    failed: requests.length - ok.length,
    ttftMs: percentilesOf(ok.flatMap((request) => (request.ttftMs === null ? [] : [request.ttftMs]))),
    latencyMs: percentilesOf(ok.map((request) => request.latencyMs)),
    interChunkMs: percentilesOf(ok.flatMap((request) => request.interChunkMs)),
  };
}

export interface ThroughputLevel {
  concurrency: number;
  /** Workloads of this level that ran to the end (a cancelled one is left out). */
  workloads: number;
  timing: TimingReport;
  /** Requests that succeeded per second, one value per workload. */
  requestsPerSecond: Spread | null;
  /** Output tokens per second from the engine's reported usage; one value per workload whose every request reported it. Null when none did. */
  outputTokensPerSecond: Spread | null;
}

/** Outcomes counted, with the score's rate: a pass is `pass` (quality) or `valid_call` (tools). */
export interface ScoreReport {
  /** Workloads of this kind that ran to the end. */
  workloads: number;
  requests: number;
  /** Requests that ended in an engine error: no answer, so not in `scored`. */
  errors: number;
  /** Answers that could not be scored (the harness failed); not in `scored` either. */
  unscored: number;
  scored: number;
  outcomes: Record<string, number>;
  passes: number;
  /** `passes` over `scored`; null when nothing was scored. */
  passRate: number | null;
  byPrompt: { id: string; passes: number; scored: number; errors: number }[];
}

export interface ResourceReport {
  /** Ended workloads whose figures these merge. */
  workloads: number;
  gpu: { samples: number; utilizationPercent: Stat | null; memoryUsedMiB: Stat | null; powerW: Stat | null; workloadsWithout: number } | null;
  gpuReason: string | null;
  /** The whole machine's, not the engine's. */
  host: { memoryUsedBytes: Stat | null; cpuPercent: Stat | null } | null;
  docker: { container: string; memoryUsedBytes: Stat | null; cpuPercent: Stat | null; workloadsWithout: number } | null;
  dockerReason: string | null;
}

export interface EngineReport {
  engine: EngineId;
  name: string;
  model: string;
  quantization: string;
  container: string | null;
  benchId: string;
  available: boolean;
  version: string | null;
  error: string | null;
  /** GPU memory in use before the first request; null when not read. */
  idleGpuMemoryMiB: number | null;
  warmup: { requests: number; failed: number; firstError: string | null } | null;
  workloads: { scheduled: number; ended: number; cancelled: number; skipped: number; neverRun: number };
  latency: TimingReport | null;
  throughput: ThroughputLevel[];
  quality: ScoreReport | null;
  tools: ScoreReport | null;
  resources: ResourceReport | null;
}

export interface BenchReference {
  benchId: string;
  name: string;
  state: BenchView["state"];
  reason: string | null;
  seed: number;
  onlyEngine: EngineId | null;
  createdAt: string;
  endedAt: string | null;
}

export interface PairComparison {
  workload: Extract<WorkloadId, "quality" | "tools">;
  /** What is compared: the share of answers that pass (`pass`, or `valid_call`), per prompt. */
  measure: string;
  a: EngineId;
  b: EngineId;
  /**
   * What each side served: the model's id and quantization differ by engine (GGUF on Ollama, AWQ on the others), so a difference
   * between engines is a difference between these artifacts too, and is labelled so.
   */
  served: { a: { model: string; quantization: string }; b: { model: string; quantization: string } };
  comparison: PairedComparison;
}

export interface BenchReport {
  benches: BenchReference[];
  fingerprint: HardwareFingerprint;
  settings: Omit<BenchSettings, "sampleIntervalMs">;
  prompts: BenchView["prompts"];
  toolCases: BenchView["toolCases"];
  engines: EngineReport[];
  comparisons: PairComparison[];
  /** The seed of the comparisons' paired bootstrap. */
  comparisonSeed: number;
  method: { percentiles: "nearest-rank"; comparisons: string };
}

/** Benches that cannot be put in one report: they would not be comparable. Nothing was combined. */
export class BenchesNotComparableError extends Error {
  override name = "BenchesNotComparableError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`these benches cannot be combined:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The parts of a fingerprint that make two machines the same: `gpuReason` is why a read failed, not a property of the machine. */
const machineOf = ({ gpu, cpu, ramBytes, os }: HardwareFingerprint) => ({ gpu, cpu, ramBytes, os });
const settingsOf = ({ sampleIntervalMs: _interval, ...settings }: BenchSettings) => settings;

/**
 * Why benches cannot be combined: the same engine in two of them, or a difference in hardware fingerprint, prompt set (each file
 * and each test by its hash), tool-call cases, settings (how often resources were sampled aside) or request settings.
 */
export function comparabilityProblems(views: readonly BenchView[]): string[] {
  const problems: string[] = [];
  const [first, ...rest] = views;
  if (!first) return ["no bench to report"];
  const seen = new Map<EngineId, string>();
  for (const view of views) {
    for (const engine of view.engines) {
      const earlier = seen.get(engine.engine);
      if (earlier !== undefined) problems.push(`engine ${engine.engine} is in both ${earlier} and ${view.benchId}: a report holds each engine once`);
      else seen.set(engine.engine, view.benchId);
    }
  }
  for (const view of rest) {
    const against = `${view.benchId} differs from ${first.benchId}`;
    if (!sameJson(machineOf(view.fingerprint), machineOf(first.fingerprint))) problems.push(`${against} in its hardware fingerprint (${describeMachine(view.fingerprint)} against ${describeMachine(first.fingerprint)})`);
    if (!sameJson(view.prompts, first.prompts)) problems.push(`${against} in its prompts (their files or tests are not the same, by SHA-256)`);
    if (!sameJson(view.toolCases, first.toolCases)) problems.push(`${against} in its tool-call cases (they are not the same, by SHA-256)`);
    if (!sameJson(settingsOf(view.settings), settingsOf(first.settings))) problems.push(`${against} in its settings (workloads, concurrency, repeats, max tokens, warmup or timeout)`);
    if (!sameJson(view.request, first.request)) problems.push(`${against} in what every request sends (${JSON.stringify(view.request)} against ${JSON.stringify(first.request)})`);
  }
  return problems;
}

function describeMachine(fingerprint: HardwareFingerprint): string {
  return `${fingerprint.gpu?.name ?? "GPU not read"}, ${fingerprint.cpu.model}, ${fingerprint.os}`;
}

function mergeStats(stats: readonly (Stat | null)[]): Stat | null {
  const present = stats.filter((stat): stat is Stat => stat !== null);
  const samples = present.reduce((sum, stat) => sum + stat.samples, 0);
  if (samples === 0) return null;
  const mean = present.reduce((sum, stat) => sum + stat.mean * stat.samples, 0) / samples;
  return { peak: Math.max(...present.map((stat) => stat.peak)), mean: Math.round(mean * 1000) / 1000, samples };
}

function resourcesOf(ended: readonly WorkloadEnded[]): ResourceReport | null {
  if (ended.length === 0) return null;
  const gpus = ended.flatMap((workload) => (workload.resources.gpu ? [workload.resources.gpu] : []));
  const dockers = ended.flatMap((workload) => (workload.resources.docker ? [workload.resources.docker] : []));
  const hosts = ended.map((workload) => workload.resources.host);
  return {
    workloads: ended.length,
    gpu:
      gpus.length === 0
        ? null
        : {
            samples: gpus.reduce((sum, gpu) => sum + gpu.samples, 0),
            utilizationPercent: mergeStats(gpus.map((gpu) => gpu.utilizationPercent)),
            memoryUsedMiB: mergeStats(gpus.map((gpu) => gpu.memoryUsedMiB)),
            powerW: mergeStats(gpus.map((gpu) => gpu.powerW)),
            workloadsWithout: ended.length - gpus.length,
          },
    gpuReason: gpus.length === ended.length ? null : (ended.find((workload) => !workload.resources.gpu)?.resources.gpuReason ?? null),
    host: { memoryUsedBytes: mergeStats(hosts.map((host) => host.memoryUsedBytes)), cpuPercent: mergeStats(hosts.map((host) => host.cpuPercent)) },
    docker:
      dockers.length === 0
        ? null
        : { container: dockers[0]!.container, memoryUsedBytes: mergeStats(dockers.map((docker) => docker.memoryUsedBytes)), cpuPercent: mergeStats(dockers.map((docker) => docker.cpuPercent)), workloadsWithout: ended.length - dockers.length },
    dockerReason: dockers.length === ended.length ? null : (ended.find((workload) => !workload.resources.docker)?.resources.dockerReason ?? null),
  };
}

const PASSING: Record<"quality" | "tools", string> = { quality: "pass", tools: "valid_call" };

function scoresOf(kind: "quality" | "tools", ended: readonly WorkloadEnded[]): ScoreReport | null {
  if (ended.length === 0) return null;
  const requests = ended.flatMap((workload) => workload.requests);
  const outcomes: Record<string, number> = {};
  const byPrompt = new Map<string, { id: string; passes: number; scored: number; errors: number }>();
  let errors = 0;
  let unscored = 0;
  let scored = 0;
  let passes = 0;
  for (const request of requests) {
    const prompt = byPrompt.get(request.promptId) ?? { id: request.promptId, passes: 0, scored: 0, errors: 0 };
    byPrompt.set(request.promptId, prompt);
    const score = request.score ?? null;
    if (request.error !== null) {
      errors += 1;
      prompt.errors += 1;
    } else if (score === null) {
      unscored += 1;
    } else {
      scored += 1;
      prompt.scored += 1;
      outcomes[score.outcome] = (outcomes[score.outcome] ?? 0) + 1;
      if (score.outcome === PASSING[kind]) {
        passes += 1;
        prompt.passes += 1;
      }
    }
  }
  return { workloads: ended.length, requests: requests.length, errors, unscored, scored, outcomes, passes, passRate: scored > 0 ? passes / scored : null, byPrompt: [...byPrompt.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

function engineReportOf(view: BenchView, engine: BenchView["engines"][number]): EngineReport {
  const mine = view.workloads.filter((workload) => workload.engine === engine.engine);
  const endedViews = mine.filter((workload): workload is WorkloadView & { ended: WorkloadEnded } => workload.ended !== null);
  const complete = endedViews.filter((workload) => !workload.ended.cancelled);
  const of = (kind: WorkloadId) => complete.filter((workload) => workload.workload === kind).map((workload) => workload.ended);
  const scheduled = mine.length + view.pending.filter((unit) => unit.engine === engine.engine).length;
  const check = engine.check;
  const latency = of("latency");
  const levels = [...new Set(of("throughput").map((ended) => ended.concurrency))].sort((a, b) => a - b);
  return {
    engine: engine.engine,
    name: ENGINE_NAMES[engine.engine],
    model: engine.model,
    quantization: engine.quantization,
    container: engine.container ?? null,
    benchId: view.benchId,
    available: check?.available ?? false,
    version: check?.version ?? null,
    error: check === null ? "the bench ended before this engine was checked" : check.error,
    idleGpuMemoryMiB: check?.idleGpu?.memoryUsedMiB ?? null,
    warmup: check?.warmup ?? null,
    workloads: {
      scheduled,
      ended: complete.length,
      cancelled: endedViews.length - complete.length,
      skipped: mine.filter((workload) => workload.status === "skipped").length,
      // Started and never ended (an error stopped the bench), or never started.
      neverRun: scheduled - mine.filter((workload) => workload.status === "skipped").length - endedViews.length,
    },
    latency: latency.length === 0 ? null : timingOf(latency.flatMap((ended) => ended.requests)),
    throughput: levels.map((concurrency) => {
      const atLevel = of("throughput").filter((ended) => ended.concurrency === concurrency);
      const summaries = atLevel.map((ended) => summarizeWorkload(ended));
      return {
        concurrency,
        workloads: atLevel.length,
        timing: timingOf(atLevel.flatMap((ended) => ended.requests)),
        requestsPerSecond: spreadOf(summaries.flatMap((summary) => (summary.requestsPerSecond === null ? [] : [summary.requestsPerSecond]))),
        outputTokensPerSecond: spreadOf(summaries.flatMap((summary) => (summary.outputTokensPerSecond === null ? [] : [summary.outputTokensPerSecond]))),
      };
    }),
    quality: scoresOf("quality", of("quality")),
    tools: scoresOf("tools", of("tools")),
    resources: resourcesOf(complete.map((workload) => workload.ended)),
  };
}

function comparisonsOf(engines: readonly EngineReport[], seed: number): PairComparison[] {
  const comparisons: PairComparison[] = [];
  for (const workload of ["quality", "tools"] as const) {
    const withScores = engines.flatMap((engine) => (engine[workload] && engine[workload]!.scored > 0 ? [{ engine, report: engine[workload]! }] : []));
    const tallies = (report: ScoreReport): TaskTally[] => report.byPrompt.map((prompt) => ({ taskId: prompt.id, passes: prompt.passes, valid: prompt.scored, incidents: prompt.errors }));
    for (const [i, a] of withScores.entries()) {
      for (const b of withScores.slice(i + 1)) {
        comparisons.push({ workload, measure: `share of answers that ${PASSING[workload] === "pass" ? "pass their tests" : "are a valid call"}, per prompt`, a: a.engine.engine, b: b.engine.engine, served: { a: { model: a.engine.model, quantization: a.engine.quantization }, b: { model: b.engine.model, quantization: b.engine.quantization } }, comparison: comparePaired(tallies(a.report), tallies(b.report), seed) });
      }
    }
  }
  return comparisons;
}

/**
 * The report of one bench or of several: engines in `ENGINES` order, each with the figures of the bench that measured it.
 * Throws `BenchesNotComparableError` for benches that cannot share a report. Pure: nothing is read or written.
 */
export function reportOf(views: readonly BenchView[], options: { seed?: number } = {}): BenchReport {
  const problems = comparabilityProblems(views);
  if (problems.length > 0) throw new BenchesNotComparableError(problems);
  const seed = options.seed ?? DEFAULT_REPORT_SEED;
  const first = views[0]!;
  const engines = views
    .flatMap((view) => view.engines.map((engine) => engineReportOf(view, engine)))
    .sort((a, b) => ENGINES.indexOf(a.engine) - ENGINES.indexOf(b.engine));
  return {
    benches: views.map((view) => ({ benchId: view.benchId, name: view.name, state: view.state, reason: view.reason, seed: view.seed, onlyEngine: view.onlyEngine, createdAt: view.createdAt, endedAt: view.endedAt })),
    fingerprint: first.fingerprint,
    settings: settingsOf(first.settings),
    prompts: first.prompts,
    toolCases: first.toolCases,
    engines,
    comparisons: comparisonsOf(engines, seed),
    comparisonSeed: seed,
    method: {
      percentiles: "nearest-rank",
      comparisons: "mean over prompts of the difference in pass rate, with a 95% percentile interval from a paired bootstrap over prompts (10,000 resamples)",
    },
  };
}

// ---- text ----

const n1 = (value: number | null) => (value === null ? "n/a" : Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1));
const pct = (rate: number | null) => (rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`);
const trio = (p: Percentiles) => (p.n === 0 ? "n/a (no values)" : `${n1(p.p50)} / ${n1(p.p95)} / ${n1(p.p99)} (n=${p.n})`);
const statText = (stat: Stat | null, unit: string) => (stat === null ? "n/a" : `peak ${n1(stat.peak)}${unit}, mean ${n1(stat.mean)}${unit} (${stat.samples} samples)`);
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const bytesStat = (stat: Stat | null) => (stat === null ? "n/a" : `peak ${gib(stat.peak)}, mean ${gib(stat.mean)} (${stat.samples} samples)`);

function scoreLines(label: string, report: ScoreReport | null, passing: string): string[] {
  if (report === null) return [];
  const others = Object.entries(report.outcomes)
    .filter(([outcome]) => outcome !== passing)
    .map(([outcome, count]) => `${outcome} ${count}`);
  const lines = [
    `  ${label}: ${passing} ${report.passes}/${report.scored} (${pct(report.passRate)})${others.length > 0 ? `; ${others.join(", ")}` : ""}; ${report.errors} engine error${report.errors === 1 ? "" : "s"}${report.unscored > 0 ? `, ${report.unscored} not scored` : ""} of ${report.requests} requests over ${report.workloads} workload${report.workloads === 1 ? "" : "s"}`,
  ];
  for (const prompt of report.byPrompt) lines.push(`    ${prompt.id}: ${prompt.passes}/${prompt.scored}${prompt.errors > 0 ? `, ${prompt.errors} error${prompt.errors === 1 ? "" : "s"}` : ""}`);
  return lines;
}

/** The report as text: percentiles are p50 / p95 / p99, nearest-rank, with the number of values beside each. */
export function formatBenchReport(report: BenchReport): string {
  const { fingerprint, settings } = report;
  const lines: string[] = [];
  lines.push(`bench report: ${[...new Set(report.benches.map((bench) => bench.name))].join(", ")}`);
  lines.push(`hardware: ${fingerprint.gpu ? `${fingerprint.gpu.name}, ${fingerprint.gpu.memoryTotalMiB ?? "?"} MiB, driver ${fingerprint.gpu.driver}` : `GPU not read (${fingerprint.gpuReason})`}; ${fingerprint.cpu.model} (${fingerprint.cpu.cores} cores); ${gib(fingerprint.ramBytes)} RAM; ${fingerprint.os}`);
  lines.push(`prompts: ${report.prompts.map((prompt) => prompt.id).join(", ")}${report.toolCases.length > 0 ? `; tool-call cases: ${report.toolCases.map((c) => c.id).join(", ")}` : ""}`);
  lines.push(`settings: workloads ${settings.workloads.join(", ")}; concurrency ${settings.concurrency.join(", ")}; ${settings.repeats} repeat${settings.repeats === 1 ? "" : "s"}; max_tokens ${settings.maxTokens}; warmup ${settings.warmup}; timeout ${settings.timeoutMs} ms`);
  lines.push("percentiles are p50 / p95 / p99, nearest-rank; with fewer than 100 values p99 is the slowest of them");
  for (const bench of report.benches) {
    lines.push(`bench ${bench.benchId}: ${bench.state}${bench.reason ? ` (${bench.reason})` : ""}, seed ${bench.seed}${bench.onlyEngine ? `, engine ${bench.onlyEngine} only` : ""}`);
  }
  for (const engine of report.engines) {
    lines.push("");
    lines.push(`${engine.name} (${engine.model}, ${engine.quantization})${engine.version ? ` ${engine.version}` : ""}${engine.container ? ` [container ${engine.container}]` : ""}`);
    if (!engine.available) {
      lines.push(`  UNAVAILABLE: ${engine.error ?? "no reason recorded"}; none of its ${engine.workloads.scheduled} workloads ran (${engine.workloads.skipped} skipped)`);
      continue;
    }
    const w = engine.workloads;
    lines.push(`  workloads: ${w.ended} of ${w.scheduled} ran to the end${w.cancelled > 0 ? `, ${w.cancelled} cancelled` : ""}${w.skipped > 0 ? `, ${w.skipped} skipped` : ""}${w.neverRun > 0 ? `, ${w.neverRun} never run` : ""}`);
    if (engine.warmup && engine.warmup.failed > 0) lines.push(`  warmup: ${engine.warmup.failed} of ${engine.warmup.requests} requests failed (${engine.warmup.firstError})`);
    if (engine.latency) {
      lines.push(`  latency (one request at a time; ${engine.latency.succeeded} ok of ${engine.latency.requests}):`);
      lines.push(`    time to first token ms: ${trio(engine.latency.ttftMs)}`);
      lines.push(`    request latency ms:     ${trio(engine.latency.latencyMs)}`);
      lines.push(`    inter-chunk gap ms:     ${trio(engine.latency.interChunkMs)}`);
    }
    if (engine.throughput.length > 0) {
      lines.push("  throughput by concurrency:");
      for (const level of engine.throughput) {
        const spread = (value: Spread | null) => (value === null ? "n/a" : `${n1(value.median)} (${n1(value.min)}-${n1(value.max)}, ${value.n} repeat${value.n === 1 ? "" : "s"})`);
        lines.push(`    c=${level.concurrency}: ${level.timing.succeeded} ok of ${level.timing.requests} requests; requests/s ${spread(level.requestsPerSecond)}; output tokens/s ${spread(level.outputTokensPerSecond)}`);
        lines.push(`        time to first token ms ${trio(level.timing.ttftMs)}; latency ms ${trio(level.timing.latencyMs)}`);
      }
    }
    lines.push(...scoreLines("quality", engine.quality, "pass"));
    lines.push(...scoreLines("tool calls", engine.tools, "valid_call"));
    const resources = engine.resources;
    if (resources) {
      lines.push(`  resources over ${resources.workloads} workload${resources.workloads === 1 ? "" : "s"}${engine.idleGpuMemoryMiB !== null ? `; GPU memory before the first request ${engine.idleGpuMemoryMiB} MiB` : ""}:`);
      lines.push(resources.gpu ? `    GPU (nvidia-smi): utilization ${statText(resources.gpu.utilizationPercent, "%")}; memory ${statText(resources.gpu.memoryUsedMiB, " MiB")}; power ${statText(resources.gpu.powerW, " W")}${resources.gpu.workloadsWithout > 0 ? `; ${resources.gpu.workloadsWithout} workload(s) without a reading` : ""}` : `    GPU: n/a (${resources.gpuReason})`);
      if (resources.host) lines.push(`    whole machine (os): memory ${bytesStat(resources.host.memoryUsedBytes)}; CPU ${statText(resources.host.cpuPercent, "%")}`);
      lines.push(resources.docker ? `    container ${resources.docker.container} (docker stats): memory ${bytesStat(resources.docker.memoryUsedBytes)}; CPU ${statText(resources.docker.cpuPercent, "%")}` : `    container: n/a (${resources.dockerReason})`);
    }
  }
  if (report.comparisons.length > 0) {
    lines.push("");
    lines.push(`comparisons (${report.method.comparisons}; seed ${report.comparisonSeed}):`);
    for (const { workload, a, b, served, comparison } of report.comparisons) {
      const side = (engine: EngineId, of: { model: string; quantization: string }) => `${ENGINE_NAMES[engine]} (${of.model}, ${of.quantization})`;
      const head = `  ${workload}: ${side(a, served.a)} vs ${side(b, served.b)}`;
      const mean = comparison.meanDifference === null ? "no prompt scored on both" : `mean difference ${comparison.meanDifference >= 0 ? "+" : ""}${comparison.meanDifference.toFixed(3)}${comparison.interval ? ` [${comparison.interval[0].toFixed(3)}, ${comparison.interval[1].toFixed(3)}]` : ""}`;
      const finding = { higher: `${ENGINE_NAMES[a]} higher`, lower: `${ENGINE_NAMES[a]} lower`, no_detectable_difference: "no detectable difference", too_few_tasks: "too few prompts for an interval" }[comparison.finding];
      lines.push(`${head}: ${mean} over ${comparison.tasks.length} prompt${comparison.tasks.length === 1 ? "" : "s"}${comparison.excluded.length > 0 ? ` (${comparison.excluded.length} left out: no valid answer on a side)` : ""}: ${finding}`);
    }
  }
  return lines.join("\n");
}
