// What `ahp run` shows of the code: the files each attempt changed, with line counts, and the diff itself at an approval
// gate (and after every attempt with --diff). Always read from AHP's snapshot commits, never a worktree, so what is shown
// is what was verified and what would be pushed.

import { git } from "../runtime/index.ts";

/** How many lines of a diff are printed before the rest is left to `ahp inspect`. */
export const MAX_DIFF_LINES = 200;

export interface FileChange {
  path: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

/** The files changed between two commits, with their line counts. No external diff program or text conversion runs. */
export async function changesBetween(repo: string, from: string, to: string): Promise<FileChange[]> {
  const out = await git(repo, ["-c", "core.quotepath=off", "diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", from, to]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split("\t");
      const count = (n: string | undefined) => (n === "-" || n === undefined ? null : Number(n));
      return { path: path.join("\t"), added: count(added), removed: count(removed) };
    });
}

/** The unified diff between two commits, as `pendingApprovalOf` reads it. */
export async function diffBetween(repo: string, from: string, to: string): Promise<string> {
  return git(repo, ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", from, to]);
}

/** One line: `changed a (+3 -1), b (binary)`, the first five files, or that nothing changed. */
export function describeChanges(changes: readonly FileChange[]): string {
  if (changes.length === 0) return "changed nothing";
  const each = changes.slice(0, 5).map(({ path, added, removed }) => (added === null ? `${path} (binary)` : `${path} (+${added} -${removed})`));
  const more = changes.length > 5 ? `, and ${changes.length - 5} more` : "";
  return `changed ${each.join(", ")}${more}`;
}

const COLORS = { add: "\u001b[32m", remove: "\u001b[31m", hunk: "\u001b[36m", file: "\u001b[1m", reset: "\u001b[0m" };

/**
 * A diff for the terminal, indented, colored when `color`, and cut at `maxLines` with `more` saying where the rest is.
 */
export function formatDiff(diff: string, { color, maxLines = MAX_DIFF_LINES, more }: { color: boolean; maxLines?: number; more: string }): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  const paint = (line: string) => {
    if (!color) return line;
    const code = line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")
      ? COLORS.file
      : line.startsWith("+") ? COLORS.add : line.startsWith("-") ? COLORS.remove : line.startsWith("@@") ? COLORS.hunk : "";
    return code ? `${code}${line}${COLORS.reset}` : line;
  };
  const shown = lines.slice(0, maxLines).map((line) => `    ${paint(line)}`);
  if (lines.length > maxLines) shown.push(`    ... ${lines.length - maxLines} more lines: ${more}`);
  return shown.join("\n");
}
