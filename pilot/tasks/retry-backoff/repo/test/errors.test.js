import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, isRetryable } from "../src/errors.js";

test("a server error, a rate limit and a timeout are worth retrying", () => {
  assert.equal(isRetryable(new HttpError(503)), true);
  assert.equal(isRetryable(new HttpError(429)), true);
  assert.equal(isRetryable(new HttpError(408)), true);
});

test("a client error is not", () => {
  assert.equal(isRetryable(new HttpError(404)), false);
  assert.equal(isRetryable(new HttpError(400)), false);
});

test("a dropped connection is, and a plain error is not", () => {
  assert.equal(isRetryable(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isRetryable(new Error("bug")), false);
});
