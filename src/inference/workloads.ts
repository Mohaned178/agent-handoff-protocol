import type { BenchEngine, BenchPrompt, BenchSettings } from "./bench.ts";
import { streamChat, type StreamedToolCall } from "./client.ts";
import type { RequestRecord, ScheduledWorkload, WorkloadEnded } from "./events.ts";
import { CANCELLED_WHILE_TESTING, scoreQuality, type QualityScoreOptions } from "./quality.ts";
import type { ScoreResult } from "./score.ts";
import { scoreToolCall, type ToolCase } from "./tools.ts";

/** Each throughput worker sends at least this many requests, so a level is not measured on its first requests alone. */
export const REQUESTS_PER_WORKER = 4;

/**
 * The ids a workload sends, in order. Only `throughput` cycles through them, for at least 4 per worker; every other workload
 * (`latency`, `quality`, `tools`) sends each once, one at a time.
 */
export function requestsOf(unit: Pick<ScheduledWorkload, "workload" | "concurrency" | "prompts">): string[] {
  if (unit.workload !== "throughput") return [...unit.prompts];
  const count = Math.max(unit.prompts.length, REQUESTS_PER_WORKER * unit.concurrency);
  return Array.from({ length: count }, (_, i) => unit.prompts[i % unit.prompts.length]!);
}

/** How many requests a workload has in flight at most: only `throughput` has more than one. */
export const workersOf = (unit: Pick<ScheduledWorkload, "workload" | "concurrency">) => (unit.workload === "throughput" ? unit.concurrency : 1);

/** What an answer said, kept in memory only until it is scored (the ledger does not hold the text). */
export interface Answer {
  content: string;
  toolCalls: StreamedToolCall[];
}

export interface WorkloadRunOptions {
  settings: BenchSettings;
  prompts: ReadonlyMap<string, BenchPrompt>;
  /** The cases of the `tools` workload, by id: their ids are not the prompts', and are looked up apart. */
  toolCases?: ReadonlyMap<string, ToolCase>;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Runs one workload against one engine: a pool of `concurrency` workers (one for `latency`) draining its requests in order.
 * Every request is recorded as `streamChat` measured it; after a cancel no request starts, and those in flight end `cancelled`.
 */
export async function runWorkload(
  engine: BenchEngine,
  unit: ScheduledWorkload,
  options: WorkloadRunOptions,
): Promise<Pick<WorkloadEnded, "wallMs" | "requests" | "cancelled"> & { answers: Answer[] }> {
  const now = options.now ?? (() => performance.now());
  const queue = requestsOf(unit);
  const records: (RequestRecord | undefined)[] = new Array(queue.length);
  const answered: (Answer | undefined)[] = new Array(queue.length);
  let next = 0;
  const started = now();
  const worker = async () => {
    while (next < queue.length && !options.signal?.aborted) {
      const index = next++;
      const promptId = queue[index]!;
      const startMs = now() - started;
      const toolCase = unit.workload === "tools" ? options.toolCases?.get(promptId) : undefined;
      const text = toolCase ? toolCase.prompt : options.prompts.get(promptId)!.text;
      const { content, toolCalls, ...measured } = await streamChat(
        { baseURL: engine.baseURL, model: engine.model, messages: [{ role: "user", content: text }], maxTokens: options.settings.maxTokens, ...(toolCase ? { tools: toolCase.tools } : {}) },
        { timeoutMs: options.settings.timeoutMs, now, signal: options.signal },
      );
      records[index] = { promptId, ...measured, startMs: round(startMs), endMs: round(now() - started) };
      answered[index] = { content, toolCalls };
    }
  };
  await Promise.all(Array.from({ length: workersOf(unit) }, worker));
  const requests = records.filter((record): record is RequestRecord => record !== undefined);
  const answers = answered.filter((answer): answer is Answer => answer !== undefined);
  return { wallMs: round(now() - started), requests, answers, cancelled: options.signal?.aborted ?? false };
}

/** The problem an answer carries when a cancel came before its tests were run. */
export const NOT_SCORED_CANCELLED = "not scored: the bench was cancelled";

export interface ScoringOptions {
  prompts: ReadonlyMap<string, BenchPrompt>;
  toolCases?: ReadonlyMap<string, ToolCase>;
  quality?: Pick<QualityScoreOptions, "timeoutMs" | "env">;
  /** Once aborted, no further answer is scored (a cancelled bench scores nothing more). */
  signal?: AbortSignal;
}

/**
 * Scores a `quality` or `tools` workload's answers after it has ended and its resources are no longer sampled, so running the
 * tests is not in the workload's figures. Only a request that ran to `[DONE]` has an answer to score: an engine error is counted
 * as an error, never as a failed answer. Other workloads are returned as they are. Never throws; a request that could not be
 * scored keeps no score and says why. `cutShort` is true when a cancel left an answer unscored, so the workload is recorded
 * cancelled and its partial scores never count as a finished workload's.
 */
export async function scoreWorkload(unit: Pick<ScheduledWorkload, "workload">, requests: readonly RequestRecord[], answers: readonly Answer[], options: ScoringOptions): Promise<{ requests: RequestRecord[]; cutShort: boolean }> {
  if (unit.workload !== "quality" && unit.workload !== "tools") return { requests: [...requests], cutShort: false };
  const scored: RequestRecord[] = [];
  let cutShort = false;
  for (const [i, request] of requests.entries()) {
    const answer = answers[i];
    if (request.error !== null || !answer) {
      scored.push({ ...request, score: null, scoreProblem: null });
      continue;
    }
    if (options.signal?.aborted) {
      cutShort = true;
      scored.push({ ...request, score: null, scoreProblem: NOT_SCORED_CANCELLED });
      continue;
    }
    let result: ScoreResult;
    if (unit.workload === "quality") {
      const test = options.prompts.get(request.promptId)?.test;
      result = test ? await scoreQuality(answer.content, test.text, { ...options.quality, finishReason: request.finishReason, signal: options.signal }) : { score: null, problem: `prompt ${request.promptId} has no test.mjs` };
    } else {
      const toolCase = options.toolCases?.get(request.promptId);
      result = toolCase ? { score: { ...scoreToolCall(answer.toolCalls, toolCase.expect), codeSha256: null }, problem: null } : { score: null, problem: `no tool-call case ${request.promptId}` };
    }
    if (result.problem === CANCELLED_WHILE_TESTING) cutShort = true;
    scored.push({ ...request, score: result.score, scoreProblem: result.problem });
  }
  return { requests: scored, cutShort };
}

/** Sends `count` warmup requests, one at a time, cycling the prompts. They are counted, never measured. */
export async function warmUp(engine: BenchEngine, count: number, prompts: readonly BenchPrompt[], options: Omit<WorkloadRunOptions, "prompts">): Promise<{ requests: number; failed: number; firstError: string | null }> {
  let failed = 0;
  let firstError: string | null = null;
  let sent = 0;
  for (; sent < count && !options.signal?.aborted; sent++) {
    const { error } = await streamChat(
      { baseURL: engine.baseURL, model: engine.model, messages: [{ role: "user", content: prompts[sent % prompts.length]!.text }], maxTokens: options.settings.maxTokens },
      { timeoutMs: options.settings.timeoutMs, signal: options.signal },
    );
    if (error !== null) {
      failed += 1;
      firstError ??= error;
    }
  }
  return { requests: sent, failed, firstError };
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

export interface WorkloadSummary {
  requests: number;
  /** Requests that ran to `[DONE]`. */
  succeeded: number;
  failed: number;
  /** How many requests had a completion-token count the engine reported. */
  usageReported: number;
  /** Requests that succeeded per second of the workload's wall time. */
  requestsPerSecond: number | null;
  /** Output tokens per second, from reported usage only: null unless every request reported its completion tokens. */
  outputTokensPerSecond: number | null;
}

/** What a workload's requests add up to. Tokens are the engine's reported usage, never counted from chunks. */
export function summarizeWorkload(ended: Pick<WorkloadEnded, "wallMs" | "requests">): WorkloadSummary {
  const { requests, wallMs } = ended;
  const succeeded = requests.filter((request) => request.error === null).length;
  const tokens = requests.map((request) => request.usage?.completionTokens ?? null);
  const usageReported = tokens.filter((count) => count !== null).length;
  const seconds = wallMs / 1000;
  const everyReported = requests.length > 0 && usageReported === requests.length;
  return {
    requests: requests.length,
    succeeded,
    failed: requests.length - succeeded,
    usageReported,
    requestsPerSecond: seconds > 0 ? succeeded / seconds : null,
    outputTokensPerSecond: seconds > 0 && everyReported ? (tokens as number[]).reduce((sum, count) => sum + count, 0) / seconds : null,
  };
}
