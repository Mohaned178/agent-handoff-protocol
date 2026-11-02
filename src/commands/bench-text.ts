import { ENGINE_NAMES, summarizeWorkload, type BenchEvent, type BenchView } from "../inference/index.ts";

/** What a scored workload's answers came to, as `pass 5, fail 1`: the outcomes of its scored requests, in the order they first appear. */
function outcomesOf(requests: readonly { score?: { outcome: string } | null }[]): string {
  const counts = new Map<string, number>();
  for (const request of requests) if (request.score) counts.set(request.score.outcome, (counts.get(request.score.outcome) ?? 0) + 1);
  return [...counts.entries()].map(([outcome, count]) => `${outcome} ${count}`).join(", ");
}

/** One progress line for an event `ahp bench` has just recorded. */
export function formatBenchEvent(event: BenchEvent, state: Readonly<BenchView>): string {
  const slot = (e: { engine: keyof typeof ENGINE_NAMES; workload: string; concurrency: number; repeat: number }) => {
    const total = state.settings.repeats;
    return `${ENGINE_NAMES[e.engine]} ${e.workload}${e.workload === "throughput" ? ` at concurrency ${e.concurrency}` : ""}, repeat ${e.repeat} of ${total}`;
  };
  switch (event.type) {
    case "bench_created":
      return `bench ${event.benchId}: "${event.name}", ${event.engines.map((engine) => ENGINE_NAMES[engine.engine]).join(", ")}; ${event.schedule.length} workload${event.schedule.length === 1 ? "" : "s"} scheduled in a shuffled order (seed ${event.seed})`;
    case "engine_checked": {
      if (!event.available) return `${ENGINE_NAMES[event.engine]}: UNAVAILABLE: ${event.error}`;
      const warmup = event.warmup && event.warmup.failed > 0 ? `; ${event.warmup.failed} of ${event.warmup.requests} warmup requests failed (${event.warmup.firstError})` : "";
      return `${ENGINE_NAMES[event.engine]}: serves its model${event.version ? `, version ${event.version}` : ", version not reported"}${warmup}`;
    }
    case "workload_started":
      return `${slot(event)}: started`;
    case "workload_ended": {
      const summary = summarizeWorkload(event);
      const scored = outcomesOf(event.requests);
      return `${slot(event)}: ${summary.succeeded} of ${summary.requests} requests ok in ${(event.wallMs / 1000).toFixed(1)} s${scored ? `; ${scored}` : ""}${event.cancelled ? " (cancelled)" : ""}`;
    }
    case "workload_skipped":
      return `${slot(event)}: skipped (${event.reason.replaceAll("_", " ")})`;
    case "bench_ended":
      return `bench ${event.state}${event.reason ? `: ${event.reason}` : ""}`;
    case "ledger_truncated":
      return `bench ledger: dropped ${event.droppedBytes} bytes of a torn last line`;
    default: {
      const unhandled: never = event;
      return `bench event ${(unhandled as BenchEvent).type}`;
    }
  }
}
