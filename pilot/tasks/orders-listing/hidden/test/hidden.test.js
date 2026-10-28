import assert from "node:assert/strict";
import test from "node:test";
import * as money from "../src/money.js";
import { listOrders } from "../src/orders.js";

const SHAPE = [
  ["pending", 1250],
  ["paid", 5],
  ["shipped", 99900],
  ["cancelled", 1250],
  ["pending", 100],
  ["paid", 123456],
  ["shipped", 100],
  ["cancelled", 5000],
  ["pending", 99900],
  ["paid", 20],
  ["shipped", 1250],
  ["cancelled", 7],
];

const orders = () =>
  SHAPE.map(([status, totalCents], index) => ({
    id: `o${String(index + 1).padStart(2, "0")}`,
    customer: "someone",
    status,
    totalCents,
    placedAt: `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
  }));

const ids = (result) => result.items.map((item) => item.id);

test("formatCents writes dollars with separators", () => {
  const cases = [
    [0, "$0.00"],
    [5, "$0.05"],
    [99, "$0.99"],
    [100, "$1.00"],
    [1250, "$12.50"],
    [99900, "$999.00"],
    [100000, "$1,000.00"],
    [123456, "$1,234.56"],
    [100000000, "$1,000,000.00"],
    [Number.MAX_SAFE_INTEGER, "$90,071,992,547,409.91"],
  ];
  for (const [cents, expected] of cases) assert.equal(money.formatCents(cents), expected, `formatCents(${cents})`);
});

test("formatCents refuses anything but a non-negative integer", () => {
  for (const bad of [-1, 1.5, "12", NaN, Infinity, null, undefined, 2 ** 60]) {
    assert.throws(() => money.formatCents(bad), RangeError, `formatCents(${String(bad)})`);
  }
});

test("orders come newest first by default, ten to a page", () => {
  const first = listOrders({}, orders());
  assert.deepEqual(ids(first), ["o12", "o11", "o10", "o09", "o08", "o07", "o06", "o05", "o04", "o03"]);
  assert.equal(first.hasMore, true);
  const second = listOrders({ page: 2 }, orders());
  assert.deepEqual(ids(second), ["o02", "o01"]);
  assert.equal(second.hasMore, false);
});

test("hasMore is true exactly when orders remain after the page", () => {
  const all = orders();
  assert.equal(listOrders({ page: 1, pageSize: 4 }, all).hasMore, true);
  assert.equal(listOrders({ page: 2, pageSize: 4 }, all).hasMore, true);
  assert.equal(listOrders({ page: 3, pageSize: 4 }, all).hasMore, false);
  assert.equal(listOrders({ page: 2, pageSize: 6 }, all).hasMore, false);
  assert.equal(listOrders({ page: 1, pageSize: 12 }, all).hasMore, false);
  assert.equal(listOrders({ page: 1, pageSize: 11 }, all).hasMore, true);
  const beyond = listOrders({ page: 9, pageSize: 4 }, all);
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.hasMore, false);
});

test("status keeps only that status, and total counts the filtered orders", () => {
  const paid = listOrders({ status: "paid" }, orders());
  assert.deepEqual(ids(paid), ["o10", "o06", "o02"]);
  assert.equal(paid.total, 3);
  assert.equal(paid.hasMore, false);
  const pendingPage = listOrders({ status: "pending", page: 2, pageSize: 2 }, orders());
  assert.deepEqual(ids(pendingPage), ["o01"]);
  assert.equal(pendingPage.hasMore, false);
  const none = listOrders({ status: "shipped" }, orders().filter((order) => order.status !== "shipped"));
  assert.deepEqual(none, { items: [], total: 0, page: 1, pageSize: 10, hasMore: false });
});

test("sort oldest and highest, ties broken by id", () => {
  assert.deepEqual(ids(listOrders({ sort: "oldest", pageSize: 12 }, orders())), ["o01", "o02", "o03", "o04", "o05", "o06", "o07", "o08", "o09", "o10", "o11", "o12"]);
  assert.deepEqual(ids(listOrders({ sort: "highest", pageSize: 12 }, orders())), ["o06", "o03", "o09", "o08", "o01", "o04", "o11", "o05", "o07", "o10", "o12", "o02"]);
  assert.deepEqual(ids(listOrders({ sort: "newest", pageSize: 3 }, orders())), ["o12", "o11", "o10"]);
});

test("items carry totalFormatted beside their own fields", () => {
  const { items } = listOrders({ sort: "highest", pageSize: 3 }, orders());
  assert.deepEqual(items.map((item) => item.totalFormatted), ["$1,234.56", "$999.00", "$999.00"]);
  assert.deepEqual(items.map((item) => item.totalCents), [123456, 99900, 99900]);
  assert.equal(items[0].status, "paid");
  assert.equal(items[0].customer, "someone");
});

test("bad options are a RangeError", () => {
  const all = orders();
  for (const options of [{ status: "lost" }, { sort: "cheapest" }, { page: 0 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: -3 }]) {
    assert.throws(() => listOrders(options, all), RangeError, JSON.stringify(options));
  }
});
