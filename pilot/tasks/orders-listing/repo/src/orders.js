import { ORDERS } from "./data.js";
import { paginate } from "./paginate.js";

/** A page of orders, newest first. */
export function listOrders({ page = 1, pageSize = 10 } = {}, orders = ORDERS) {
  const newestFirst = [...orders].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  return paginate(newestFirst, page, pageSize);
}
