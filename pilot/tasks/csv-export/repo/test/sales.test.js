import assert from "node:assert/strict";
import test from "node:test";
import { reportRows, SALES } from "../src/sales.js";

test("sales are added up per month and region", () => {
  const rows = reportRows(SALES);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].units, 4);
  assert.equal(rows[1].revenueCents, 10947);
});

test("sales on different days of one month share a row", () => {
  const rows = reportRows([
    { date: "2026-05-01", region: "EMEA", units: 1, unitPriceCents: 100 },
    { date: "2026-05-30", region: "EMEA", units: 2, unitPriceCents: 100 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].units, 3);
  assert.equal(rows[0].revenueCents, 300);
});
