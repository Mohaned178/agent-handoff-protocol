const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The settings in an environment: `APP_DB__HOST=x` becomes `{ db: { host: "x" } }`. Only names that start with `prefix` are
 * read; the rest of the name is lowercased and `__` nests. Every value stays the string it was given.
 */
export function parseEnv(env, prefix = "APP_") {
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || value === undefined) continue;
    const path = name.slice(prefix.length).toLowerCase().split("__");
    if (path.some((key) => UNSAFE_KEYS.has(key))) continue;
    let node = result;
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(node, key) || typeof node[key] !== "object") node[key] = {};
      node = node[key];
    }
    node[path.at(-1)] = value;
  }
  return result;
}
