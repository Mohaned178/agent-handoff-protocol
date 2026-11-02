import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));
const plainEntry = fileURLToPath(new URL("../../src/commands/bin.ts", import.meta.url));

function runEntry(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the old `ahp` CLI from source as a child process in `cwd`, with `env` added to this process's environment. Goes with `src/cli/` (ticket 09). */
export function ahp(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return runEntry(cliEntry, args, cwd, env);
}

/** Runs the plain commands (`src/commands/`) as a child process in `cwd`, with `env` added to this process's environment. */
export function plain(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return runEntry(plainEntry, args, cwd, env);
}
