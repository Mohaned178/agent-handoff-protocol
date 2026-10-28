/** `cents` (a non-negative safe integer) as dollars: `$1,234.56`. */
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`not a number of cents: ${String(cents)}`);
  const dollars = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}
