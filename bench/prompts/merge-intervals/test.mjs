import assert from "node:assert/strict";
import test from "node:test";
import { mergeIntervals } from "./solution.mjs";

test("merges overlapping intervals", () => {
  assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);
});

test("merges intervals that only touch", () => {
  assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);
});

test("sorts unordered input and handles nesting", () => {
  assert.deepEqual(mergeIntervals([[8, 10], [1, 10], [2, 3]]), [[1, 10]]);
  assert.deepEqual(mergeIntervals([[5, 6], [1, 2]]), [[1, 2], [5, 6]]);
});

test("empty and single-interval inputs", () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(mergeIntervals([[4, 4]]), [[4, 4]]);
});

test("does not change its input", () => {
  const input = [[5, 6], [1, 2], [2, 3]];
  mergeIntervals(input);
  assert.deepEqual(input, [[5, 6], [1, 2], [2, 3]]);
});
