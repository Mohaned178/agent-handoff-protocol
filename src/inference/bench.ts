import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ENGINES, type EngineId } from "./engines.ts";

/** What the bench sends an engine (GLOSSARY "Workload"): a closed list, like the conditions. Ticket 02 adds `quality` and `tools`. */
export const WORKLOADS = ["latency", "throughput"] as const;
export type WorkloadId = (typeof WORKLOADS)[number];

/** One engine as the bench file lists it: which engine, where its OpenAI-compatible API is, and the model it serves. */
export interface BenchEngine {
  engine: EngineId;
  /** The API's base, ending in `/v1`: `http://localhost:8001/v1`. */
  baseURL: string;
  /** The model's id as the engine's `/v1/models` lists it. */
  model: string;
  /** How the model is quantized on this engine (`awq`, `q4_K_M`): it differs by engine and is recorded with every result. */
  quantization: string;
  /**
   * The Docker container the engine runs in, as `docker stats` names it (`bench/engines/` names them `ahp-<engine>`). Unset:
   * the engine is not a container, and no Docker figure is recorded for it.
   */
  container?: string;
}

/** A bench file (`ahp bench <file>`): every key but `name`, `engines` and `prompts` has a default. */
export interface BenchFile {
  name: string;
  /** Each engine at most once. `--engine <id>` runs one of them; one engine fits an 8 GB GPU at a time. */
  engines: BenchEngine[];
  /**
   * A directory holding one directory per prompt, `<id>/prompt.md`, sent as the one user message. A relative path is resolved
   * against `RunBenchOptions.baseDir`, which the CLI sets to the directory of the bench file.
   */
  prompts: string;
  /** Default: every workload there is. */
  workloads?: WorkloadId[];
  /** The concurrency levels of the throughput sweep (default `[1, 2, 4, 8]`). */
  concurrency?: number[];
  /** How many times each engine runs every workload (default 3). */
  repeats?: number;
  /** `max_tokens` of every request (default 512). */
  maxTokens?: number;
  /** Requests sent to each engine before its first workload, never recorded as measurements (default 2). */
  warmup?: number;
  /** How long one request may take, in ms, before it is given up as an error (default 120000). */
  timeoutMs?: number;
}

export const BENCH_DEFAULTS = { concurrency: [1, 2, 4, 8], repeats: 3, maxTokens: 512, warmup: 2, timeoutMs: 120_000 } as const;

/** The settings a bench runs with, every default filled in, as `bench_created` records them. */
export interface BenchSettings {
  workloads: WorkloadId[];
  concurrency: number[];
  repeats: number;
  maxTokens: number;
  warmup: number;
  timeoutMs: number;
  /** How often the GPU, the host and Docker are sampled while a workload runs. */
  sampleIntervalMs: number;
}

export const DEFAULT_SAMPLE_INTERVAL_MS = 500;

export const settingsOf = (file: BenchFile, sampleIntervalMs: number): BenchSettings => ({
  workloads: file.workloads ?? [...WORKLOADS],
  concurrency: file.concurrency ?? [...BENCH_DEFAULTS.concurrency],
  repeats: file.repeats ?? BENCH_DEFAULTS.repeats,
  maxTokens: file.maxTokens ?? BENCH_DEFAULTS.maxTokens,
  warmup: file.warmup ?? BENCH_DEFAULTS.warmup,
  timeoutMs: file.timeoutMs ?? BENCH_DEFAULTS.timeoutMs,
  sampleIntervalMs,
});

/** A bench that cannot be run: its file, or its prompts, are invalid. Nothing was written. */
export class BenchInvalidError extends Error {
  override name = "BenchInvalidError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid bench:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
const isNonEmpty = (value: unknown) => typeof value === "string" && value.trim() !== "";

const BENCH_KEYS = ["name", "engines", "prompts", "workloads", "concurrency", "repeats", "maxTokens", "warmup", "timeoutMs"];
const ENGINE_KEYS = ["engine", "baseURL", "model", "quantization", "container"];

/** An http or https URL whose path ends in `/v1`, with no query or fragment. */
function isBaseURL(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.pathname.endsWith("/v1") && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

/** One message per problem with the bench file's own shape; unknown keys are refused, so a misspelt setting is never ignored. */
export function validateBench(bench: unknown): string[] {
  if (!isRecord(bench)) return ["a bench file must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(bench)) if (!BENCH_KEYS.includes(key)) problems.push(`unknown bench property \`${key}\``);
  if (!isNonEmpty(bench.name)) problems.push("the bench needs a non-empty `name`");
  if (!isNonEmpty(bench.prompts)) problems.push("the bench needs `prompts`: the directory of its prompts");
  if (!Array.isArray(bench.engines) || bench.engines.length === 0) {
    problems.push("the bench needs `engines`: a non-empty array of `{ engine, baseURL, model, quantization }`");
  } else {
    const seen = new Set<string>();
    for (const [i, entry] of bench.engines.entries()) {
      const at = `engines[${i}]`;
      if (!isRecord(entry)) {
        problems.push(`\`${at}\` must be \`{ engine, baseURL, model, quantization }\``);
        continue;
      }
      for (const key of Object.keys(entry)) if (!ENGINE_KEYS.includes(key)) problems.push(`unknown property \`${at}.${key}\``);
      if (!(ENGINES as readonly unknown[]).includes(entry.engine)) problems.push(`\`${at}.engine\` must be one of: ${ENGINES.join(", ")}`);
      else if (seen.has(entry.engine as string)) problems.push(`engine ${entry.engine as string} is listed twice: a bench measures each engine once`);
      else seen.add(entry.engine as string);
      if (!isBaseURL(entry.baseURL)) problems.push(`\`${at}.baseURL\` must be an http or https URL ending in /v1, such as http://localhost:8001/v1`);
      if (!isNonEmpty(entry.model)) problems.push(`\`${at}.model\` must be the model's id as the engine lists it`);
      if (!isNonEmpty(entry.quantization)) problems.push(`\`${at}.quantization\` must say how the model is quantized on this engine (awq, q4_K_M, ...)`);
      if (entry.container !== undefined && !(typeof entry.container === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.container))) {
        problems.push(`\`${at}.container\` must be a Docker container name`);
      }
    }
  }
  if (bench.workloads !== undefined) {
    const workloads = bench.workloads;
    if (!Array.isArray(workloads) || workloads.length === 0 || !workloads.every((w) => (WORKLOADS as readonly unknown[]).includes(w))) {
      problems.push(`\`workloads\` must be a non-empty array of: ${WORKLOADS.join(", ")}`);
    } else if (new Set(workloads).size !== workloads.length) problems.push("`workloads` lists a workload twice");
  }
  if (bench.concurrency !== undefined) {
    const levels = bench.concurrency;
    if (!Array.isArray(levels) || levels.length === 0 || !levels.every(isPositiveInteger)) problems.push("`concurrency` must be a non-empty array of positive integers");
    else if (new Set(levels).size !== levels.length) problems.push("`concurrency` lists a level twice");
  }
  if (bench.repeats !== undefined && !isPositiveInteger(bench.repeats)) problems.push("`repeats` must be a positive integer");
  if (bench.maxTokens !== undefined && !isPositiveInteger(bench.maxTokens)) problems.push("`maxTokens` must be a positive integer");
  if (bench.warmup !== undefined && !(Number.isSafeInteger(bench.warmup) && (bench.warmup as number) >= 0)) problems.push("`warmup` must be a non-negative integer");
  if (bench.timeoutMs !== undefined && !isPositiveInteger(bench.timeoutMs)) problems.push("`timeoutMs` must be a positive integer (milliseconds)");
  return problems;
}

/** A prompt as the bench sends it, with the SHA-256 of its file, recorded so two benches can be told to have used the same set. */
export interface BenchPrompt {
  id: string;
  text: string;
  sha256: string;
}

const PROMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Reads every `<id>/prompt.md` under `dir`, sorted by id. Files at the top of `dir` (a README) are not prompts; a directory
 * without `prompt.md`, or none at all, is a problem. Read once, so the bytes hashed are the bytes sent.
 */
export async function loadPrompts(dir: string): Promise<{ prompts: BenchPrompt[]; problems: string[] }> {
  const problems: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch (error) {
    return { prompts: [], problems: [`cannot read the prompts directory ${dir}: ${(error as Error).message}`] };
  }
  const prompts: BenchPrompt[] = [];
  for (const id of entries) {
    if (!(await stat(join(dir, id))).isDirectory()) continue;
    if (!PROMPT_ID.test(id)) {
      problems.push(`prompt directory "${id}" must be named with letters, digits, - and _`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, id, "prompt.md"));
    } catch {
      problems.push(`prompt ${id} has no prompt.md`);
      continue;
    }
    const text = bytes.toString("utf8");
    if (text.trim() === "") problems.push(`prompt ${id}: prompt.md is empty`);
    prompts.push({ id, text, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (prompts.length === 0 && problems.length === 0) problems.push(`the prompts directory ${dir} holds no <id>/prompt.md`);
  return { prompts, problems };
}
