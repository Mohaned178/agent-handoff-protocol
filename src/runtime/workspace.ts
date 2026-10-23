import { git } from "./git.ts";

// Snapshot commits are made with plumbing commands, so no hooks run and no user identity is required.
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "AHP",
  GIT_AUTHOR_EMAIL: "ahp@localhost",
  GIT_COMMITTER_NAME: "AHP",
  GIT_COMMITTER_EMAIL: "ahp@localhost",
};

/** Creates a detached git worktree at `path` checked out at `commit`. */
export async function addWorktree(repo: string, path: string, commit: string): Promise<void> {
  await git(repo, ["worktree", "add", "--detach", path, commit]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/**
 * Commits everything in the worktree that git does not ignore, whether or not the agent committed,
 * on top of the worktree's HEAD, and pins the commit under `ref` so it is never garbage-collected.
 */
export async function snapshotWorktree(worktree: string, ref: string, message: string): Promise<string> {
  await git(worktree, ["add", "--all"]);
  const tree = await git(worktree, ["write-tree"]);
  const commit = await git(worktree, ["commit-tree", tree, "-p", "HEAD", "-m", message], SNAPSHOT_IDENTITY);
  await git(worktree, ["update-ref", ref, commit]);
  return commit;
}
