import assert from "node:assert/strict";
import { reportRows } from "../src/sales.js";

assert.deepEqual(reportRows(), [
  { month: "2026-01", region: "APAC", units: 2, revenueCents: 3998 },
  { month: "2026-01", region: "EMEA", units: 4, revenueCents: 10947 },
  { month: "2026-02", region: "AMER", units: 10, revenueCents: 2500 },
  { month: "2026-02", region: "EMEA", units: 4, revenueCents: 7996 },
  { month: "2026-03", region: "AMER", units: 1, revenueCents: 100000 },
]);
console.log("the report rows are unchanged");
