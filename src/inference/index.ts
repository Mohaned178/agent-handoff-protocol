// Inference evaluation (ADR 0007): `ahp bench` measures local engines over their OpenAI-compatible API. This module is the
// only part of AHP that speaks HTTP to a model; it never starts, downloads or serves one.

export { BENCH_DEFAULTS, BenchInvalidError, DEFAULT_SAMPLE_INTERVAL_MS, DEFAULT_WORKLOADS, loadPrompts, settingsOf, sha256Of, validateBench, WORKLOADS } from "./bench.ts";
export type { BenchEngine, BenchFile, BenchPrompt, BenchSettings, HashedText, WorkloadId } from "./bench.ts";
export { checkEngine, type CheckEngineOptions, type EngineCheck } from "./check.ts";
export { REQUEST_SETTINGS, streamChat } from "./client.ts";
export type { ChatMeasurement, ChatMessage, ChatRequest, ReportedUsage, StreamChatOptions, StreamedToolCall } from "./client.ts";
export { ENGINE_NAMES, ENGINES, isBaseURL, isEngineId, VERSION_PATHS, type EngineId } from "./engines.ts";
export { SKIP_REASONS } from "./events.ts";
export type { BenchEndState, BenchEvent, BenchEventBody, BenchEventType, EngineChecked, RequestRecord, ScheduledWorkload, SkipReason, WorkloadEnded } from "./events.ts";
export { applyBenchEvent, BenchLedgerInconsistentError, replayBench } from "./replay.ts";
export type { BenchState, BenchView, EngineCheckView, EngineView, WorkloadView } from "./replay.ts";
export { bytesOf, fingerprintOf, idleGpuMemory, startSampling, statOf } from "./resources.ts";
export type { DockerFigures, GpuFigures, HardwareFingerprint, HostFigures, Resources, SamplingOptions, Stat } from "./resources.ts";
export { CANCELLED_WHILE_TESTING, QUALITY_OUTCOMES, extractCode, failureDetail, scoreQuality, DEFAULT_TEST_TIMEOUT_MS, SOLUTION_FILE, TEST_FILE } from "./quality.ts";
export type { CodeBlock, QualityOutcome, QualityScoreOptions } from "./quality.ts";
export {
  BenchesNotComparableError,
  comparabilityProblems,
  DEFAULT_REPORT_SEED,
  formatBenchReport,
  percentile,
  percentilesOf,
  PERCENTILES,
  reportOf,
} from "./report.ts";
export type { BenchReference, BenchReport, EngineReport, PairComparison, Percentiles, ResourceReport, ScoreReport, Spread, ThroughputLevel, TimingReport } from "./report.ts";
export { verifiedComparisonsOf, verifiedProblems, verifiedSuccessOf } from "./verified.ts";
export type { ConditionSuccess, EvaluationReference, VerifiedComparison, VerifiedSuccess } from "./verified.ts";
export { readBench, runBench, scheduleOf, writeBenchReport, type BenchResult, type RunBenchOptions, type ScheduleIds } from "./run.ts";
export type { RequestScore, ScoreResult } from "./score.ts";
export { loadToolCases, scoreToolCall, TOOL_OUTCOMES, validateToolCase } from "./tools.ts";
export type { ExpectedCall, ToolCase, ToolOutcome } from "./tools.ts";
export { REQUESTS_PER_WORKER, requestsOf, runWorkload, NOT_SCORED_CANCELLED, scoreWorkload, summarizeWorkload, warmUp, workersOf, type Answer, type WorkloadSummary } from "./workloads.ts";
