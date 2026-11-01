// The bench ledger: one hash-chained, append-only JSONL file per `ahp bench` invocation, written by the same `LedgerWriter` as
// a run's and an evaluation's. It records the bench as planned (engines, settings, prompts, hardware, the seeded schedule)
// before anything is sent, then each engine's check and each workload's start and end. Its events are its own, like the
// evaluation's, so the run protocol's union stays closed. Fields added later are read with `?? null` or a default.

import type { ChainedEvent } from "../ledger/index.ts";
import type { BenchEngine, BenchSettings, WorkloadId } from "./bench.ts";
import type { ChatMeasurement, REQUEST_SETTINGS } from "./client.ts";
import type { EngineId } from "./engines.ts";
import type { HardwareFingerprint, Resources } from "./resources.ts";

/** One workload of one engine in one repeat, as the schedule lists it: `prompts` is the order its requests go in. */
export interface ScheduledWorkload {
  engine: EngineId;
  /** From 1. */
  repeat: number;
  workload: WorkloadId;
  /** 1 for `latency`; the sweep's level for `throughput`. */
  concurrency: number;
  /** Prompt ids in the order drawn from the seed; `throughput` cycles through them for as many requests as it sends. */
  prompts: string[];
}

/** One measured request: what `streamChat` measured, without the answer's text, with when it ran within its workload. */
export type RequestRecord = Omit<ChatMeasurement, "content" | "toolCalls"> & {
  promptId: string;
  /** Milliseconds from the workload's start to the request's start, and to its end. */
  startMs: number;
  endMs: number;
};

/** Why a workload was not run. */
export const SKIP_REASONS = ["engine_unavailable"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type BenchEndState = "completed" | "cancelled" | "stopped";

export type BenchEventBody =
  | {
      type: "bench_created";
      benchId: string;
      protocolVersion: string;
      name: string;
      seed: number;
      /** `--engine <id>`: the one engine of the file this bench runs; null when it runs every engine listed. */
      onlyEngine: EngineId | null;
      /** The engines this bench runs, as the file lists them. */
      engines: BenchEngine[];
      settings: BenchSettings;
      /** What every request sends beside its model, messages and `max_tokens`. */
      request: typeof REQUEST_SETTINGS;
      prompts: { id: string; sha256: string }[];
      fingerprint: HardwareFingerprint;
      /** Every workload, in the order they run: engines × repeats shuffled from the seed, each with its workloads in order. */
      schedule: ScheduledWorkload[];
    }
  | {
      type: "engine_checked";
      engine: EngineId;
      available: boolean;
      models: string[] | null;
      version: string | null;
      error: string | null;
      /** GPU memory in use before any request was sent to this engine; null with the reason when it could not be read or the engine is unavailable. */
      idleGpu: { memoryUsedMiB: number | null; source: "nvidia-smi" } | null;
      idleGpuReason: string | null;
      /** The warmup requests sent after the idle sample, never measurements: how many, and how many failed. Null for an unavailable engine. */
      warmup: { requests: number; failed: number; firstError: string | null } | null;
    }
  | { type: "workload_started"; engine: EngineId; repeat: number; workload: WorkloadId; concurrency: number }
  | {
      type: "workload_ended";
      engine: EngineId;
      repeat: number;
      workload: WorkloadId;
      concurrency: number;
      /** From the workload's start to its last request's end. */
      wallMs: number;
      requests: RequestRecord[];
      resources: Resources;
      /** True when a cancel cut it short: its requests in flight are recorded with the error `cancelled`. */
      cancelled: boolean;
    }
  | { type: "workload_skipped"; engine: EngineId; repeat: number; workload: WorkloadId; concurrency: number; reason: SkipReason; error: string | null }
  | { type: "bench_ended"; state: BenchEndState; reason: string | null }
  | { type: "ledger_truncated"; droppedBytes: number };

export type BenchEventType = BenchEventBody["type"];
export type BenchEvent = ChainedEvent<BenchEventBody>;
export type WorkloadEnded = Extract<BenchEvent, { type: "workload_ended" }>;
export type EngineChecked = Extract<BenchEvent, { type: "engine_checked" }>;
