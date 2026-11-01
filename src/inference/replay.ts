import type { BenchEngine, BenchSettings } from "./bench.ts";
import type { EngineId } from "./engines.ts";
import type { BenchEndState, BenchEvent, EngineChecked, ScheduledWorkload, SkipReason, WorkloadEnded } from "./events.ts";
import type { HardwareFingerprint } from "./resources.ts";

/** A bench ledger whose events do not follow from each other in a way the hash chain does not catch (a workload out of turn). */
export class BenchLedgerInconsistentError extends Error {
  override name = "BenchLedgerInconsistentError";
  constructor(event: BenchEvent, problem: string) {
    super(`bench ledger event ${event.seq} (${event.type}): ${problem}`);
  }
}

export type EngineCheckView = Omit<EngineChecked, "type" | "seq" | "prevHash" | "time" | "hash" | "engine"> & { checkedAt: string };

/** An engine of the bench, and what its check found; `check` is null until it has been checked. */
export type EngineView = BenchEngine & { check: EngineCheckView | null };

export interface WorkloadView extends ScheduledWorkload {
  /** `running` from its start to its end; `skipped` when it was never run. */
  status: "running" | "ended" | "skipped";
  startedAt: string | null;
  ended: WorkloadEnded | null;
  skipped: { reason: SkipReason; error: string | null } | null;
}

export type BenchState = "running" | BenchEndState;

export interface BenchView {
  benchId: string;
  protocolVersion: string;
  name: string;
  seed: number;
  onlyEngine: EngineId | null;
  settings: BenchSettings;
  prompts: { id: string; sha256: string }[];
  fingerprint: HardwareFingerprint;
  engines: EngineView[];
  /** The workloads still to start or skip, the next first. What is left when the bench ends was never run (a cancel or an error). */
  pending: ScheduledWorkload[];
  /** The workloads started or skipped, in that order. */
  workloads: WorkloadView[];
  state: BenchState;
  reason: string | null;
  createdAt: string;
  endedAt: string | null;
  ledgerTruncations: number;
}

/** Derives a bench's state from the events of its ledger. */
export function replayBench(events: readonly BenchEvent[]): BenchView {
  let state: BenchView | undefined;
  for (const event of events) state = applyBenchEvent(state, event);
  if (!state) throw new Error("bench ledger is empty");
  return state;
}

const sameSlot = (a: Pick<ScheduledWorkload, "engine" | "repeat" | "workload" | "concurrency">, b: Pick<ScheduledWorkload, "engine" | "repeat" | "workload" | "concurrency">) =>
  a.engine === b.engine && a.repeat === b.repeat && a.workload === b.workload && a.concurrency === b.concurrency;

const slotName = (slot: Pick<ScheduledWorkload, "engine" | "repeat" | "workload" | "concurrency">) => `${slot.engine} ${slot.workload} at concurrency ${slot.concurrency}, repeat ${slot.repeat}`;

/** Applies one event; the first must be `bench_created`. The state is updated in place and returned. */
export function applyBenchEvent(state: BenchView | undefined, event: BenchEvent): BenchView {
  if (event.type === "bench_created") {
    if (state) throw new BenchLedgerInconsistentError(event, "bench already created");
    return {
      benchId: event.benchId,
      protocolVersion: event.protocolVersion,
      name: event.name,
      seed: event.seed,
      onlyEngine: event.onlyEngine ?? null,
      settings: event.settings,
      prompts: event.prompts,
      fingerprint: event.fingerprint,
      engines: event.engines.map((engine) => ({ ...engine, check: null })),
      pending: [...event.schedule],
      workloads: [],
      state: "running",
      reason: null,
      createdAt: event.time,
      endedAt: null,
      ledgerTruncations: 0,
    };
  }
  if (!state) throw new BenchLedgerInconsistentError(event, "the first event must be bench_created");
  if (event.type === "ledger_truncated") {
    state.ledgerTruncations += 1;
    return state;
  }
  if (state.state !== "running") throw new BenchLedgerInconsistentError(event, "the bench has already ended");
  const running = state.workloads.find((workload) => workload.status === "running");
  switch (event.type) {
    case "engine_checked": {
      const engine = state.engines.find((candidate) => candidate.engine === event.engine);
      if (!engine) throw new BenchLedgerInconsistentError(event, `engine ${event.engine} is not one of this bench's`);
      if (engine.check) throw new BenchLedgerInconsistentError(event, `engine ${event.engine} was already checked`);
      if (state.workloads.length > 0) throw new BenchLedgerInconsistentError(event, "every engine is checked before any workload");
      const { type: _type, seq: _seq, prevHash: _prev, time, hash: _hash, engine: _engine, ...check } = event;
      engine.check = { ...check, idleGpuReason: check.idleGpuReason ?? null, warmup: check.warmup ?? null, checkedAt: time };
      return state;
    }
    case "workload_started":
    case "workload_skipped": {
      if (running) throw new BenchLedgerInconsistentError(event, `${slotName(running)} has not ended`);
      const next = state.pending[0];
      if (!next || !sameSlot(next, event)) throw new BenchLedgerInconsistentError(event, `${slotName(event)} is not the next workload scheduled${next ? ` (${slotName(next)} is)` : ""}`);
      if (state.engines.some((engine) => !engine.check)) throw new BenchLedgerInconsistentError(event, "every engine is checked before any workload");
      const check = state.engines.find((engine) => engine.engine === event.engine)!.check!;
      if (event.type === "workload_started" && !check.available) throw new BenchLedgerInconsistentError(event, `engine ${event.engine} is not available, so none of its workloads runs`);
      if (event.type === "workload_skipped" && check.available) throw new BenchLedgerInconsistentError(event, `engine ${event.engine} is available: its workloads are not skipped`);
      state.pending.shift();
      state.workloads.push(
        event.type === "workload_started"
          ? { ...next, status: "running", startedAt: event.time, ended: null, skipped: null }
          : { ...next, status: "skipped", startedAt: null, ended: null, skipped: { reason: event.reason, error: event.error ?? null } },
      );
      return state;
    }
    case "workload_ended": {
      if (!running || !sameSlot(running, event)) throw new BenchLedgerInconsistentError(event, `${slotName(event)} was not started`);
      running.status = "ended";
      running.ended = { ...event, cancelled: event.cancelled ?? false };
      return state;
    }
    case "bench_ended": {
      // Only an error stops a bench in the middle of a workload, which then stays `running`: it never ended.
      if (running && event.state !== "stopped") throw new BenchLedgerInconsistentError(event, `${slotName(running)} has not ended`);
      state.state = event.state;
      state.reason = event.reason ?? null;
      state.endedAt = event.time;
      return state;
    }
    default: {
      const unhandled: never = event;
      throw new Error(`unknown bench event ${(unhandled as BenchEvent).type}`);
    }
  }
}
