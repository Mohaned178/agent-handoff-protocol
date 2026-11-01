// Starts the new app from source until ticket 09 makes plain `ahp` open it: `node src/tui/dev.ts`. Like the old compact
// view, it opens only on a terminal (stdout and stdin TTYs) with `CI` unset.

import { App } from "./app.ts";
import { h } from "./h.ts";
import { runFullScreen } from "./terminal.ts";
import { themeOf } from "./theme.ts";

export const NEEDS_A_TERMINAL = "ahp's app needs a terminal (stdout and stdin a TTY, CI unset); the plain commands work anywhere: `node src/cli/bin.ts --help`.";

if (process.stdout.isTTY !== true || process.stdin.isTTY !== true || process.env.CI) {
  process.stderr.write(`${NEEDS_A_TERMINAL}\n`);
  process.exitCode = 2;
} else {
  process.exitCode = await runFullScreen(h(App, { cwd: process.cwd(), theme: themeOf(process.env, true) }), { stdout: process.stdout, stdin: process.stdin, stderr: process.stderr });
}
