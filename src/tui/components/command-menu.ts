// The slash-command menu, shown above the prompt while a command is typed: the commands that match, the selected one
// marked with ❯ (so it reads without colour too).

import { Box, Text } from "ink";
import type { SlashCommand } from "../commands.ts";
import { h } from "../h.ts";
import { SYMBOLS, useTheme } from "../theme.ts";

export interface CommandMenuProps {
  commands: readonly SlashCommand[];
  selected: number;
  /** How many rows the menu may take. */
  height?: number;
}

/** The first item of the window of `size` rows that keeps `selected` in view. */
export const windowStart = (count: number, selected: number, size: number): number => Math.max(0, Math.min(selected - size + 1, count - size));

export function CommandMenu({ commands, selected, height = 8 }: CommandMenuProps) {
  const theme = useTheme();
  if (commands.length === 0) return h(Box, { paddingX: 2, flexShrink: 0 }, h(Text, { color: theme.color("muted") }, "no command matches"));
  const first = windowStart(commands.length, selected, height);
  const shown = commands.slice(first, first + height);
  return h(
    Box,
    { flexDirection: "column", paddingX: 1, flexShrink: 0 },
    ...shown.map((command, offset) => {
      const index = first + offset;
      const on = index === selected;
      return h(
        Box,
        { key: command.name, backgroundColor: on ? theme.color("surface") : undefined },
        h(Text, { color: theme.color("accent") }, on ? `${SYMBOLS.caret} ` : "  "),
        h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: theme.color(on ? "accent" : "text") }, `/${command.name}`)),
        h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, command.about + (command.comesIn ? ` (ticket ${command.comesIn})` : "")),
      );
    }),
  );
}
