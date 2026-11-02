// The code an agent is writing, read from its worktree: `git diff --no-color` against the commit the attempt started
// from, plus the files git does not track yet, each with when it last changed. Read only: git is told not to write back
// a refreshed index, and untracked files are read from disk. A snapshot's diff (a step that has ended) is read the
// same way, from the repository, between two commits.

import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../runtime/git.ts";
import type { RunView } from "../protocol/index.ts";
import { parseUnifiedDiff, untrackedFile, type DiffFile } from "./diff-model.ts";

/** Untracked files larger than this are named, not read. */
export const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** At most this many untracked files are read; the rest are named. */
export const MAX_UNTRACKED_FILES = 200;

const DIFF_ARGS = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];

const changedAtOf = (worktree: string, path: string) => stat(join(worktree, path)).then((info) => info.mtimeMs, () => null);

async function readUntracked(worktree: string, path: string, changedAt: number | null): Promise<DiffFile> {
  const handle = await open(join(worktree, path), "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_UNTRACKED_BYTES) return { path, change: "added", added: null, removed: null, binary: false, huge: true, lines: [], changedAt };
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return untrackedFile(path, buffer.subarray(0, bytesRead), changedAt);
  } finally {
    await handle.close();
  }
}

/**
 * The worktree's changes against `base`, each file with when it last changed (a deleted file: when it was first seen
 * gone, from `seen`, which the caller keeps between reads).
 */
export async function readLiveDiff(worktree: string, base: string, seen: Map<string, number> = new Map(), now = Date.now()): Promise<DiffFile[]> {
  const [tracked, untracked] = await Promise.all([
    git(worktree, ["--no-optional-locks", ...DIFF_ARGS, base]),
    git(worktree, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = parseUnifiedDiff(tracked);
  const paths = untracked.split("\0").filter((path) => path !== "" && !files.some((file) => file.path === path));
  const read = await Promise.all(
    paths.map(async (path, index) => {
      const changedAt = await changedAtOf(worktree, path);
      if (index >= MAX_UNTRACKED_FILES) return { path, change: "added" as const, added: null, removed: null, binary: false, huge: true, lines: [], changedAt };
      return readUntracked(worktree, path, changedAt).catch(() => null);
    }),
  );
  const all = [...files, ...read.filter((file) => file !== null)];
  for (const file of all) {
    file.changedAt = file.change === "deleted" ? null : await changedAtOf(worktree, file.path);
    if (file.changedAt === null) {
      if (!seen.has(file.path)) seen.set(file.path, now);
      file.changedAt = seen.get(file.path)!;
    }
  }
  return all;
}

/** The diff between two commits of the repository: what a step's snapshot changed from where it started. */
export async function readCommitDiff(repo: string, from: string, to: string): Promise<DiffFile[]> {
  return parseUnifiedDiff(await git(repo, [...DIFF_ARGS, from, to]));
}

/** The commit an attempt started from: its handoff revision's base. */
export function attemptBase(state: RunView, attemptId: string): string | null {
  for (const step of state.steps) {
    const attempt = step.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt) continue;
    const handoff = step.handoffs.find((view) => view.handoffId === attempt.handoff.id && view.revision === attempt.handoff.revision);
    return handoff?.handoff.base.commit ?? null;
  }
  return null;
}

/** The last `maxBytes` of a file as lines, newest last, with control characters other than tab left out; null when it does not exist. */
export async function readTail(path: string, maxBytes = 64 * 1024): Promise<string[] | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    // A cut in the middle of a line leaves that line out.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .split(/\r?\n/)
      .map((row) => row.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replaceAll("\t", "  "))
      .filter((row, index, rows) => row !== "" || index < rows.length - 1);
  } finally {
    await handle.close();
  }
}
