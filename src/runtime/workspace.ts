import { rm } from "node:fs/promises";
import { git } from "./git.ts";

// Snapshot commits are made with plumbing commands, so no hooks run and no user identity is required.
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "AHP",
  GIT_AUTHOR_EMAIL: "ahp@localhost",
  GIT_COMMITTER_NAME: "AHP",
  GIT_COMMITTER_EMAIL: "ahp@localhost",
};

/** True when git config `key` is set in the repository's own (shared) configuration. */
const isSetLocally = (repo: string, key: string) =>
  git(repo, ["config", "--local", "--get", key]).then(
    () => true,
    () => false,
  );

/**
 * Creates a detached git worktree at `path` checked out at `commit`, with `core.longpaths` enabled so deep
 * paths (nested dependency trees) do not fail on Windows' 260-character limit (ADR 0005).
 *
 * `git config` inside a linked worktree writes the shared repository configuration, which belongs to the user.
 * So the setting goes in the worktree's own configuration file, which needs the repository to have
 * `extensions.worktreeConfig` on. That flag is the one change AHP makes to a repository's configuration; it is
 * left alone in a repository that sets `core.worktree`, which git requires to be moved when the flag is enabled,
 * and the worktree then has long paths only for its checkout.
 */
export async function addWorktree(repo: string, path: string, commit: string, options: { force?: boolean } = {}): Promise<void> {
  const perWorktreeConfig = !(await isSetLocally(repo, "core.worktree"));
  if (perWorktreeConfig && !(await isSetLocally(repo, "extensions.worktreeConfig"))) {
    await git(repo, ["config", "--local", "extensions.worktreeConfig", "true"]);
  }
  // `--force` also takes a path git still has registered as a worktree that is no longer there.
  await git(repo, ["-c", "core.longpaths=true", "worktree", "add", "--detach", ...(options.force ? ["--force"] : []), path, commit]);
  if (perWorktreeConfig) await git(path, ["config", "--worktree", "core.longpaths", "true"]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/**
 * Removes whatever an AHP process stopped partway through making or using at `path`, whether git has it registered
 * as a worktree or not, so nothing is there afterwards. For AHP's own worktrees only.
 */
export async function discardWorktree(repo: string, path: string): Promise<void> {
  // Fails for a path that is not a worktree, or one git has registered that is no longer there; the rest is removed below.
  await git(repo, ["worktree", "remove", "--force", "--force", path]).catch(() => undefined);
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
