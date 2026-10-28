import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, isRetryable } from "../src/errors.js";
import * as retry from "../src/retry.js";

/** A fake sleep that records the delays it was asked for, and a fixed random. */
function harness(options = {}) {
  const delays = [];
  return { delays, options: { sleep: async (ms) => void delays.push(ms), random: () => 0.5, ...options } };
}

/** A function that throws `makeError(call)` on its first `failures` calls, then returns "ok on <attempt>". */
function flaky(failures, makeError) {
  const attempts = [];
  const fn = async (attempt) => {
    attempts.push(attempt);
    if (attempts.length <= failures) throw makeError(attempts.length);
    return `ok on ${attempt}`;
  };
  return { fn, attempts };
}

const unavailable = () => new HttpError(503);

test("the first success is returned with no waiting", async () => {
  const { delays, options } = harness();
  const { fn, attempts } = flaky(0, unavailable);
  assert.equal(await retry.withRetry(fn, options), "ok on 1");
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(delays, []);
});

test("a failing call is tried again with growing delays", async () => {
  const { delays, options } = harness({ jitter: false });
  const { fn, attempts } = flaky(2, unavailable);
  assert.equal(await retry.withRetry(fn, options), "ok on 3");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [100, 200]);
});

test("delays are capped at maxMs", async () => {
  const { delays, options } = harness({ jitter: false, retries: 5, baseMs: 100, maxMs: 500, factor: 2 });
  const { fn } = flaky(5, unavailable);
  assert.equal(await retry.withRetry(fn, options), "ok on 6");
  assert.deepEqual(delays, [100, 200, 400, 500, 500]);
});

test("factor sets the growth", async () => {
  const { delays, options } = harness({ jitter: false, retries: 3, baseMs: 10, factor: 3 });
  await retry.withRetry(flaky(3, unavailable).fn, options);
  assert.deepEqual(delays, [10, 30, 90]);
});

test("jitter is a random share of the capped delay, rounded down, one draw per retry", async () => {
  const draws = [0.5, 0.25, 0.999];
  const seen = [];
  const { delays, options } = harness({ random: () => { seen.push(true); return draws[seen.length - 1]; } });
  await retry.withRetry(flaky(3, unavailable).fn, options);
  assert.deepEqual(delays, [50, 50, 399]);
  assert.equal(seen.length, 3);
});

test("jitter is on by default", async () => {
  const { delays, options } = harness();
  await retry.withRetry(flaky(2, unavailable).fn, options);
  assert.deepEqual(delays, [50, 100]);
});

test("a delay is at least what the server asked for, even past maxMs", async () => {
  const slow = harness({ jitter: false, maxMs: 500 });
  await retry.withRetry(flaky(1, () => new HttpError(429, "slow down", { retryAfterMs: 2000 })).fn, slow.options);
  assert.deepEqual(slow.delays, [2000]);
  const quick = harness({ jitter: false });
  await retry.withRetry(flaky(1, () => new HttpError(429, "slow down", { retryAfterMs: 10 })).fn, quick.options);
  assert.deepEqual(quick.delays, [100]);
});

test("it gives up after `retries` retries and throws the last error", async () => {
  const { delays, options } = harness({ retries: 2, jitter: false });
  const { fn, attempts } = flaky(10, (call) => new HttpError(503, `try ${call}`));
  await assert.rejects(retry.withRetry(fn, options), { message: "try 3" });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(delays.length, 2);
});

test("retries defaults to 3, and 0 means one try", async () => {
  const defaults = harness({ jitter: false });
  const many = flaky(10, unavailable);
  await assert.rejects(retry.withRetry(many.fn, defaults.options));
  assert.equal(many.attempts.length, 4);
  const none = harness({ retries: 0 });
  const once = flaky(10, unavailable);
  await assert.rejects(retry.withRetry(once.fn, none.options));
  assert.equal(once.attempts.length, 1);
  assert.deepEqual(none.delays, []);
});

test("an error that is not worth retrying is thrown at once, as it is", async () => {
  const { delays, options } = harness();
  const notFound = new HttpError(404);
  const { fn, attempts } = flaky(10, () => notFound);
  await assert.rejects(retry.withRetry(fn, options), (error) => error === notFound);
  assert.equal(attempts.length, 1);
  assert.deepEqual(delays, []);
});

test("by default a 500, a 429 and a dropped connection are retried", async () => {
  for (const make of [() => new HttpError(500), () => new HttpError(429), () => Object.assign(new Error("reset"), { code: "ECONNRESET" })]) {
    const { options } = harness();
    assert.equal(await retry.withRetry(flaky(1, make).fn, options), "ok on 2");
  }
  assert.equal(isRetryable(new HttpError(500)), true);
});

test("isRetryable can be replaced", async () => {
  const { options } = harness({ isRetryable: (error) => error.message === "again" });
  assert.equal(await retry.withRetry(flaky(2, () => new Error("again")).fn, options), "ok on 3");
  await assert.rejects(retry.withRetry(flaky(1, unavailable).fn, options), { status: 503 });
});

test("onRetry hears of each retry before the wait", async () => {
  const events = [];
  const order = [];
  const { options } = harness({
    jitter: false,
    sleep: async (ms) => void order.push(`sleep ${ms}`),
    onRetry: (info) => {
      events.push(info);
      order.push(`retry ${info.attempt}`);
    },
  });
  await retry.withRetry(flaky(2, (call) => new HttpError(503, `try ${call}`)).fn, options);
  assert.deepEqual(events.map(({ attempt, delayMs, error }) => [attempt, delayMs, error.message]), [[1, 100, "try 1"], [2, 200, "try 2"]]);
  assert.deepEqual(order, ["retry 1", "sleep 100", "retry 2", "sleep 200"]);
});

test("an aborted signal stops it before an attempt", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const { fn, attempts } = flaky(0, unavailable);
  await assert.rejects(retry.withRetry(fn, { ...harness().options, signal: controller.signal }), { message: "stop" });
  assert.deepEqual(attempts, []);

  const during = new AbortController();
  const fnAborting = async () => {
    during.abort(new Error("stop during"));
    throw unavailable();
  };
  await assert.rejects(retry.withRetry(fnAborting, { ...harness().options, signal: during.signal }), { message: "stop during" });
});

test("bad options are a RangeError", async () => {
  for (const bad of [{ retries: -1 }, { retries: 1.5 }, { baseMs: -1 }, { factor: 0.5 }]) {
    await assert.rejects(retry.withRetry(async () => "x", { ...harness().options, ...bad }), RangeError, JSON.stringify(bad));
  }
});

test("without a sleep or random it uses real ones", async () => {
  const { fn } = flaky(1, unavailable);
  assert.equal(await retry.withRetry(fn, { baseMs: 1, maxMs: 1 }), "ok on 2");
});
