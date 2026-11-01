import type { BenchEngine, BenchPrompt, BenchSettings } from "./bench.ts";
import { streamChat } from "./client.ts";
import type { RequestRecord, ScheduledWorkload, WorkloadEnded } from "./events.ts";

/** Each throughput worker sends at least this many requests, so a level is not measured on its first requests alone. */
export const REQUESTS_PER_WORKER = 4;

/** The prompts a workload sends, in order: `latency` each once; `throughput` cycles through them for at least 4 per worker. */
export function requestsOf(unit: Pick<ScheduledWorkload, "workload" | "concurrency" | "prompts">): string[] {
  if (unit.workload === "latency") return [...unit.prompts];
  const count = Math.max(unit.prompts.length, REQUESTS_PER_WORKER * unit.concurrency);
  return Array.from({ length: count }, (_, i) => unit.prompts[i % unit.prompts.length]!);
}

export interface WorkloadRunOptions {
  settings: BenchSettings;
  prompts: ReadonlyMap<string, BenchPrompt>;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Runs one workload against one engine: a pool of `concurrency` workers (one for `latency`) draining its requests in order.
 * Every request is recorded as `streamChat` measured it; after a cancel no request starts, and those in flight end `cancelled`.
 */
export async function runWorkload(engine: BenchEngine, unit: ScheduledWorkload, options: WorkloadRunOptions): Promise<Pick<WorkloadEnded, "wallMs" | "requests" | "cancelled">> {
  const now = options.now ?? (() => performance.now());
  const queue = requestsOf(unit);
  const records: (RequestRecord | undefined)[] = new Array(queue.length);
  let next = 0;
  const started = now();
  const worker = async () => {
    while (next < queue.length && !options.signal?.aborted) {
      const index = next++;
      const promptId = queue[index]!;
      const startMs = now() - started;
      const { content: _content, toolCalls: _toolCalls, ...measured } = await streamChat(
        { baseURL: engine.baseURL, model: engine.model, messages: [{ role: "user", content: options.prompts.get(promptId)!.text }], maxTokens: options.settings.maxTokens },
        { timeoutMs: options.settings.timeoutMs, now, signal: options.signal },
      );
      records[index] = { promptId, ...measured, startMs: round(startMs), endMs: round(now() - started) };
    }
  };
  const workers = unit.workload === "latency" ? 1 : unit.concurrency;
  await Promise.all(Array.from({ length: workers }, worker));
  const requests = records.filter((record): record is RequestRecord => record !== undefined);
  return { wallMs: round(now() - started), requests, cancelled: options.signal?.aborted ?? false };
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
