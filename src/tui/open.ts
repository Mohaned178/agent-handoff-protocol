// Opens the full-screen app in this process: `ahp` with no arguments, or `ahp "<task>"`, on a terminal. It is loaded only
// then, so the plain commands never pay for Ink and React.

import { App } from "./app.ts";
import { h } from "./h.ts";
import { TaskRunner } from "./task-runner.ts";
import { runFullScreen } from "./terminal.ts";
import { themeOf } from "./theme.ts";

/** Whether the app can open here: stdout and stdin are terminals and `CI` is unset. */
export const hasTerminal = (): boolean => process.stdout.isTTY === true && process.stdin.isTTY === true && !process.env.CI;

/** Runs the app until it ends and returns the exit code. `task` opens the summary of that task. */
export async function openApp(options: { task?: string } = {}): Promise<number> {
  // One runner, shared with the exit hook: a SIGTERM or a closed window cancels the run in hand before ahp ends.
  const runner = new TaskRunner();
  const beforeExit = async () => {
    runner.cancel();
    await runner.settled();
  };
  const start = options.task === undefined ? {} : { startTask: options.task };
  return runFullScreen(h(App, { cwd: process.cwd(), theme: themeOf(process.env, true), runner, ...start }), { stdout: process.stdout, stdin: process.stdin, stderr: process.stderr, beforeExit });
}
