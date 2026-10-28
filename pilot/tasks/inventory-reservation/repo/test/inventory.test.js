import assert from "node:assert/strict";
import test from "node:test";
import { createAudit } from "../src/audit.js";
import { createInventory } from "../src/inventory.js";

test("received stock is on hand and available", () => {
  const inventory = createInventory({ audit: createAudit() });
  inventory.receive("A", 10);
  inventory.receive("A", 5);
  assert.equal(inventory.onHand("A"), 15);
  assert.equal(inventory.available("A"), 15);
  assert.equal(inventory.onHand("B"), 0);
});

test("receiving is recorded in the audit log", () => {
  const audit = createAudit();
  createInventory({ audit }).receive("A", 3);
  assert.deepEqual(audit.entries().map(({ seq, ...entry }) => entry), [{ type: "receive", sku: "A", qty: 3 }]);
});
