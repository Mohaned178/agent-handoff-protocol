import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration } from "./solution.mjs";

test("parses single units", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2m"), 120);
  assert.equal(parseDuration("3h"), 10800);
  assert.equal(parseDuration("1d"), 86400);
});

test("parses several units, with or without spaces", () => {
  assert.equal(parseDuration("1h 30m"), 5400);
  assert.equal(parseDuration("1d2h3m4s"), 86400 + 7200 + 180 + 4);
  assert.equal(parseDuration("1m 1s"), 61);
});

test("throws for an empty string and for text with no unit", () => {
  assert.throws(() => parseDuration(""), Error);
  assert.throws(() => parseDuration("12"), Error);
});

test("throws for an unknown unit, a repeated unit and units out of order", () => {
  assert.throws(() => parseDuration("5w"), Error);
  assert.throws(() => parseDuration("1m 2m"), Error);
  assert.throws(() => parseDuration("30s 1h"), Error);
});

test("throws for a negative number", () => {
  assert.throws(() => parseDuration("-5s"), Error);
});
