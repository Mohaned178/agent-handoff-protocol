import assert from "node:assert/strict";
import test from "node:test";
import * as csv from "../src/csv.js";
import { SALES } from "../src/sales.js";

const AB = [
  { header: "a", key: "a" },
  { header: "b", key: "b" },
];

test("a header line, then one line per row, each ending in CRLF", () => {
  assert.equal(csv.toCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }], AB), "a,b\r\n1,x\r\n2,y\r\n");
});

test("no rows is just the header line", () => {
  assert.equal(csv.toCsv([], AB), "a,b\r\n");
});

test("a cell with a comma, a quote, CR or LF is quoted, and its quotes doubled", () => {
  const rows = [{ a: "x,y", b: 'he said "hi"' }, { a: "two\nlines", b: "cr\rhere" }, { a: "plain", b: "" }];
  assert.equal(csv.toCsv(rows, AB), 'a,b\r\n"x,y","he said ""hi"""\r\n"two\nlines","cr\rhere"\r\nplain,\r\n');
});

test("headers are quoted by the same rule", () => {
  assert.equal(csv.toCsv([{ a: 1 }], [{ header: "Total, USD", key: "a" }]), '"Total, USD"\r\n1\r\n');
});

test("null, undefined, numbers, booleans and dates", () => {
  const rows = [{ a: null, b: undefined }, { a: 0, b: -2.5 }, { a: true, b: false }, { a: new Date(Date.UTC(2026, 2, 9, 1, 2, 3)), b: "ok" }];
  assert.equal(csv.toCsv(rows, AB), "a,b\r\n,\r\n0,-2.5\r\ntrue,false\r\n2026-03-09T01:02:03.000Z,ok\r\n");
});

test("a column key the row lacks is an empty cell", () => {
  assert.equal(csv.toCsv([{ a: 1 }], AB), "a,b\r\n1,\r\n");
});

test("a column's value function takes the row's place of the key", () => {
  const columns = [{ header: "double", key: "a", value: (row) => row.a * 2 }, { header: "b", key: "b" }];
  assert.equal(csv.toCsv([{ a: 4, b: "z" }], columns), "double,b\r\n8,z\r\n");
});

test("a string that starts like a formula gets a leading quote, a number does not", () => {
  const rows = [{ a: "=SUM(A1:A2)", b: "+1" }, { a: "-x", b: "@home" }, { a: -5, b: "fine=ok" }, { a: "=a,b", b: "" }];
  assert.equal(csv.toCsv(rows, AB), "a,b\r\n'=SUM(A1:A2),'+1\r\n'-x,'@home\r\n-5,fine=ok\r\n\"'=a,b\",\r\n");
});

test("a header is never given the formula guard", () => {
  assert.equal(csv.toCsv([{ a: 1 }], [{ header: "=total", key: "a" }]), "=total\r\n1\r\n");
});

const EXPECTED = [
  "Month,Region,Units,Revenue (USD)",
  "2026-01,APAC,2,39.98",
  "2026-01,EMEA,4,109.47",
  "2026-02,AMER,10,25.00",
  "2026-02,EMEA,4,79.96",
  "2026-03,AMER,1,1000.00",
  "",
].join("\r\n");

test("the sales report as CSV", () => {
  assert.equal(csv.salesReportCsv(), EXPECTED);
  assert.equal(csv.salesReportCsv(SALES), EXPECTED);
});

test("the sales report comes out by month then region whatever order the sales come in", () => {
  assert.equal(csv.salesReportCsv([...SALES].reverse()), EXPECTED);
  const shuffled = [SALES[4], SALES[0], SALES[5], SALES[2], SALES[3], SALES[1]];
  assert.equal(csv.salesReportCsv(shuffled), EXPECTED);
});

test("revenue in dollars has two decimals and no separators", () => {
  const sales = [{ date: "2026-04-01", region: "X", units: 1, unitPriceCents: 7 }, { date: "2026-04-02", region: "Y", units: 1, unitPriceCents: 123456789 }];
  assert.equal(csv.salesReportCsv(sales), "Month,Region,Units,Revenue (USD)\r\n2026-04,X,1,0.07\r\n2026-04,Y,1,1234567.89\r\n");
});
