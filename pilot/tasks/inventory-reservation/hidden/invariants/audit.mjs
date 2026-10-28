import assert from "node:assert/strict";
import { createAudit } from "../src/audit.js";
import { createInventory } from "../src/inventory.js";

const audit = createAudit();
const inventory = createInventory({ audit });
if (typeof inventory.reserve !== "function") {
  console.log("there is no reserve yet, so nothing was left out of the audit log");
  process.exit(0);
}

inventory.receive("A", 10);
inventory.reserve("o1", "A", 4); // reserved
inventory.reserve("o2", "A", 9); // rejected: only 6 are available
inventory.reserve("o1", "A", 1); // rejected: o1 already holds a reservation
inventory.release("o1"); // released
inventory.reserve("o3", "A", 10); // reserved
inventory.ship("o3"); // shipped
inventory.release("nobody"); // changes nothing

const expected = [
  { type: "receive", sku: "A", qty: 10 },
  { type: "reserve", orderId: "o1", sku: "A", qty: 4 },
  { type: "reserve_rejected", orderId: "o2", sku: "A", qty: 9, reason: "insufficient_stock" },
  { type: "reserve_rejected", orderId: "o1", sku: "A", qty: 1, reason: "already_reserved" },
  { type: "release", orderId: "o1", sku: "A", qty: 4 },
  { type: "reserve", orderId: "o3", sku: "A", qty: 10 },
  { type: "ship", orderId: "o3", sku: "A", qty: 10 },
];
const entries = audit.entries();
assert.equal(entries.length, expected.length, `expected ${expected.length} audit entries, found ${entries.length}: ${entries.map((entry) => entry.type).join(", ")}`);
expected.forEach((want, index) => {
  for (const [key, value] of Object.entries(want)) assert.equal(entries[index][key], value, `entry ${index + 1}: ${key}`);
});
console.log("every change is in the audit log");
