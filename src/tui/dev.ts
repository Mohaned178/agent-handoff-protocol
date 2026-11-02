// Starts the new app from source until ticket 09 makes plain `ahp` open it: `node src/tui/dev.ts`, or
// `node src/tui/dev.ts <run-id>` to open a run's screen (a run started in any process). Like the old compact view, it
// opens only on a terminal (stdout and stdin TTYs) with `CI` unset.

import { isRunId } from "../runtime/paths.ts";
import { App } from "./app.ts";
import { h } from "./h.ts";
import { TaskRunner } from "./task-runner.ts";
import { runFullScreen } from "./terminal.ts";
import { themeOf } from "./theme.ts";

export const NEEDS_A_TERMINAL = "ahp's app needs a terminal (stdout and stdin a TTY, CI unset); the plain commands work anywhere: `node src/cli/bin.ts --help`.";

const [runId] = process.argv.slice(2);
if (runId !== undefined && !isRunId(runId)) {
  process.stderr.write(`not a run ID: ${runId} (\`node src/cli/bin.ts runs\` lists them)\n`);
  process.exitCode = 2;
} else if (process.stdout.isTTY !== true || process.stdin.isTTY !== true || process.env.CI) {
  process.stderr.write(`${NEEDS_A_TERMINAL}\n`);
  process.exitCode = 2;
} else {
  const start = runId === undefined ? {} : { start: "run" as const, runId };
  // One runner, shared with the signal handler: a SIGTERM or a closed window cancels the run in hand before ahp ends, as
  // Ctrl+C did in the old view.
  const runner = new TaskRunner();
  const beforeExit = async () => {
    runner.cancel();
    await runner.settled();
  };
  process.exitCode = await runFullScreen(h(App, { cwd: process.cwd(), theme: themeOf(process.env, true), runner, ...start }), { stdout: process.stdout, stdin: process.stdin, stderr: process.stderr, beforeExit });
}
