import assert from "node:assert/strict";
import test from "node:test";
import { isPalindrome } from "./solution.mjs";

test("accepts plain palindromes", () => {
  assert.equal(isPalindrome("racecar"), true);
  assert.equal(isPalindrome("Level"), true);
});

test("ignores punctuation, spaces and case", () => {
  assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true);
  assert.equal(isPalindrome("No 'x' in Nixon"), true);
});

test("rejects what is not one", () => {
  assert.equal(isPalindrome("hello"), false);
  assert.equal(isPalindrome("ab"), false);
});

test("the empty string and punctuation alone are palindromes", () => {
  assert.equal(isPalindrome(""), true);
  assert.equal(isPalindrome(".,!"), true);
});
