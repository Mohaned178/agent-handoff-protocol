/**
 * The settings in an environment: `APP_DB__HOST=x` becomes `{ db: { host: "x" } }`. Only names that start with `prefix` are
 * read; the rest of the name is lowercased and `__` nests. Every value stays the string it was given.
 */
export function parseEnv(env, prefix = "APP_") {
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || value === undefined) continue;
    const path = name.slice(prefix.length).toLowerCase().split("__");
    let node = result;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path.at(-1)] = value;
  }
  return result;
}
