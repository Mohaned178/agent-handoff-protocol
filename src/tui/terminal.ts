// The app owns the whole terminal while it runs: the alternate screen on entry, and the person's own screen and cursor
// given back on every way out (a normal quit, a thrown error, a signal), so a crash never leaves a black, cursorless
// terminal behind. An error is printed after the screen is restored, where it can be read.

import type { EventEmitter } from "node:events";
import { constants } from "node:os";
import type { ReactElement } from "react";
import { render } from "ink";

export const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
export const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
export const SHOW_CURSOR = "\u001b[?25h";

/** What is written to leave the app's screen: the cursor shown, then the person's own screen back. */
export const RESTORE = SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN;

export interface FullScreenIo {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
  /** Where signals arrive; default `process`. */
  signals?: EventEmitter;
  /** How a signal ends the process; default `process.exit`. */
  exit?: (code: number) => void;
}

const SIGNALS: readonly NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];

/** Runs `node` full screen until it exits. Returns 0, or 1 after a thrown error (printed once the screen is restored). */
export async function runFullScreen(node: ReactElement, io: FullScreenIo): Promise<number> {
  const signals = io.signals ?? process;
  const exit = io.exit ?? ((code: number) => process.exit(code));
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    io.stdout.write(RESTORE);
  };
  let instance: ReturnType<typeof render> | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    instance?.unmount();
    restore();
    exit(128 + (constants.signals[signal] ?? 1));
  };
  const onExit = () => restore();
  signals.on("exit", onExit);
  for (const signal of SIGNALS) signals.on(signal, onSignal);
  io.stdout.write(ENTER_ALTERNATE_SCREEN);
  try {
    // Ctrl+C is the screens' own. Console output is not rerouted: nothing in the app writes to the console, and the
    // agents' output goes to files the runtime owns.
    instance = render(node, { stdout: io.stdout, stdin: io.stdin, stderr: io.stderr, exitOnCtrlC: false, patchConsole: false });
    await instance.waitUntilExit();
    restore();
    return 0;
  } catch (error) {
    restore();
    io.stderr.write(`ahp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  } finally {
    restore();
    signals.off("exit", onExit);
    for (const signal of SIGNALS) signals.off(signal, onSignal);
  }
}
