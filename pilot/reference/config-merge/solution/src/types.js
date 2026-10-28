/** Whether `value` is a plain object: something with named properties, such as `{ port: 80 }`. */
export function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
