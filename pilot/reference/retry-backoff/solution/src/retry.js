import { realSleep } from "./clock.js";
import { isRetryable as defaultIsRetryable } from "./errors.js";
import { defaultRandom } from "./random.js";

/** Calls `fn(attempt)` until it succeeds, retrying the errors worth retrying, with exponential backoff and jitter. */
export async function withRetry(
  fn,
  { retries = 3, baseMs = 100, maxMs = 10_000, factor = 2, jitter = true, isRetryable = defaultIsRetryable, sleep = realSleep, random = defaultRandom, onRetry, signal } = {},
) {
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError(`retries must be a non-negative integer: ${String(retries)}`);
  if (!(typeof baseMs === "number" && baseMs >= 0)) throw new RangeError(`baseMs must be a non-negative number: ${String(baseMs)}`);
  if (!(typeof maxMs === "number" && maxMs >= 0)) throw new RangeError(`maxMs must be a non-negative number: ${String(maxMs)}`);
  if (!(typeof factor === "number" && factor >= 1)) throw new RangeError(`factor must be at least 1: ${String(factor)}`);
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > retries || !isRetryable(error)) throw error;
      const cap = Math.min(maxMs, baseMs * factor ** (attempt - 1));
      let delayMs = jitter ? Math.floor(cap * random()) : cap;
      if (typeof error?.retryAfterMs === "number" && error.retryAfterMs > delayMs) delayMs = error.retryAfterMs;
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
