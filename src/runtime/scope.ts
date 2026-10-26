import type { ChangedPath, DiffScopeEvidence, PathChange, ProtectedPathsEvidence } from "../protocol/index.ts";
import { git } from "./git.ts";

/** Keeps the ledger bounded: a diff that touches more paths lists only the first of them. */
const MAX_LISTED_PATHS = 200;

const CHANGE_OF_STATUS: Record<string, PathChange> = { A: "added", D: "deleted" };

/** The changes `git diff --name-status -z` printed, in its order. */
function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const changed: ChangedPath[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    changed.push({ path: fields[i + 1]!, change: CHANGE_OF_STATUS[fields[i]![0]!] ?? "modified" });
  }
  return changed;
}

/**
 * The paths that differ between the step's base commit and the attempt's snapshot, with how each changed.
 * It diffs against `base`, not the snapshot's parent: the snapshot is made on top of whatever the workspace's
 * HEAD was, so an agent that committed would otherwise hide its changes in that commit. Renames are reported
 * as a delete and an add, so a protected path cannot be moved away unseen.
 */
export async function changedPaths(repo: string, base: string, snapshot: string): Promise<ChangedPath[]> {
  return parseNameStatus(await git(repo, ["diff", "--name-status", "--no-renames", "-z", base, snapshot]));
}

/**
 * The paths that differ between `base` and the worktree as it is now, files git does not ignore but does not track
 * included as added, whatever the worktree's HEAD (an agent may have committed). It only reads: git is told not to
 * write back a refreshed index.
 */
export async function worktreeChanges(worktree: string, base: string): Promise<ChangedPath[]> {
  const tracked = await git(worktree, ["--no-optional-locks", "diff", "--name-status", "--no-renames", "-z", base]);
  const untracked = await git(worktree, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
  const changed = new Map(parseNameStatus(tracked).map(({ path, change }) => [path, change]));
  for (const path of untracked.split("\0")) if (path !== "" && !changed.has(path)) changed.set(path, "added");
  return [...changed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, change]) => ({ path, change }));
}

/** The first of `items`, as many as a ledger event lists, and whether more were left out. */
export function bounded<T>(items: readonly T[]): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, MAX_LISTED_PATHS), truncated: items.length > MAX_LISTED_PATHS };
}

export function diffScopeEvidence(changed: readonly ChangedPath[]): DiffScopeEvidence {
  const { items, truncated } = bounded(changed);
  return { kind: "diff_scope", changed: items, truncated };
}

/** Case-insensitive, so the verdict does not depend on whether the attempt ran on a case-insensitive filesystem. */
const segments = (path: string) => path.toLowerCase().split("/");

/**
 * True when the two paths are the same, one lies under the other, or one contains the other. A change to a
 * path that contains a protected one counts: replacing a protected directory with a file or a symlink changes
 * what is at the protected path even if no protected path is listed in the diff.
 */
function overlaps(changed: string, protectedPath: string): boolean {
  const a = segments(changed);
  const b = segments(protectedPath);
  const shared = Math.min(a.length, b.length);
  return a.slice(0, shared).every((segment, index) => segment === b[index]);
}

export function checkProtectedPaths(changed: readonly ChangedPath[], protectedPaths: readonly string[]): ProtectedPathsEvidence {
  const { items, truncated } = bounded(changed.filter((c) => protectedPaths.some((p) => overlaps(c.path, p))));
  return { kind: "protected_paths", protected: [...protectedPaths], violations: items, truncated };
}
