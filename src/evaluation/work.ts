// Duplicated and reverted work, counted in lines from the commits a trial's run left: each attempt's snapshot against the
// commit its workspace started from, and the result against the fixture. Deterministic, and blind to what the lines mean:
// a measure of work thrown away or redone, not of its quality.

import { findHandoff } from "../ledger/index.ts";
import type { RunView } from "../protocol/index.ts";
import { git } from "../runtime/index.ts";
import type { TrialWork } from "./events.ts";

/** Lines added plus lines deleted from `from` to `to`, by `git diff --numstat`; a binary file counts 0. */
async function linesChanged(repo: string, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const numstat = await git(repo, ["diff", "--numstat", "--no-renames", from, to]);
  let lines = 0;
  for (const row of numstat.split("\n")) {
    const [added, deleted] = row.split("\t");
    if (added === undefined || deleted === undefined || added === "-") continue;
    lines += Number(added) + Number(deleted);
  }
  return lines;
}

/** Whether `commit` is `of` or one of its ancestors. Only git's exit code 1 says it is not; any other failure throws. */
async function isAncestor(repo: string, commit: string, of: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", commit, of]);
    return true;
  } catch (error) {
    if ((error as { cause?: { code?: unknown } }).cause?.code === 1) return false;
    throw error;
  }
}

/** The work of a run whose result `commit` was scored against the fixture `base` (see `TrialWork`). */
export async function workOf(repo: string, run: RunView, base: string, commit: string): Promise<TrialWork> {
  let kept = 0;
  let duplicated = 0;
  for (const attempt of run.steps.flatMap((step) => step.attempts)) {
    if (!attempt.snapshot) continue;
    const found = findHandoff(run, attempt.handoff.id, attempt.handoff.revision);
    if (!found) throw new Error(`attempt ${attempt.id} names a handoff revision the run never issued`);
    const lines = await linesChanged(repo, found.handoff.handoff.base.commit, attempt.snapshot.commit);
    if (await isAncestor(repo, attempt.snapshot.commit, commit)) kept += lines;
    else duplicated += lines;
  }
  const result = await linesChanged(repo, base, commit);
  return { result, duplicated, reverted: Math.max(0, kept - result) };
}
