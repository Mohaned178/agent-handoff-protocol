/** The shop's sales, one entry per sale. `unitPriceCents` is an integer number of cents. */
export const SALES = [
  { date: "2026-01-05", region: "APAC", units: 2, unitPriceCents: 1999 },
  { date: "2026-01-14", region: "EMEA", units: 3, unitPriceCents: 1999 },
  { date: "2026-01-20", region: "EMEA", units: 1, unitPriceCents: 4950 },
  { date: "2026-02-02", region: "AMER", units: 10, unitPriceCents: 250 },
  { date: "2026-02-11", region: "EMEA", units: 4, unitPriceCents: 1999 },
  { date: "2026-03-09", region: "AMER", units: 1, unitPriceCents: 100000 },
];

/**
 * The sales added up per month and region, as `{ month, region, units, revenueCents }` rows ordered by month, then region.
 */
export function reportRows(sales = SALES) {
  const groups = new Map();
  for (const sale of sales) {
    const month = sale.date.slice(0, 7);
    const key = `${month}|${sale.region}`;
    const row = groups.get(key) ?? { month, region: sale.region, units: 0, revenueCents: 0 };
    row.units += sale.units;
    row.revenueCents += sale.units * sale.unitPriceCents;
    row.revenue = `${Math.floor(row.revenueCents / 100)}.${String(row.revenueCents % 100).padStart(2, "0")}`;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
}
