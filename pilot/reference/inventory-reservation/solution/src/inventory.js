/** Stock by SKU, and what is reserved for orders. Every change is recorded with `audit.record`. */
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
    /** Adds `qty` units of `sku` to the warehouse. */
    receive(sku, qty) {
      positiveInteger(qty, "qty");
      stock.set(sku, onHand(sku) + qty);
      audit.record({ type: "receive", sku, qty });
    },
    /** Holds `qty` units of `sku` for `orderId`. */
    reserve(orderId, sku, qty) {
      positiveInteger(qty, "qty");
      let reason = null;
      if (reservations.has(orderId)) reason = "already_reserved";
      else if (available(sku) < qty) reason = "insufficient_stock";
      if (reason !== null) {
        audit.record({ type: "reserve_rejected", orderId, sku, qty, reason });
        return { ok: false, reason };
      }
      reservations.set(orderId, { sku, qty });
      audit.record({ type: "reserve", orderId, sku, qty });
      return { ok: true };
    },
    /** Gives `orderId`'s reservation back. */
    release(orderId) {
      const reservation = reservations.get(orderId);
      if (!reservation) return { ok: false, reason: "not_reserved" };
      reservations.delete(orderId);
      audit.record({ type: "release", orderId, sku: reservation.sku, qty: reservation.qty });
      return { ok: true, sku: reservation.sku, qty: reservation.qty };
    },
    /** Takes `orderId`'s reserved stock out of the warehouse. */
    ship(orderId) {
      const reservation = reservations.get(orderId);
      if (!reservation) return { ok: false, reason: "not_reserved" };
      reservations.delete(orderId);
      stock.set(reservation.sku, onHand(reservation.sku) - reservation.qty);
      audit.record({ type: "ship", orderId, sku: reservation.sku, qty: reservation.qty });
      return { ok: true, sku: reservation.sku, qty: reservation.qty };
    },
    /** Units of `sku` in the warehouse. */
    onHand,
    /** Units of `sku` that can still be promised. */
    available,
  };
}
