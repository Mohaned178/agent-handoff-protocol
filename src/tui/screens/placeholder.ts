// A screen the router knows and a later ticket builds: it says which one, and its keys work.

import { Text, useInput } from "ink";
import { Frame } from "../components/frame.ts";
import { h } from "../h.ts";
import { dispatch } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { commonKeys, type Nav } from "../nav.ts";
import type { Screen } from "../router.ts";
import { useTheme } from "../theme.ts";

/** The ticket of `.scratch/new-terminal-ui/` that builds each screen not built yet. */
export const BUILT_IN: Readonly<Partial<Record<Screen, string>>> = { runs: "07", tools: "07", settings: "07" };

/** The run screen with no run chosen: a task started here opens its own; until /runs (ticket 07), the dev entry opens an older one. */
export const NO_RUN_OPEN = "No run is open: describe a task on the home screen to start one (from ticket 07 /runs lists the others), or `node src/tui/dev.ts <run-id>` opens one.";

export function Placeholder({ layout, nav, screen, active }: { layout: Layout; nav: Nav; screen: Screen; active: boolean }) {
  const theme = useTheme();
  const keys = commonKeys(nav);
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active });
  const text = screen === "run" ? NO_RUN_OPEN : `This screen comes in ticket ${BUILT_IN[screen] ?? "?"}.`;
  return h(Frame, { layout, title: screen, keys }, h(Text, { color: theme.color("muted"), wrap: "wrap" }, text));
}
