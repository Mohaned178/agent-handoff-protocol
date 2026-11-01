import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seededRandom, seededShuffle, isSeed } from "../evaluation/statistics.ts";
import { LedgerWriter, readCheckedLedger } from "../ledger/index.ts";
import { PROTOCOL_VERSION } from "../protocol/index.ts";
import { benchesRoot, newId, systemClock, type Clock } from "../runtime/index.ts";
import { BenchInvalidError, DEFAULT_SAMPLE_INTERVAL_MS, loadPrompts, settingsOf, validateBench, type BenchEngine, type BenchFile, type BenchPrompt, type BenchSettings } from "./bench.ts";
import { checkEngine } from "./check.ts";
import { REQUEST_SETTINGS } from "./client.ts";
import { ENGINES, isEngineId, type EngineId } from "./engines.ts";
import type { BenchEvent, BenchEventBody, ScheduledWorkload } from "./events.ts";
import { applyBenchEvent, replayBench, type BenchView } from "./replay.ts";
import { fingerprintOf, idleGpuMemory, startSampling } from "./resources.ts";
import { runWorkload, warmUp } from "./workloads.ts";

export interface RunBenchOptions {
  /** The directory the bench's own directory (`<out>/<bench id>`) is made in. Default `<AHP_HOME>/benches`. */
  out?: string;
  /** The prompts directory, when relative, is resolved against this. Default: the working directory. */
  baseDir?: string;
  /** Runs this engine of the file alone (`--engine`): the others are neither checked nor recorded. */
  engine?: EngineId;
  /** The seed of the order of engines × repeats and of each workload's prompts: 0 to 2^32 − 1, recorded. Default: drawn at random. */
  seed?: number;
  /** The environment `nvidia-smi` and `docker` are found in (PATH). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Stops the bench: requests in flight end `cancelled`, the workload in hand ends cancelled, and no other starts. */
  signal?: AbortSignal;
  /** Called after each event is durably recorded, with the state derived so far. */
  onEvent?: (event: BenchEvent, state: Readonly<BenchView>) => void;
  /** Stamps the ledger's events. */
  clock?: Clock;
  /** Times requests, in milliseconds (default `performance.now`). */
  now?: () => number;
  /** How often resources are sampled while a workload runs (default 500 ms). */
  sampleIntervalMs?: number;
}

export interface BenchResult {
  benchId: string;
  /** Where the ledger is. */
  dir: string;
  state: BenchView;
}

/**
 * The order a bench runs in: the engines × repeats shuffled from the seed, each running its workloads in the order the file
 * lists them (the throughput sweep in its levels' order), each workload's prompts shuffled from the same generator.
 */
export function scheduleOf(engines: readonly EngineId[], settings: BenchSettings, promptIds: readonly string[], seed: number): ScheduledWorkload[] {
  const random = seededRandom(seed);
  const pairs = seededShuffle(
    engines.flatMap((engine) => Array.from({ length: settings.repeats }, (_, i) => ({ engine, repeat: i + 1 }))),
    random,
  );
  return pairs.flatMap(({ engine, repeat }) =>
    settings.workloads.flatMap((workload) => {
      const levels = workload === "latency" ? [1] : settings.concurrency;
      return levels.map((concurrency) => ({ engine, repeat, workload, concurrency, prompts: seededShuffle(promptIds, random) }));
    }),
  );
}

/**
 * Runs a bench: validates the file and reads its prompts, records the hardware, the settings and the seeded schedule in a new
 * bench ledger, checks every engine (with an idle GPU sample, then the warmup), then runs the workloads in the scheduled
 * order, sampling resources through each. The next action is always read from the state replayed so far. An engine that does
 * not serve its model is recorded unavailable with its error, and its workloads skipped; the bench goes on with the others.
 * Throws before writing anything if the file, its prompts, `engine` or the seed are invalid.
 */
export async function runBench(file: BenchFile, options: RunBenchOptions = {}): Promise<BenchResult> {
  const problems = validateBench(file);
  if (problems.length > 0) throw new BenchInvalidError(problems);
  if (options.engine !== undefined) {
    if (!isEngineId(options.engine)) problems.push(`--engine ${String(options.engine)}: not an engine (engines: ${ENGINES.join(", ")})`);
    else if (!file.engines.some((entry) => entry.engine === options.engine)) problems.push(`--engine ${options.engine}: the bench file does not list it (it lists: ${file.engines.map((entry) => entry.engine).join(", ")})`);
  }
  if (options.seed !== undefined && !isSeed(options.seed)) problems.push(`the seed must be an integer from 0 to ${0xffffffff}`);
  const promptsDir = resolve(options.baseDir ?? process.cwd(), file.prompts);
  const loaded = await loadPrompts(promptsDir);
  problems.push(...loaded.problems);
  if (problems.length > 0) throw new BenchInvalidError(problems);

  const engines = options.engine ? file.engines.filter((entry) => entry.engine === options.engine) : file.engines;
  const settings = settingsOf(file, options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
  const seed = options.seed ?? randomInt(0, 0x100000000);
  const prompts = new Map(loaded.prompts.map((prompt) => [prompt.id, prompt]));
  const fingerprint = await fingerprintOf(options.env);
  const clock = options.clock ?? systemClock;

  const benchId = newId("bench");
  const dir = join(resolve(options.out ?? benchesRoot()), benchId);
  await mkdir(dir, { recursive: true });
  const ledger = await LedgerWriter.create<BenchEventBody>(join(dir, "ledger.jsonl"), () => clock.now());
  let view: BenchView | undefined;
  const record = async (body: BenchEventBody) => {
    const event = await ledger.append(body);
    view = applyBenchEvent(view, event);
    options.onEvent?.(event, view);
    return event;
  };
  try {
    await record({
      type: "bench_created",
      benchId,
      protocolVersion: PROTOCOL_VERSION,
      name: file.name,
      seed,
      onlyEngine: options.engine ?? null,
      engines: engines.map(({ engine, baseURL, model, quantization, container }) => ({ engine, baseURL, model, quantization, ...(container ? { container } : {}) })),
      settings,
      request: REQUEST_SETTINGS,
      prompts: loaded.prompts.map(({ id, sha256 }) => ({ id, sha256 })),
      fingerprint,
      schedule: scheduleOf(
        engines.map((entry) => entry.engine),
        settings,
        loaded.prompts.map((prompt) => prompt.id),
        seed,
      ),
    });
    await record(await drive(() => view!, record, { settings, prompts, loadedPrompts: loaded.prompts, options }));
  } catch (error) {
    // The ledger says it stopped, rather than leave a bench that reads as still running; the error is still the caller's.
    await record({ type: "bench_ended", state: "stopped", reason: `error: ${(error as Error).message}`.slice(0, 500) }).catch(() => undefined);
    throw error;
  } finally {
    await ledger.close();
  }
  return { benchId, dir, state: view! };
}

interface DriveContext {
  settings: BenchSettings;
  prompts: ReadonlyMap<string, BenchPrompt>;
  loadedPrompts: readonly BenchPrompt[];
  options: RunBenchOptions;
}

/** Takes the bench's next action from its state until there is none, and returns how it ended (not yet recorded). */
async function drive(current: () => BenchView, record: (body: BenchEventBody) => Promise<unknown>, ctx: DriveContext): Promise<Extract<BenchEventBody, { type: "bench_ended" }>> {
  const { options, settings } = ctx;
  const cancelled = (reason: string) => ({ type: "bench_ended" as const, state: "cancelled" as const, reason });
  for (;;) {
    const view = current();
    if (options.signal?.aborted) return cancelled("cancelled before the next step");
    const unchecked = view.engines.find((engine) => engine.check === null);
    if (unchecked) {
      const checked = await checkOne(unchecked, ctx);
      // A check a cancel cut short says nothing about the engine, so it is not recorded.
      if (options.signal?.aborted) return cancelled("cancelled while checking the engines");
      await record(checked);
      continue;
    }
    const next = view.pending[0];
    if (!next) return { type: "bench_ended", state: "completed", reason: null };
    const engine = view.engines.find((candidate) => candidate.engine === next.engine)!;
    const slot = { engine: next.engine, repeat: next.repeat, workload: next.workload, concurrency: next.concurrency };
    if (!engine.check!.available) {
      await record({ type: "workload_skipped", ...slot, reason: "engine_unavailable", error: engine.check!.error });
      continue;
    }
    await record({ type: "workload_started", ...slot });
    const sampling = await startSampling({ env: options.env, intervalMs: settings.sampleIntervalMs, container: engine.container });
    const outcome = await runWorkload(engine, next, { settings, prompts: ctx.prompts, now: options.now, signal: options.signal }).then(
      (measured) => ({ measured }),
      (error: unknown) => ({ error }),
    );
    // Sampling stops even when the workload threw, so no nvidia-smi is left running.
    const resources = await sampling.stop();
    if ("error" in outcome) throw outcome.error;
    const { measured } = outcome;
    await record({ type: "workload_ended", ...slot, ...measured, resources });
    if (measured.cancelled) return cancelled("cancelled during a workload");
  }
}

/** Checks one engine; one that serves its model gets an idle GPU sample, then its warmup requests. */
async function checkOne(engine: BenchEngine, ctx: DriveContext): Promise<Extract<BenchEventBody, { type: "engine_checked" }>> {
  const { options, settings } = ctx;
  const check = await checkEngine(engine, { signal: options.signal });
  if (!check.available) return { type: "engine_checked", engine: engine.engine, ...check, idleGpu: null, idleGpuReason: null, warmup: null };
  const idle = await idleGpuMemory(options.env);
  const warmup = await warmUp(engine, settings.warmup, ctx.loadedPrompts, { settings, signal: options.signal });
  return { type: "engine_checked", engine: engine.engine, ...check, ...idle, warmup };
}

/** Reads a bench's ledger, every event checked against the hash chain, and derives its state. */
export async function readBench(dir: string): Promise<BenchView> {
  return replayBench((await readCheckedLedger<BenchEventBody>(join(resolve(dir), "ledger.jsonl"))).events);
}
