import { git, gitStdoutSha256 } from "./git.ts";

/**
 * The SHA-256 (lowercase hex) of the content of `path` as committed in `commit`, or null when the commit has
 * no regular file there. The bytes come from git's object store, never from a working tree, so the hash is
 * the same whatever line-ending conversion a checkout applied (ADR 0005).
 */
export async function hashCommittedFile(repo: string, commit: string, path: string): Promise<string | null> {
  // `--full-tree` makes the path relative to the repository root whatever directory `repo` points into.
  const entry = await git(repo, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
  const [mode, type, object] = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry.split("\0")[0] ?? "")?.slice(1) ?? [];
  // A tree (directory) or a submodule is not a file; a symlink's blob is its target path.
  if (type !== "blob" || !object || mode === "160000") return null;
  return gitStdoutSha256(repo, ["cat-file", "blob", object]);
}
