export function flatten(array, depth = Infinity) {
  const out = [];
  for (const item of array) {
    if (Array.isArray(item) && depth > 0) out.push(...flatten(item, depth - 1));
    else out.push(item);
  }
  return out;
}
