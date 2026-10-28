import assert from "node:assert/strict";
import test from "node:test";
import { ORDERS } from "../src/data.js";
import { listOrders } from "../src/orders.js";

test("the first page holds the newest orders", () => {
  const result = listOrders({ page: 1, pageSize: 5 });
  assert.deepEqual(result.items.map((order) => order.id), ["o12", "o11", "o10", "o09", "o08"]);
  assert.equal(result.total, ORDERS.length);
  assert.equal(result.hasMore, true);
});

test("the last page holds what is left", () => {
  const result = listOrders({ page: 3, pageSize: 5 });
  assert.deepEqual(result.items.map((order) => order.id), ["o02", "o01"]);
  assert.equal(result.hasMore, false);
});
