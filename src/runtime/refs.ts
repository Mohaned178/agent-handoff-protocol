import type { SharedRef } from "../protocol/index.ts";
import { git } from "./git.ts";

/** AHP's own refs, such as the pins of attempt snapshots: they grow with every run and no agent's work is in them. */
const AHP_REFS = "refs/ahp/";

/**
 * The shared repository's refs, sorted by name: branches, tags, remote-tracking refs and the stash, which every
 * worktree of the repository shares, and nothing under `refs/ahp/`. A symbolic ref is listed with the object its
 * target points at.
 */
export async function sharedRefs(repo: string): Promise<SharedRef[]> {
  const output = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  const refs: SharedRef[] = [];
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const name = line.slice(space + 1);
    if (!name.startsWith(AHP_REFS)) refs.push({ name, oid: line.slice(0, space) });
  }
  return refs;
}
