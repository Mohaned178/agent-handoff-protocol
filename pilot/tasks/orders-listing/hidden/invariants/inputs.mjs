import assert from "node:assert/strict";
import { ORDERS } from "../src/data.js";
import { listOrders } from "../src/orders.js";

// Every order and the list holding them are frozen: code that writes to either throws (this is an ES module, so strict).
const frozen = ORDERS.map((order) => Object.freeze({ ...order }));
Object.freeze(frozen);

const before = JSON.stringify(frozen);
for (const options of [{}, { status: "paid" }, { sort: "oldest" }, { sort: "highest", pageSize: 5 }, { status: "pending", page: 2, pageSize: 1 }]) {
  listOrders(options, frozen);
}
assert.equal(JSON.stringify(frozen), before);
console.log("the orders given were not modified");
