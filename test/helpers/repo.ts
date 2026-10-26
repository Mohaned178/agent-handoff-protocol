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
 * `config` is applied before the files are staged, so settings such as `core.autocrlf` affect the fixture commit.
 * The path is canonical (symlinks resolved), so it compares equal to paths reported by child processes.
 */
export function createTempRepo(files: Record<string, string>, config: Record<string, string> = {}): string {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-test-")));
  created.push(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "AHP Test");
  git(repo, "config", "user.email", "ahp-test@localhost");
  git(repo, "config", "commit.gpgsign", "false");
  for (const [key, value] of Object.entries(config)) git(repo, "config", key, value);
  for (const [path, content] of Object.entries(files)) {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", "fixture");
  return repo;
}

/** Has `removeTempRepos` remove `dir` too. */
export function trackForRemoval(dir: string): void {
  created.push(dir);
}

/** Removes every repository created by `createTempRepo`, and every directory given to `trackForRemoval`. */
export function removeTempRepos(): void {
  for (const repo of created.splice(0)) {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** A verification script that always passes, for steps whose result is not what a test is about. */
export const VERIFY_OK = `process.exit(0);\n`;

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
