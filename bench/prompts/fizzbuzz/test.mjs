import assert from "node:assert/strict";
import test from "node:test";
import { fizzbuzz } from "./solution.mjs";

test("counts up with Fizz, Buzz and FizzBuzz", () => {
  assert.deepEqual(fizzbuzz(15), ["1", "2", "Fizz", "4", "Buzz", "Fizz", "7", "8", "Fizz", "Buzz", "11", "Fizz", "13", "14", "FizzBuzz"]);
});

test("returns an empty array for 0", () => {
  assert.deepEqual(fizzbuzz(0), []);
});

test("returns strings only", () => {
  assert.ok(fizzbuzz(5).every((item) => typeof item === "string"));
});
