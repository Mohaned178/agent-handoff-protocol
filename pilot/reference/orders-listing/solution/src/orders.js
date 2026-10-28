import { ORDERS } from "./data.js";
import { formatCents } from "./money.js";
import { paginate } from "./paginate.js";

const STATUSES = ["pending", "paid", "shipped", "cancelled"];

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const ORDERINGS = {
  newest: (a, b) => b.placedAt.localeCompare(a.placedAt) || byId(a, b),
  oldest: (a, b) => a.placedAt.localeCompare(b.placedAt) || byId(a, b),
  highest: (a, b) => b.totalCents - a.totalCents || byId(a, b),
};

/** A page of orders, filtered by status and sorted, each with its total formatted. */
export function listOrders({ status, sort = "newest", page = 1, pageSize = 10 } = {}, orders = ORDERS) {
  if (status !== undefined && !STATUSES.includes(status)) throw new RangeError(`unknown status: ${String(status)}`);
  if (!Object.hasOwn(ORDERINGS, sort)) throw new RangeError(`unknown sort: ${String(sort)}`);
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`page must be a positive integer: ${String(page)}`);
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize must be a positive integer: ${String(pageSize)}`);
  const kept = orders.filter((order) => status === undefined || order.status === status).sort(ORDERINGS[sort]);
  const result = paginate(kept, page, pageSize);
  return { ...result, items: result.items.map((order) => ({ ...order, totalFormatted: formatCents(order.totalCents) })) };
}
