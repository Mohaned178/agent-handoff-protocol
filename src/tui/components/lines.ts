// A screen's body as lines that can be scrolled: a frame's body clips what does not fit without a word, so a screen whose
// content may be longer than the terminal is built as lines and shows a window of them (↑↓ move it). One line is one row of
// the terminal; a longer one is cut at its end.

import { Box, Text } from "ink";
import { h } from "../h.ts";
import { is, type KeyBinding } from "../keys.ts";
import type { Token } from "../theme.ts";
import { useTheme } from "../theme.ts";

export interface TextLine {
  key: string;
  parts: { text: string; tone: Token; bold?: boolean }[];
}

export const line = (key: string, ...parts: TextLine["parts"]): TextLine => ({ key, parts });
export const part = (text: string, tone: Token = "text", bold?: boolean): TextLine["parts"][number] => ({ text, tone, ...(bold ? { bold } : {}) });

/** How many body rows a frame has at `rows` terminal rows: below the title and separator, above the footer. */
export const bodyHeight = (rows: number): number => Math.max(3, rows - 3);

export const clampOffset = (offset: number, count: number, height: number): number => Math.max(0, Math.min(offset, count - height));

/** ↑↓ move the window, shown only when there is more than fits. */
export function scrollKeys(count: number, height: number, offset: number, set: (offset: number) => void): KeyBinding[] {
  return [{ keys: "↑↓", label: "scroll", when: count > height, match: is.upOrDown, run: (_, key) => set(clampOffset(offset + (key.upArrow ? -1 : 1), count, height)) }];
}

export function LinesView({ lines, offset, height }: { lines: readonly TextLine[]; offset: number; height: number }) {
  const theme = useTheme();
  const from = clampOffset(offset, lines.length, height);
  return h(
    Box,
    { flexDirection: "column" },
    ...lines.slice(from, from + height).map((entry) =>
      h(Text, { key: entry.key, wrap: "truncate-end" }, ...entry.parts.map((segment, index) => h(Text, { key: index, color: theme.color(segment.tone), bold: segment.bold && theme.bold }, segment.text))),
    ),
  );
}
