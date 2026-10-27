import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { resolveExecutable } from "../../src/process/index.ts";
import { trackForRemoval } from "./repo.ts";

/** The `.cmd` shim npm writes for a package's JavaScript bin, pointing at `target` under the shim's directory. */
const npmShim = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r
`;

/** Credentials a fake tool prints from its status command: none of them may ever reach doctor's output. */
export const FAKE_SECRETS = ["fake-person@example.test", "sk-fake-secret-token-0123456789"];

/** A directory to install fake tools in, holding the log they write their invocations to. */
export function fakeToolsDir() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-tools-")));
  trackForRemoval(dir);
  const log = join(dir, "invocations.jsonl");
  writeFileSync(log, "");
  return {
    dir,
    log,
    /** What each fake tool was run with, in order: its name, arguments and the length of what it was given on stdin. */
    invocations: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; argv: string[]; stdinBytes: number }),
  };
}

/**
 * Installs `command` in `dir` as a Node script: an npm shim on Windows, a script with a shebang elsewhere. `body` runs
 * after the invocation is logged, and has `argv` (the arguments), `fs` and `process`.
 */
export function installFakeTool(dir: string, log: string, command: string, body: string): void {
  const script = `const fs = require("fs");
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(command)}, argv, stdinBytes: Buffer.concat(chunks).length }) + "\\n");
  ${body}
});
process.stdin.resume();
`;
  if (process.platform === "win32") {
    writeFileSync(join(dir, `${command}.cmd`), npmShim(`node_modules\\${command}\\cli.js`));
    mkdirSync(join(dir, "node_modules", command), { recursive: true });
    writeFileSync(join(dir, "node_modules", command, "cli.js"), script);
  } else {
    const path = join(dir, command);
    writeFileSync(path, `#!${process.execPath}\n${script}`);
    chmodSync(path, 0o755);
  }
}

/** A PATH holding the fake tools first and git (found on the real PATH) after, so nothing installed on this machine is found. */
export async function pathWithFakes(dir: string): Promise<NodeJS.ProcessEnv> {
  const git = await resolveExecutable("git");
  return { PATH: [dir, dirname(git.path)].join(delimiter), Path: [dir, dirname(git.path)].join(delimiter) };
}
