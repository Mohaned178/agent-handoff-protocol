import type { Clock } from "./clock.ts";

/** What a run's cancel needs wherever it can cut something short. */
export interface RunCancel {
  /** Aborted when the run is to be cancelled; none when nothing can cancel it. */
  signal: AbortSignal | undefined;
  /** How long a process being stopped is given to stop gracefully before its tree is killed. */
  graceMs: number;
}

/** What a race settles with when the run's cancel came first. */
export const CANCELLED: unique symbol = Symbol("cancelled");
/** What `within` settles with when the time ran out first. */
export const TIMED_OUT: unique symbol = Symbol("timed out");

/** Settles with `promise`'s value, or with `CANCELLED` once `signal` is aborted, whichever comes first. */
export async function unlessCancelled<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof CANCELLED> {
  if (!signal) return promise;
  if (signal.aborted) return CANCELLED;
  let onAbort = () => undefined as void;
  const cancelled = new Promise<typeof CANCELLED>((resolve) => {
    onAbort = () => resolve(CANCELLED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Settles with `promise`'s value, or with `TIMED_OUT` once `clock` says `ms` have passed. */
export async function within<T>(promise: Promise<T>, ms: number, clock: Clock): Promise<T | typeof TIMED_OUT> {
  const done = new AbortController();
  try {
    const timedOut = clock.sleep(ms, done.signal).then(
      (): typeof TIMED_OUT => TIMED_OUT,
      (): typeof TIMED_OUT => TIMED_OUT,
    );
    return await Promise.race([promise, timedOut]);
  } finally {
    // Stops the clock's timer, so a wait that is over keeps nothing alive.
    done.abort();
  }
}

/**
 * Whether the run was cancelled at about the time something ended, which may then have ended because of the cancel.
 * On Windows a console's Ctrl+C reaches the processes AHP started at the same moment as AHP, so one of them can end
 * before AHP hears of the cancel: a process that failed there is given a moment for the cancel to arrive.
 */
export async function cancelledAround(succeeded: boolean, { signal }: RunCancel, clock: Clock): Promise<boolean> {
  if (signal === undefined || signal.aborted || succeeded || process.platform !== "win32") return signal?.aborted ?? false;
  let onAbort = () => undefined as void;
  const heard = new Promise<true>((resolve) => {
    onAbort = () => resolve(true);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return (await within(heard, CONSOLE_CANCEL_MS, clock)) === true;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** How long a process that failed on Windows waits for a console Ctrl+C to reach AHP too. */
const CONSOLE_CANCEL_MS = 250;
