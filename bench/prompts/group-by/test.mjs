import assert from "node:assert/strict";
import test from "node:test";
import { groupBy } from "./solution.mjs";

test("groups by the key function and keeps order", () => {
  assert.deepEqual(groupBy([1, 2, 3, 4, 5, 6], (n) => (n % 2 === 0 ? "even" : "odd")), { odd: [1, 3, 5], even: [2, 4, 6] });
});

test("groups objects by a property", () => {
  const people = [{ name: "Ada", team: "a" }, { name: "Bo", team: "b" }, { name: "Cy", team: "a" }];
  assert.deepEqual(groupBy(people, (p) => p.team), { a: [people[0], people[2]], b: [people[1]] });
});

test("an empty input gives an empty object", () => {
  assert.deepEqual(groupBy([], (x) => x), {});
});

test("passes each item to the key function once", () => {
  const seen = [];
  groupBy(["a", "b", "c"], (item) => {
    seen.push(item);
    return "k";
  });
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("a key such as constructor is an ordinary key", () => {
  const grouped = groupBy(["x"], () => "constructor");
  assert.deepEqual(Object.keys(grouped), ["constructor"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(grouped, "constructor").value, ["x"]);
});
