import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));
const plainEntry = cliEntry;

function runEntry(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `ahp` from source as a child process in `cwd` (no terminal, so a plain command), with `env` added to this process environment. */
export function ahp(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return runEntry(cliEntry, args, cwd, env);
}

/** Runs the plain commands (`src/commands/`) as a child process in `cwd`, with `env` added to this process's environment. */
export function plain(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return runEntry(plainEntry, args, cwd, env);
}
