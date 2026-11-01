import assert from "node:assert/strict";
import test from "node:test";
import { toRoman } from "./solution.mjs";

test("converts the basic values", () => {
  assert.equal(toRoman(1), "I");
  assert.equal(toRoman(5), "V");
  assert.equal(toRoman(10), "X");
  assert.equal(toRoman(50), "L");
  assert.equal(toRoman(100), "C");
  assert.equal(toRoman(500), "D");
  assert.equal(toRoman(1000), "M");
});

test("uses subtractive notation", () => {
  assert.equal(toRoman(4), "IV");
  assert.equal(toRoman(9), "IX");
  assert.equal(toRoman(40), "XL");
  assert.equal(toRoman(90), "XC");
  assert.equal(toRoman(400), "CD");
  assert.equal(toRoman(900), "CM");
});

test("converts larger numbers", () => {
  assert.equal(toRoman(1994), "MCMXCIV");
  assert.equal(toRoman(2024), "MMXXIV");
  assert.equal(toRoman(3999), "MMMCMXCIX");
});

test("throws a RangeError outside 1 to 3999 and for non-integers", () => {
  for (const bad of [0, -1, 4000, 2.5]) assert.throws(() => toRoman(bad), RangeError);
});
