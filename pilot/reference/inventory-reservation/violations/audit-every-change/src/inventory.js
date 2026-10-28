/** Stock by SKU, and what is reserved for orders. */
export function createInventory({ audit }) {
  const stock = new Map();
  const reservations = new Map();

  const reservedOf = (sku) => {
    let held = 0;
    for (const reservation of reservations.values()) if (reservation.sku === sku) held += reservation.qty;
    return held;
  };
  const onHand = (sku) => stock.get(sku) ?? 0;
  const available = (sku) => onHand(sku) - reservedOf(sku);
  const positiveInteger = (qty, what) => {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError(`${what} must be a positive integer: ${String(qty)}`);
  };

  return {
    receive(sku, qty) {
      positiveInteger(qty, "qty");
      stock.set(sku, onHand(sku) + qty);
      audit.record({ type: "receive", sku, qty });
    },
    reserve(orderId, sku, qty) {
      positiveInteger(qty, "qty");
      if (reservations.has(orderId)) return { ok: false, reason: "already_reserved" };
      if (available(sku) < qty) return { ok: false, reason: "insufficient_stock" };
      reservations.set(orderId, { sku, qty });
      audit.record({ type: "reserve", orderId, sku, qty });
      return { ok: true };
    },
    release(orderId) {
      const reservation = reservations.get(orderId);
      if (!reservation) return { ok: false, reason: "not_reserved" };
      reservations.delete(orderId);
      audit.record({ type: "release", orderId, sku: reservation.sku, qty: reservation.qty });
      return { ok: true, sku: reservation.sku, qty: reservation.qty };
    },
    ship(orderId) {
      const reservation = reservations.get(orderId);
      if (!reservation) return { ok: false, reason: "not_reserved" };
      reservations.delete(orderId);
      stock.set(reservation.sku, onHand(reservation.sku) - reservation.qty);
      return { ok: true, sku: reservation.sku, qty: reservation.qty };
    },
    onHand,
    available,
  };
}
