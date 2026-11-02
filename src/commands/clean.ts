// `/clean` and `ahp clean` (spec D10): remove the worktrees of runs that have ended. AHP never removes an attempt's worktree
// itself (a person may want to look at what an agent left), so they pile up. Never one a run may still need: a run waiting
// for a person (an approval, an unknown attempt, a stopped process), one a process is writing now, or one whose ledger
// cannot be read. The ledgers and the `refs/ahp/` snapshots stay: only the checkouts go. Nothing here prints or asks.

import { lstat, readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../runtime/git.ts";
import { worktreeRoot } from "../runtime/paths.ts";
import { discardWorktree } from "../runtime/workspace.ts";
import { listRuns, type RunListing } from "../sdk/run.ts";
import { ENDED_STATES, waitingDetail } from "./runs.ts";

export interface CleanedRun {
  runId: string;
  /** `removed` (or, in a dry run, would be); `kept` says why in `reason`; `failed` says what stopped it. */
  outcome: "removed" | "kept" | "failed";
  reason: string | null;
  /** The directories under the run's worktree directory (one per attempt, one per verification). */
  directories: string[];
  /** What they take on disk: for `removed` the space freed (a dry run: that would be), otherwise what stays. */
  bytes: number;
}

export interface CleanReport {
  dryRun: boolean;
  /** Every run of the repository that has worktrees on disk, newest first. A run with none is not listed. */
  runs: CleanedRun[];
  /** The space freed (a dry run: that would be), over the runs removed. */
  freedBytes: number;
}

export interface CleanOptions {
  /** Any directory inside the repository. */
  repo: string;
  /** Decide and say, remove nothing. */
  dryRun?: boolean;
}

/** Why a run's worktrees must stay, or null when the run has ended and they may go. */
export function keepReason(listing: RunListing): string | null {
  const { state } = listing;
  if (state === null) return `its ledger cannot be read${listing.problem ? `: ${listing.problem}` : ""}`;
  const waiting = waitingDetail(listing, state);
  if (waiting !== null) return waiting;
  if (listing.lock.state === "held" || listing.lock.state === "other_host") return "a process is running it";
  if (!(ENDED_STATES as readonly string[]).includes(state.state)) return `the run is ${state.state}`;
  return null;
}

/** The bytes in `path`, links counted as themselves and never followed. */
async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path)) total += await sizeOf(join(path, name)).catch(() => 0);
  return total;
}

const directoriesOf = async (path: string): Promise<string[] | null> => {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Removes the worktrees of the repository's ended runs, or with `dryRun` says what would go. The worktree directory is
 * shared by every repository, so only the runs `listRuns` returns for this one are touched. A run whose removal fails is
 * reported and the others go on.
 */
export async function cleanRuns(options: CleanOptions): Promise<CleanReport> {
  const dryRun = options.dryRun === true;
  const root = worktreeRoot();
  const runs: CleanedRun[] = [];
  let removedAny = false;
  for (const listing of await listRuns({ repo: options.repo })) {
    const directories = await directoriesOf(join(root, listing.runId));
    if (directories === null) continue;
    const bytes = (await Promise.all(directories.map((directory) => sizeOf(directory).catch(() => 0)))).reduce((sum, size) => sum + size, 0);
    const reason = keepReason(listing);
    if (reason !== null) {
      runs.push({ runId: listing.runId, outcome: "kept", reason, directories, bytes });
      continue;
    }
    if (dryRun) {
      runs.push({ runId: listing.runId, outcome: "removed", reason: null, directories, bytes });
      continue;
    }
    try {
      for (const directory of directories) await discardWorktree(options.repo, directory);
      removedAny = true;
      await rmdir(join(root, listing.runId)).catch(() => undefined);
      runs.push({ runId: listing.runId, outcome: "removed", reason: null, directories, bytes });
    } catch (error) {
      runs.push({ runId: listing.runId, outcome: "failed", reason: error instanceof Error ? error.message : String(error), directories, bytes });
    }
  }
  if (removedAny) await git(options.repo, ["worktree", "prune"]).catch(() => undefined);
  return { dryRun, runs, freedBytes: runs.filter((run) => run.outcome === "removed").reduce((sum, run) => sum + run.bytes, 0) };
}

/** A size for reading: "412 KB", "3.2 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const worktrees = (count: number) => `${count} ${count === 1 ? "worktree" : "worktrees"}`;

/** What a clean did or, for a dry run, would do: one line per run, then the total. Same words on screen and in the plain command. */
export function formatClean(report: CleanReport): string[] {
  const lines: string[] = [];
  for (const run of report.runs) {
    const id = run.runId.replace(/^run_/, "");
    if (run.outcome === "kept") lines.push(`kept     ${id}  ${worktrees(run.directories.length)}, ${sizeText(run.bytes)}: ${run.reason}`);
    else if (run.outcome === "failed") lines.push(`failed   ${id}  ${run.reason}`);
    else lines.push(`${report.dryRun ? "would remove" : "removed "}  ${id}  ${worktrees(run.directories.length)}, ${sizeText(run.bytes)}`);
  }
  const removed = report.runs.filter((run) => run.outcome === "removed");
  if (report.runs.length === 0) lines.push("No run of this repository has worktrees on disk.");
  else if (removed.length === 0) lines.push("Nothing to remove: every run with worktrees is still needed.");
  else lines.push(`${report.dryRun ? "Would remove" : "Removed"} ${worktrees(removed.reduce((sum, run) => sum + run.directories.length, 0))} of ${removed.length} ended ${removed.length === 1 ? "run" : "runs"}, ${report.dryRun ? "freeing" : "freed"} ${sizeText(report.freedBytes)}. Ledgers and snapshots are kept.`);
  return lines;
}
