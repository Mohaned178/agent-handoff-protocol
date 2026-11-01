// The prompt: a bordered input showing `PromptState` (`prompt-model.ts` does the editing). The cursor is drawn in
// reverse video when colours are on; with no colour it is a thin bar, so not one styling escape is written.

import { Box, Text } from "ink";
import { h } from "../h.ts";
import type { PromptState } from "../prompt-model.ts";
import { SYMBOLS, useTheme } from "../theme.ts";

export interface PromptProps {
  state: PromptState;
  placeholder: string;
  focused: boolean;
}

export const CURSOR_BAR = "▏";

export function Prompt({ state, placeholder, focused }: PromptProps) {
  const theme = useTheme();
  const lines = state.value.split("\n");
  // Which line the cursor is on, and where in it.
  let row = 0;
  let column = state.cursor;
  for (const line of lines) {
    if (column <= line.length) break;
    column -= line.length + 1;
    row++;
  }
  const cursorIn = (line: string, at: number) => {
    if (!focused) return [h(Text, { key: "t", color: theme.color("text") }, line)];
    const under = line[at] ?? " ";
    const cursor = theme.mode === "none" ? h(Text, { key: "c" }, CURSOR_BAR + (line[at] ?? "")) : h(Text, { key: "c", inverse: true, color: theme.color("text") }, under);
    return [h(Text, { key: "a", color: theme.color("text") }, line.slice(0, at)), cursor, h(Text, { key: "b", color: theme.color("text") }, line.slice(at + 1))];
  };
  const body =
    state.value === ""
      ? [h(Box, { key: 0 }, ...cursorIn("", 0), h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, placeholder))]
      : lines.map((line, index) => h(Box, { key: index }, h(Text, { wrap: "wrap" }, ...(index === row ? cursorIn(line, column) : [h(Text, { key: "t", color: theme.color("text") }, line)]))));
  return h(
    Box,
    { borderStyle: "round", borderColor: theme.color(focused ? "accent" : "border"), borderBackgroundColor: theme.color("bg"), paddingX: 1, flexShrink: 0 },
    h(Text, { color: theme.color("accent") }, `${SYMBOLS.caret} `),
    h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1 }, ...body),
  );
}
