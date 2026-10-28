import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { TimeoutDefinition } from "../protocol/index.ts";

/** A step's attempt limits with every default filled in; 0 is no limit. */
export interface ResolvedTimeout {
  totalMs: number;
  idleMs: number;
}

const DEFAULT_TIMEOUT: ResolvedTimeout = { totalMs: 60 * 60_000, idleMs: 10 * 60_000 };

export function resolveTimeout(timeout: TimeoutDefinition = {}): ResolvedTimeout {
  return { totalMs: timeout.totalMs ?? DEFAULT_TIMEOUT.totalMs, idleMs: timeout.idleMs ?? DEFAULT_TIMEOUT.idleMs };
}

/** Which limit an attempt ran past. */
export interface Overrun {
  limit: "totalMs" | "idleMs";
  ms: number;
}

/** What a step's limits tell its agent's user, in the failure the attempt is recorded with. */
export function overrunMessage({ limit, ms }: Overrun): string {
  const span = ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;
  return limit === "idleMs"
    ? `the agent's tool printed nothing for ${span} (the step's timeout.idleMs), so AHP stopped it`
    : `the attempt ran for ${span} (the step's timeout.totalMs), so AHP stopped it`;
}

/**
 * Settles with the limit an attempt ran past first; stays pending once `stop` is aborted. Idleness is read from the size
 * of the attempt's stdout transcript, which every adapter keeps, so the core needs nothing from the tool. Real timers,
 * not the run's `Clock`: these limits are on the agent's real process, and a fake clock that never waits would end every
 * attempt at once.
 */
export async function watchAttempt(output: string | undefined, timeout: ResolvedTimeout, stop: AbortSignal): Promise<Overrun> {
  const { totalMs, idleMs } = timeout;
  const watched = [totalMs, idleMs].filter((ms) => ms > 0);
  if (watched.length === 0) return new Promise<never>(() => undefined);
  const pollMs = Math.min(5_000, Math.max(20, Math.floor(Math.min(...watched) / 4)));
  const start = Date.now();
  let lastSize = -1;
  let lastActivity = start;
  for (;;) {
    try {
      await sleep(pollMs, undefined, { signal: stop });
    } catch {
      return new Promise<never>(() => undefined);
    }
    const now = Date.now();
    if (totalMs > 0 && now - start >= totalMs) return { limit: "totalMs", ms: totalMs };
    if (idleMs > 0) {
      const size = output === undefined ? 0 : await stat(output).then((s) => s.size, () => 0);
      if (size !== lastSize) {
        lastSize = size;
        lastActivity = now;
      } else if (now - lastActivity >= idleMs) {
        return { limit: "idleMs", ms: idleMs };
      }
    }
  }
}
