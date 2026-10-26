import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git.ts";

const RUN_ID = /^run_[a-z0-9]+$/;
const ATTEMPT_ID = /^att_[a-z0-9]+$/;

export interface RepoLocation {
  /** The top level of the working tree AHP was pointed at. */
  repo: string;
  /** `<git common dir>/ahp`: the repository's ledgers, kept out of every working tree. */
  ahpDir: string;
}

export async function locateRepo(dir: string): Promise<RepoLocation> {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  const commonDir = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // Canonical paths, so recorded paths compare equal to those child processes report.
  return { repo: await realpath(top), ahpDir: join(await realpath(commonDir), "ahp") };
}

/**
 * AHP's per-user directory: `AHP_HOME` if set, otherwise the platform's per-user state location.
 * Worktrees live here, outside any repository, so nothing inside them resolves files from the
 * user's checkout (such as its `node_modules`) by walking up parent directories.
 */
function ahpHome(): string {
  if (process.env.AHP_HOME) return resolve(process.env.AHP_HOME);
  switch (process.platform) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ahp");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "ahp");
    default:
      return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "ahp");
  }
}

/** Creates the directory that holds every AHP worktree and returns its canonical path. */
export async function prepareWorktreeRoot(): Promise<string> {
  const root = join(ahpHome(), "worktrees");
  await mkdir(root, { recursive: true });
  return realpath(root);
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function isAttemptId(value: string): boolean {
  return ATTEMPT_ID.test(value);
}

/** The directory that holds a directory per run, named by its ID, with the run's ledger in it. */
export function runsDir(location: RepoLocation): string {
  return join(location.ahpDir, "runs");
}

export function ledgerPath(location: RepoLocation, runId: string): string {
  if (!isRunId(runId)) throw new Error(`not a run ID: ${runId}`);
  return join(runsDir(location), runId, "ledger.jsonl");
}

/** Where the repository that holds `repo` is, and the ledger of its run `runId`; throws if it has no such run. */
export async function locateRun(repo: string, runId: string): Promise<{ location: RepoLocation; path: string }> {
  if (!isRunId(runId)) throw new Error(`not a run ID: ${runId}`);
  const location = await locateRepo(repo);
  const path = ledgerPath(location, runId);
  try {
    await access(path);
  } catch {
    throw new Error(`no run ${runId} in ${location.repo}`);
  }
  return { location, path };
}

export function worktreePath(worktreeRoot: string, runId: string, name: string): string {
  return join(worktreeRoot, runId, name);
}

/** The ref that pins an attempt's snapshot commit. */
export function snapshotRef(runId: string, attemptId: string): string {
  return `refs/ahp/snapshots/${runId}/${attemptId}`;
}
