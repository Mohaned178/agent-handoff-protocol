// Every screen's frame: the title line, a separator, the body, the footer, with the black background painted to every
// cell of the terminal (spec D5), whatever the terminal's own theme is.

import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { h } from "../h.ts";
import type { KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { useTheme } from "../theme.ts";
import { Footer } from "./footer.ts";

export interface FrameProps {
  layout: Layout;
  /** After "AHP" on the title line: the repository and branch, or the screen's name. */
  title: string;
  /** At the right end of the title line. */
  right?: string;
  keys: readonly KeyBinding[];
  status?: string;
  children?: ReactNode;
}

/** The whole screen, black, `columns` × `rows`: what every screen and the size refusal stand on. */
export function Canvas({ layout, children }: { layout: Layout; children?: ReactNode }) {
  const theme = useTheme();
  return h(Box, { width: layout.columns, height: layout.rows, flexDirection: "column", backgroundColor: theme.color("bg"), overflow: "hidden" }, children);
}

export function Frame({ layout, title, right, keys, status, children }: FrameProps) {
  const theme = useTheme();
  return h(
    Canvas,
    { layout },
    h(
      Box,
      { paddingX: 1, flexShrink: 0 },
      h(Text, { color: theme.color("accent"), bold: theme.bold }, "AHP"),
      h(Box, { flexGrow: 1, flexShrink: 1, marginLeft: 2, marginRight: 2 }, h(Text, { color: theme.color("text"), wrap: "truncate-end" }, title)),
      right ? h(Text, { color: theme.color("muted") }, right) : null,
    ),
    h(Text, { color: theme.color("border") }, "─".repeat(layout.columns)),
    h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, paddingX: 1, overflow: "hidden" }, children),
    h(Footer, { keys, status }),
  );
}
