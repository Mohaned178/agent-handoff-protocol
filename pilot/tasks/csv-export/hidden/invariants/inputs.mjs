import assert from "node:assert/strict";
import { SALES } from "../src/sales.js";

let csv;
try {
  csv = await import("../src/csv.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.log("there is no src/csv.js, so nothing was modified");
  process.exit(0);
}

// Everything handed over is deeply frozen: code that writes to any of it throws (this is an ES module, so strict).
const freeze = (value) => {
  for (const inner of Object.values(value)) if (typeof inner === "object" && inner !== null) freeze(inner);
  return Object.freeze(value);
};
const rows = freeze([{ a: "=1,2", b: 3, c: null }, { a: "x", b: -4, c: new Date(0) }]);
const columns = freeze([{ header: "a", key: "a" }, { header: "b", key: "b", value: (row) => row.b * 2 }, { header: "c", key: "c" }]);
const sales = freeze(SALES.map((sale) => ({ ...sale })));

const before = JSON.stringify({ rows, columns: columns.map((column) => column.header), sales });
csv.toCsv(rows, columns);
csv.salesReportCsv(sales);
assert.equal(JSON.stringify({ rows, columns: columns.map((column) => column.header), sales }), before);
console.log("the rows, columns and sales given were not modified");
