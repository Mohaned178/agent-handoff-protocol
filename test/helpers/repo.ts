import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];

/** Runs git in `cwd` and returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

/**
 * Creates a git repository in a fresh temporary directory with `files` committed on `main`.
 * The path is canonical (symlinks resolved), so it compares equal to paths reported by child processes.
 */
export function createTempRepo(files: Record<string, string>): string {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-test-")));
  created.push(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "AHP Test");
  git(repo, "config", "user.email", "ahp-test@localhost");
  git(repo, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", "fixture");
  return repo;
}

/** Removes every repository created by `createTempRepo`. */
export function removeTempRepos(): void {
  for (const repo of created.splice(0)) {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * A verification script for fixture repos: passes when `greeting.txt` contains "hello".
 * It prints its working directory so tests can see where verification ran.
 */
export const VERIFY_GREETING = `
import { existsSync, readFileSync } from "node:fs";
console.log("cwd=" + process.cwd());
const ok = existsSync("greeting.txt") && readFileSync("greeting.txt", "utf8").trim() === "hello";
console.log(ok ? "greeting ok" : "greeting missing or wrong");
process.exit(ok ? 0 : 1);
`;
