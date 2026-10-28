/** Whether `value` is a plain object: something with named properties, such as `{ port: 80 }`. */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null;
}
