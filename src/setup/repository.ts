// Whether a folder is something a run can start from, and the two things that make it one (`git init`, a first commit).
// No printing and no questions: the old `ahp "<task>"` asks them in a terminal prompt and the app shows them as screens, and
// both decide from the state returned here. AHP's runs start from a commit and agents see only what is committed.

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { git } from "../runtime/git.ts";
import { locateRepo } from "../runtime/paths.ts";

/** What a folder is, for the purpose of starting a run in it. */
export type RepositoryState =
  /** A repository with a commit: runs start from it. */
  | { kind: "ready"; repo: string }
  /** The home folder, rarely the project meant: never made a repository. */
  | { kind: "home_folder"; dir: string }
  | { kind: "not_repository"; dir: string }
  /** A repository with no commit yet. */
  | { kind: "no_commit"; repo: string }
  /** A commit is needed, and git knows no name and email to make it as; `then` is the state once that is fixed. */
  | { kind: "no_identity"; dir: string; then: "not_repository" | "no_commit" };

/** The commands that tell git who the person is: the only fix, and the person's to make. */
export const GIT_IDENTITY_COMMANDS = ['git config --global user.name "Your Name"', "git config --global user.email you@example.com"] as const;

/** Why a first commit cannot be made as the person, with the commands that fix it. */
export const NO_GIT_IDENTITY = `git does not know who you are, and a first commit is made as you. Tell it, then run ahp again:\n${GIT_IDENTITY_COMMANDS.map((command) => `  ${command}`).join("\n")}`;

export class RepositoryError extends Error {}

/** Whether `path` is the home folder, which is rarely the project meant. */
export async function isHomeFolder(path: string, home: string = homedir()): Promise<boolean> {
  const realHome = await realpath(home).catch(() => home);
  const real = await realpath(path).catch(() => path);
  return process.platform === "win32" ? real.toLowerCase() === realHome.toLowerCase() : real === realHome;
}

const hasCommit = (repo: string) => git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);

/** Whether git knows a name and email to commit as (`git var` fails when it does not). */
async function knowsWhoYouAre(dir: string): Promise<boolean> {
  try {
    await git(dir, ["var", "GIT_AUTHOR_IDENT"]);
    await git(dir, ["var", "GIT_COMMITTER_IDENT"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What `dir` is. The home folder first; a home folder kept under git holds every folder below it, so a repository that is
 * the home folder counts as no repository. An identity is asked about only when a commit has to be made.
 */
export async function inspectRepository(dir: string, home: string = homedir()): Promise<RepositoryState> {
  if (await isHomeFolder(dir, home)) return { kind: "home_folder", dir };
  let top: string | null = await locateRepo(dir).then((found) => found.repo, () => null);
  if (top !== null && (await isHomeFolder(top, home))) top = null;
  if (top !== null && (await hasCommit(top))) return { kind: "ready", repo: top };
  const then = top === null ? "not_repository" : "no_commit";
  if (!(await knowsWhoYouAre(top ?? dir))) return { kind: "no_identity", dir: top ?? dir, then };
  return top === null ? { kind: "not_repository", dir } : { kind: "no_commit", repo: top };
}

/** Commits everything in the repository not ignored, as the person (an empty commit when there is nothing). */
async function firstCommit(repo: string): Promise<void> {
  try {
    await git(repo, ["add", "--all"]);
    await git(repo, ["commit", "--quiet", "--allow-empty", "--message", "First commit"]);
  } catch (error) {
    throw new RepositoryError(`could not make the first commit: ${(error as Error).message}. If git does not know who you are, \`${GIT_IDENTITY_COMMANDS[0]}\` and \`${GIT_IDENTITY_COMMANDS[1]}\` tell it`);
  }
}

/**
 * Makes a folder that is not a repository one (`git init`, then a first commit of what is in it), or a repository with no
 * commit one (the first commit). Returns the repository. Throws `RepositoryError` if the commit cannot be made, and for any
 * other state, which has nothing to make ready.
 */
export async function prepareRepository(state: RepositoryState): Promise<string> {
  if (state.kind === "not_repository") {
    await git(state.dir, ["init", "--quiet"]);
    await firstCommit(state.dir);
    return (await locateRepo(state.dir)).repo;
  }
  if (state.kind === "no_commit") {
    await firstCommit(state.repo);
    return state.repo;
  }
  throw new RepositoryError(`nothing to make ready: ${state.kind}`);
}
