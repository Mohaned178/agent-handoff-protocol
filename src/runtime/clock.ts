import { setTimeout as wait } from "node:timers/promises";

/**
 * Where the runtime gets the time and waits. Production uses the system clock; tests pass one that never really
 * waits, so a retry's backoff costs nothing and every wait is visible.
 */
export interface Clock {
  /** Stamps ledger events. */
  now(): Date;
  /**
   * Resolves after `ms` milliseconds: the runtime waits out a retry's backoff with it, and bounds how long it waits for
   * an adapter during a cancel. Once `signal` is aborted it may settle early, either way, and stop holding a timer.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) => wait(ms, undefined, { signal }),
};
