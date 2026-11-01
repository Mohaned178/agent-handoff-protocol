import assert from "node:assert/strict";
import test from "node:test";
import { LRUCache } from "./solution.mjs";

test("stores and returns values, and undefined for a missing key", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("missing"), undefined);
});

test("evicts the least recently used key when over capacity", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
});

test("a get makes a key recently used", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.get("a");
  cache.put("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
});

test("putting an existing key updates it and makes it recently used", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("a", 10);
  cache.put("c", 3);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.get("b"), undefined);
});

test("a capacity of 1 keeps only the last key", () => {
  const cache = new LRUCache(1);
  cache.put("a", 1);
  cache.put("b", 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
});
