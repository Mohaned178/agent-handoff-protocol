import { createHash } from "node:crypto";
import { canonicalJson } from "../ledger/chain.ts";
import type { PathChange } from "../protocol/index.ts";
import type { FrozenFile } from "./events.ts";

/** Orders paths by UTF-16 code unit, as `Array.prototype.sort` does, so an order never depends on the locale. */
export const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const sha256Of = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Every file as a path and the SHA-256 of its bytes, sorted by path (by UTF-16 code unit, as `Array.prototype.sort` does). */
export function fileListOf(files: ReadonlyMap<string, Uint8Array>): FrozenFile[] {
  return [...files]
    .map(([path, bytes]) => ({ path, sha256: sha256Of(bytes) }))
    .sort((a, b) => byPath(a.path, b.path));
}

/**
 * The freeze hash of a set of files: the SHA-256 (lowercase hex) of the canonical JSON of the list of
 * `[relative path, content hash]` pairs, sorted by path. So the same files hash the same wherever they are, and a file
 * added, removed, renamed or changed by one byte changes it. Empty directories are not files and do not count.
 */
export const hashOfFiles = (list: readonly FrozenFile[]) => sha256Of(canonicalJson(list.map((file) => [file.path, file.sha256])));

/** How `found` differs from `frozen`: each path that was added, deleted or whose bytes changed, in path order. */
export function changesBetween(frozen: readonly FrozenFile[], found: readonly FrozenFile[]): { path: string; change: PathChange }[] {
  const before = new Map(frozen.map((file) => [file.path, file.sha256]));
  const after = new Map(found.map((file) => [file.path, file.sha256]));
  const changes: { path: string; change: PathChange }[] = [];
  for (const [path, sha256] of after) {
    if (!before.has(path)) changes.push({ path, change: "added" });
    else if (before.get(path) !== sha256) changes.push({ path, change: "modified" });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, change: "deleted" });
  return changes.sort((a, b) => byPath(a.path, b.path));
}
