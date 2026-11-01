// Screen tests: render the app (or a piece of it) into a fake terminal of any size, type and press keys, then read the
// last frame as plain text, and the colours where they carry meaning, as the theme's tokens.
//
// ink-testing-library 4.0.0 does render Ink 8 (checked 2026-11-02), but its stdout is fixed at 100 columns and has no
// rows, and the app's layout depends on both; so this harness writes frames through Ink's own `render` the same way,
// to a fake stdout whose size a test chooses.

import { EventEmitter } from "node:events";
import chalk from "chalk";
import { render } from "ink";
import type { ReactElement } from "react";
import { PALETTE, TOKENS, type Token } from "../../src/tui/theme.ts";

// Chalk writes no colour when the process's stdout is not a terminal, as under Vitest. The theme alone decides whether
// colour is asked for, so let chalk write whatever it is asked: then "no colour" is the app's doing, and testable.
chalk.level = 3;

export class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  isTTY: boolean | undefined;
  /** Every write, in order. */
  readonly writes: string[] = [];
  constructor(columns: number, rows: number, isTTY?: boolean) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = isTTY;
  }
  write = (data: string, callback?: () => void): boolean => {
    this.writes.push(data);
    callback?.();
    return true;
  };
  /** Everything written, joined. */
  written = (): string => this.writes.join("");
}

export class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export const KEYS = {
  enter: "\r",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  backspace: "\u007f",
  tab: "\t",
  "ctrl+c": "\u0003",
} as const;
export type KeyName = keyof typeof KEYS;

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** Whether `text` holds any escape sequence at all. */
export const hasEscapes = (text: string): boolean => text.includes("\u001b");

/** Ink's frames come at most 30 a second, and a lone Esc waits 20 ms for the rest of a sequence. */
const SETTLE_MS = 80;
const settle = (ms = SETTLE_MS) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Tui {
  stdout: FakeStdout;
  stdin: FakeStdin;
  /** The last frame as plain text. */
  frame: () => string;
  /** The last frame as written, colour codes and all. */
  raw: () => string;
  type: (text: string) => Promise<void>;
  press: (...keys: KeyName[]) => Promise<void>;
  /** Text as a terminal pastes it, between bracketed-paste markers. */
  paste: (text: string) => Promise<void>;
  resize: (columns: number, rows: number) => Promise<void>;
  /** Waits until the plain frame holds `text` (or `test` says yes), and returns that frame. */
  waitFor: (test: string | ((frame: string) => boolean), timeoutMs?: number) => Promise<string>;
  /** True once the app has exited by itself (a quit). */
  exited: () => boolean;
  unmount: () => void;
}

export function renderTui(node: ReactElement, size: { columns?: number; rows?: number } = {}): Tui {
  const stdout = new FakeStdout(size.columns ?? 120, size.rows ?? 30);
  const stdin = new FakeStdin();
  const stderr = new FakeStdout(120, 30);
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let exited = false;
  void instance.waitUntilExit().then(
    () => (exited = true),
    () => (exited = true),
  );
  const raw = () => stdout.writes.at(-1) ?? "";
  const frame = () => stripAnsi(raw());
  const send = async (data: string) => {
    stdin.write(data);
    await settle();
  };
  return {
    stdout,
    stdin,
    frame,
    raw,
    type: (text) => send(text),
    press: async (...keys) => {
      for (const key of keys) await send(KEYS[key]);
    },
    paste: (text) => send(`\u001b[200~${text}\u001b[201~`),
    resize: async (columns, rows) => {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit("resize");
      await settle();
    },
    waitFor: async (test, timeoutMs = 10_000) => {
      const holds = typeof test === "string" ? (text: string) => text.includes(test) : test;
      const deadline = Date.now() + timeoutMs;
      while (!holds(frame())) {
        if (Date.now() > deadline) throw new Error(`the frame never matched ${typeof test === "string" ? JSON.stringify(test) : "the test"}; last frame:\n${frame()}`);
        await settle(25);
      }
      return frame();
    },
    exited: () => exited,
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

interface Cell {
  char: string;
  fg: string | null;
  bg: string | null;
}

/** The frame's characters with the foreground and background colour codes each was written in ("2;r;g;b" or "5;n"). */
export function cellsOf(raw: string): Cell[] {
  const cells: Cell[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === "\u001b") {
      const match = /^\u001b\[([0-9;]*)m/.exec(raw.slice(index));
      if (match) {
        const params = match[1] === "" ? ["0"] : match[1]!.split(";");
        for (let i = 0; i < params.length; i++) {
          const code = params[i]!;
          if (code === "0") fg = bg = null;
          else if (code === "39") fg = null;
          else if (code === "49") bg = null;
          else if (code === "38" || code === "48") {
            const width = params[i + 1] === "2" ? 4 : 2;
            const value = params.slice(i + 1, i + 1 + width).join(";");
            if (code === "38") fg = value;
            else bg = value;
            i += width;
          }
        }
        index += match[0].length;
        continue;
      }
      const other = raw.slice(index).match(ANSI);
      index += raw.slice(index).search(ANSI) === 0 && other ? other[0].length : 1;
      continue;
    }
    const char = String.fromCodePoint(raw.codePointAt(index)!);
    cells.push({ char, fg, bg });
    index += char.length;
  }
  return cells;
}

const tokensOf = (code: string | null): Token[] => {
  if (code === null) return [];
  return TOKENS.filter((token) => {
    const { truecolor, ansi256 } = PALETTE[token];
    const rgb = [1, 3, 5].map((at) => Number.parseInt(truecolor.slice(at, at + 2), 16)).join(";");
    return code === `2;${rgb}` || code === `5;${ansi256}`;
  });
};

/** The tokens whose colour the first character of `text` in the frame is written in (several share a colour). */
export function colorAt(raw: string, text: string): Token[] {
  const cells = cellsOf(raw);
  const at = cells.map((cell) => cell.char).join("").indexOf(text);
  if (at === -1) throw new Error(`${JSON.stringify(text)} is not in the frame`);
  return tokensOf(cells[at]!.fg);
}

/** The cells of the frame (newlines left out) whose background is not `token`. */
export function cellsNotOn(raw: string, token: Token): Cell[] {
  return cellsOf(raw).filter((cell) => cell.char !== "\n" && !tokensOf(cell.bg).includes(token));
}
