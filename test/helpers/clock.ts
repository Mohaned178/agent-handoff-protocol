import type { Clock } from "../../src/index.ts";

/**
 * A clock that never really waits: `sleep` records the delay and moves the time forward by it, so a test sees
 * every wait the runtime asked for and the ledger's timestamps account for them.
 */
export function fakeClock(start = "2026-01-01T00:00:00.000Z"): Clock & { slept: number[] } {
  let now = Date.parse(start);
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(now),
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}
