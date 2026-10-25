/**
 * Where the runtime gets the time and waits. Production uses the system clock; tests pass one that never really
 * waits, so a retry's backoff costs nothing and every wait is visible.
 */
export interface Clock {
  /** Stamps ledger events. */
  now(): Date;
  /** Resolves after `ms` milliseconds; the runtime waits through it before a retry after a transient failure. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
