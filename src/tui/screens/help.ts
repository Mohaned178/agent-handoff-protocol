// `?` or `/help`: every command and every key, read from the same tables the screens dispatch through.

import { Box, Text, useInput } from "ink";
import { COMMANDS } from "../commands.ts";
import { Frame } from "../components/frame.ts";
import { h } from "../h.ts";
import { dispatch, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { commonKeys, type Nav } from "../nav.ts";
import { useTheme } from "../theme.ts";
import { allHomeKeys } from "./home.ts";

/** What the prompt does beyond its keys: written here, as the prompt's editing has no key table of its own. */
export const PROMPT_EDITING: readonly { keys: string; label: string }[] = [
  { keys: "\\ enter", label: "a new line" },
  { keys: "←→ home end", label: "move in the text" },
  { keys: "paste", label: "several lines at once" },
];

function KeyRows({ rows }: { rows: readonly { keys: string; label: string }[] }) {
  const theme = useTheme();
  return h(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    ...rows.map((row) => h(Box, { key: `${row.keys} ${row.label}` }, h(Box, { width: 14, flexShrink: 0 }, h(Text, { color: theme.color("accent") }, row.keys)), h(Text, { color: theme.color("text"), wrap: "truncate-end" }, row.label))),
  );
}

export function Help({ layout, nav, active }: { layout: Layout; nav: Nav; active: boolean }) {
  const theme = useTheme();
  const keys: KeyBinding[] = commonKeys(nav, { help: false });
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active });
  const heading = (text: string) => h(Text, { color: theme.color("text"), bold: theme.bold }, text);
  // Side by side from 110 columns; below, one above the other.
  const half = layout.wide ? { flexGrow: 1, flexBasis: 0 } : {};
  return h(
    Frame,
    { layout, title: "help", keys },
    h(
      Box,
      { flexDirection: layout.wide ? "row" : "column" },
      h(
        Box,
        { flexDirection: "column", ...half, marginRight: 2 },
        heading("Commands (type / on the home screen)"),
        h(
          Box,
          { flexDirection: "column", marginBottom: 1 },
          ...COMMANDS.map((command) =>
            h(Box, { key: command.name }, h(Box, { width: 14, flexShrink: 0 }, h(Text, { color: theme.color("accent") }, `/${command.name}`)), h(Text, { color: theme.color("text"), wrap: "truncate-end" }, command.about, command.comesIn ? h(Text, { color: theme.color("muted") }, ` (ticket ${command.comesIn})`) : null)),
          ),
        ),
      ),
      h(
        Box,
        { flexDirection: "column", ...half },
        heading("On the home screen"),
        h(KeyRows, { rows: allHomeKeys() }),
        heading("In the prompt"),
        h(KeyRows, { rows: PROMPT_EDITING }),
        heading("On every other screen"),
        h(KeyRows, { rows: commonKeys(nav) }),
      ),
    ),
  );
}
