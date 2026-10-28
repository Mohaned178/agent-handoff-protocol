/** An error from an HTTP call: `status` is the response's status code; `retryAfterMs` is what the server asked for, if it did. */
export class HttpError extends Error {
  constructor(status, message = `HTTP ${status}`, { retryAfterMs } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);

/** Whether trying the call again could work: the server or the network failed, or asked us to slow down. */
export function isRetryable(error) {
  if (error && typeof error.code === "string" && NETWORK_CODES.has(error.code)) return true;
  const status = error?.status;
  if (typeof status !== "number") return false;
  return status >= 500 || status === 429 || status === 408;
}
