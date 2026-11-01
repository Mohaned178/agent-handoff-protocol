import assert from "node:assert/strict";
import test from "node:test";
import { flatten } from "./solution.mjs";

test("flattens every level by default", () => {
  assert.deepEqual(flatten([1, [2, [3, [4]]], 5]), [1, 2, 3, 4, 5]);
});

test("flattens only as deep as asked", () => {
  assert.deepEqual(flatten([1, [2, [3, [4]]]], 1), [1, 2, [3, [4]]]);
  assert.deepEqual(flatten([1, [2, [3, [4]]]], 2), [1, 2, 3, [4]]);
  assert.deepEqual(flatten([1, [2]], 0), [1, [2]]);
});

test("drops empty arrays and keeps other values", () => {
  assert.deepEqual(flatten([[], [1], [[]], "a", null]), [1, "a", null]);
});

test("does not change its input and returns a new array", () => {
  const input = [1, [2, [3]]];
  const output = flatten(input, 0);
  assert.notEqual(output, input);
  assert.deepEqual(input, [1, [2, [3]]]);
});
