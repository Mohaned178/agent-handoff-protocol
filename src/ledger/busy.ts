import { setTimeout as sleep } from "node:timers/promises";

/** The waits before each retry; about 0.8 s in all. */
const BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

/**
 * Runs a file operation that opens, reads or removes a file, retrying it a bounded number of times while it fails
 * with `EBUSY` or `EPERM`, which on Windows an antivirus scanner or the search indexer briefly holding the file
 * causes. Never wrap a write in this: a write that failed partway is not retried.
 */
export async function whileBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await operation();
    } catch (error) {
      const delay = BUSY_RETRY_DELAYS_MS[retry];
      const code = (error as NodeJS.ErrnoException).code;
      if (delay === undefined || (code !== "EBUSY" && code !== "EPERM")) throw error;
      await sleep(delay);
    }
  }
}
