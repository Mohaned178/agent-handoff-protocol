import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

/** Runs the `ahp` CLI from source as a child process in `cwd`. */
export function ahp(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], { cwd, encoding: "utf8", windowsHide: true });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
