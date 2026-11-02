// The bottom line: a status on the left (who plays each step, on the home screen) and, on the right, the keys that work
// now, read from the same table the screen's input handler dispatches through.

import { Box, Text } from "ink";
import { h } from "../h.ts";
import { footerKeys, type KeyBinding } from "../keys.ts";
import { useTheme } from "../theme.ts";

export interface FooterProps {
  keys: readonly KeyBinding[];
  status?: string;
}

export function Footer({ keys, status }: FooterProps) {
  const theme = useTheme();
  const shown = footerKeys(keys);
  return h(
    Box,
    { paddingX: 1, flexShrink: 0 },
    h(Box, { flexGrow: 1, flexShrink: 1, marginRight: 2 }, h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, status ?? "")),
    h(
      Box,
      { flexShrink: 0 },
      ...shown.map((binding, index) =>
        h(Text, { key: `${binding.keys} ${binding.label}` }, index === 0 ? "" : "  ", h(Text, { color: theme.color("accent") }, binding.keys), h(Text, { color: theme.color("muted") }, ` ${binding.label}`)),
      ),
    ),
  );
}
