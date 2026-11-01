export function groupBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    if (!Object.hasOwn(out, key)) Object.defineProperty(out, key, { value: [], enumerable: true, writable: true, configurable: true });
    out[key].push(item);
  }
  return out;
}
