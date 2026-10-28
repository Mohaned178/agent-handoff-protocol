/** Stock by SKU. */
export function createInventory({ audit }) {
  const stock = new Map();
  return {
    /** Adds `qty` units of `sku` to the warehouse. */
    receive(sku, qty) {
      if (!Number.isInteger(qty)) throw new RangeError(`qty must be an integer: ${String(qty)}`);
      stock.set(sku, (stock.get(sku) ?? 0) + qty);
      audit.record({ type: "receive", sku, qty });
    },
    /** Units of `sku` in the warehouse. */
    onHand(sku) {
      return stock.get(sku) ?? 0;
    },
    /** Units of `sku` that can still be promised. */
    available(sku) {
      return stock.get(sku) ?? 0;
    },
  };
}
