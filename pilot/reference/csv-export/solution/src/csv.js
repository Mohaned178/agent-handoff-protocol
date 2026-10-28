import { reportRows, SALES } from "./sales.js";

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@]/;

function cellText(value, isHeader) {
  if (value === null || value === undefined) return "";
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "string") text = !isHeader && FORMULA_START.test(value) ? `'${value}` : value;
  else text = String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** `rows` as CSV text, one cell per column; see the column's `value` and `key`. */
export function toCsv(rows, columns) {
  const lines = [columns.map((column) => cellText(column.header, true))];
  for (const row of rows) {
    lines.push(columns.map((column) => cellText(typeof column.value === "function" ? column.value(row) : row[column.key], false)));
  }
  return lines.map((cells) => `${cells.join(",")}\r\n`).join("");
}

const dollars = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** The sales report as CSV. */
export function salesReportCsv(sales = SALES) {
  return toCsv(reportRows(sales), [
    { header: "Month", key: "month" },
    { header: "Region", key: "region" },
    { header: "Units", key: "units" },
    { header: "Revenue (USD)", key: "revenueCents", value: (row) => dollars(row.revenueCents) },
  ]);
}
