// Inference evaluation (ADR 0007): `ahp bench` measures local engines over their OpenAI-compatible API. This module is the
// only part of AHP that speaks HTTP to a model; it never starts, downloads or serves one.

export { BENCH_DEFAULTS, BenchInvalidError, DEFAULT_SAMPLE_INTERVAL_MS, loadPrompts, settingsOf, validateBench, WORKLOADS } from "./bench.ts";
export type { BenchEngine, BenchFile, BenchPrompt, BenchSettings, WorkloadId } from "./bench.ts";
export { checkEngine, type CheckEngineOptions, type EngineCheck } from "./check.ts";
export { REQUEST_SETTINGS, streamChat } from "./client.ts";
export type { ChatMeasurement, ChatMessage, ChatRequest, ReportedUsage, StreamChatOptions, StreamedToolCall } from "./client.ts";
export { ENGINE_NAMES, ENGINES, isEngineId, VERSION_PATHS, type EngineId } from "./engines.ts";
export { SKIP_REASONS } from "./events.ts";
export type { BenchEndState, BenchEvent, BenchEventBody, BenchEventType, EngineChecked, RequestRecord, ScheduledWorkload, SkipReason, WorkloadEnded } from "./events.ts";
export { applyBenchEvent, BenchLedgerInconsistentError, replayBench } from "./replay.ts";
export type { BenchState, BenchView, EngineCheckView, EngineView, WorkloadView } from "./replay.ts";
export { bytesOf, fingerprintOf, idleGpuMemory, startSampling, statOf } from "./resources.ts";
export type { DockerFigures, GpuFigures, HardwareFingerprint, HostFigures, Resources, SamplingOptions, Stat } from "./resources.ts";
export { readBench, runBench, scheduleOf, type BenchResult, type RunBenchOptions } from "./run.ts";
export { REQUESTS_PER_WORKER, requestsOf, runWorkload, summarizeWorkload, warmUp, type WorkloadSummary } from "./workloads.ts";
