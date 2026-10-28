import { parseEnv } from "./env.js";
import { isPlainObject } from "./types.js";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof Date) return new Date(value.getTime());
  if (isPlainObject(value)) return merge({}, value);
  return value;
}

/** Merges `layer` into `target`, which is new and not shared with anything. */
function merge(target, layer) {
  for (const key of Object.keys(layer)) {
    if (UNSAFE_KEYS.has(key) || layer[key] === undefined) continue;
    const value = layer[key];
    target[key] = isPlainObject(value) ? merge(isPlainObject(target[key]) ? target[key] : {}, value) : copy(value);
  }
  return target;
}

function coerce(value) {
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
  }
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, coerce(inner)]));
  return value;
}

/** The configuration: `defaults`, then `file`, then `env` (parsed and coerced) on top. */
export function resolveConfig({ defaults, file, env } = {}) {
  const result = {};
  for (const layer of [defaults, file, env === undefined ? undefined : coerce(parseEnv(env))]) {
    if (isPlainObject(layer)) merge(result, layer);
  }
  return result;
}
