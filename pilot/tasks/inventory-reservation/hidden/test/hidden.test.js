import assert from "node:assert/strict";
import test from "node:test";
import { createAudit } from "../src/audit.js";
import { createInventory } from "../src/inventory.js";

function stocked() {
  const inventory = createInventory({ audit: createAudit() });
  inventory.receive("A", 10);
  inventory.receive("B", 2);
  return inventory;
}

test("a reservation lowers what is available, not what is on hand", () => {
  const inventory = stocked();
  assert.deepEqual(inventory.reserve("o1", "A", 4), { ok: true });
  assert.equal(inventory.available("A"), 6);
  assert.equal(inventory.onHand("A"), 10);
  assert.equal(inventory.available("B"), 2);
});

test("stock can be reserved up to what is available, and no further", () => {
  const inventory = stocked();
  assert.deepEqual(inventory.reserve("o1", "A", 6), { ok: true });
  assert.deepEqual(inventory.reserve("o2", "A", 4), { ok: true });
  assert.equal(inventory.available("A"), 0);
  assert.deepEqual(inventory.reserve("o3", "A", 1), { ok: false, reason: "insufficient_stock" });
  assert.equal(inventory.available("A"), 0);
});

test("an unknown sku has nothing to reserve", () => {
  assert.deepEqual(stocked().reserve("o1", "Z", 1), { ok: false, reason: "insufficient_stock" });
});

test("an order holds one reservation at a time", () => {
  const inventory = stocked();
  inventory.reserve("o1", "A", 1);
  assert.deepEqual(inventory.reserve("o1", "A", 1), { ok: false, reason: "already_reserved" });
  assert.deepEqual(inventory.reserve("o1", "B", 1), { ok: false, reason: "already_reserved" });
  assert.equal(inventory.available("A"), 9);
  assert.equal(inventory.available("B"), 2);
});

test("already_reserved is checked before insufficient_stock", () => {
  const inventory = stocked();
  inventory.reserve("o1", "A", 1);
  assert.deepEqual(inventory.reserve("o1", "A", 500), { ok: false, reason: "already_reserved" });
});

test("a rejected reservation changes nothing", () => {
  const inventory = stocked();
  inventory.reserve("o1", "B", 2);
  inventory.reserve("o2", "B", 1);
  assert.equal(inventory.available("B"), 0);
  assert.equal(inventory.release("o2").ok, false);
});

test("a quantity that is not a positive integer is a RangeError", () => {
  const inventory = stocked();
  for (const qty of [0, -1, 1.5, NaN, "2"]) assert.throws(() => inventory.reserve("o1", "A", qty), RangeError, `reserve qty ${String(qty)}`);
  assert.equal(inventory.available("A"), 10);
});

test("release makes the stock available again, once", () => {
  const inventory = stocked();
  inventory.reserve("o1", "A", 4);
  assert.deepEqual(inventory.release("o1"), { ok: true, sku: "A", qty: 4 });
  assert.equal(inventory.available("A"), 10);
  assert.equal(inventory.onHand("A"), 10);
  assert.deepEqual(inventory.release("o1"), { ok: false, reason: "not_reserved" });
  assert.deepEqual(inventory.release("never"), { ok: false, reason: "not_reserved" });
});

test("ship takes the reserved stock out of the warehouse, once", () => {
  const inventory = stocked();
  inventory.reserve("o1", "A", 4);
  assert.deepEqual(inventory.ship("o1"), { ok: true, sku: "A", qty: 4 });
  assert.equal(inventory.onHand("A"), 6);
  assert.equal(inventory.available("A"), 6);
  assert.deepEqual(inventory.ship("o1"), { ok: false, reason: "not_reserved" });
  assert.deepEqual(inventory.release("o1"), { ok: false, reason: "not_reserved" });
  assert.equal(inventory.onHand("A"), 6);
  assert.deepEqual(inventory.ship("never"), { ok: false, reason: "not_reserved" });
});

test("an order can reserve again once it has released or shipped", () => {
  const inventory = stocked();
  inventory.reserve("o1", "A", 1);
  inventory.release("o1");
  assert.deepEqual(inventory.reserve("o1", "B", 2), { ok: true });
  inventory.ship("o1");
  assert.deepEqual(inventory.reserve("o1", "A", 3), { ok: true });
  assert.equal(inventory.available("A"), 7);
  assert.equal(inventory.available("B"), 0);
  assert.equal(inventory.onHand("B"), 0);
});

test("receiving nothing, or taking stock away, is a RangeError and leaves the stock alone", () => {
  const inventory = stocked();
  for (const qty of [0, -5, -100, 1.5, NaN]) assert.throws(() => inventory.receive("A", qty), RangeError, `receive qty ${String(qty)}`);
  assert.equal(inventory.onHand("A"), 10);
  assert.equal(inventory.available("A"), 10);
});

test("received stock after a reservation is available on top of it", () => {
  const inventory = stocked();
  inventory.reserve("o1", "A", 10);
  inventory.receive("A", 3);
  assert.equal(inventory.available("A"), 3);
  assert.equal(inventory.onHand("A"), 13);
});
