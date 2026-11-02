// The app: the theme, the size check and the router over the screens. Home stays mounted under the others, so the
// prompt's text and history survive a visit to help. Ctrl+C is the screens' (Ink's own exit on it is off).

import { useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { Canvas } from "./components/frame.ts";
import { h } from "./h.ts";
import { dispatch, is, type KeyBinding } from "./keys.ts";
import { layoutOf, TOO_SMALL, type Layout } from "./layout.ts";
import type { Nav } from "./nav.ts";
import { currentScreen, route, startAt, type Screen } from "./router.ts";
import { Help } from "./screens/help.ts";
import { Home, homeSources, type HomeSources } from "./screens/home.ts";
import { Placeholder } from "./screens/placeholder.ts";
import { RunScreen, type RunSources } from "./screens/run.ts";
import { ThemeContext, useTheme, type Theme } from "./theme.ts";

export interface AppProps {
  /** The directory ahp was opened in. */
  cwd: string;
  theme: Theme;
  /** Where home reads from; default the real repository, runs and tools around `cwd`. */
  sources?: HomeSources;
  /** Where the run screen reads from; default the repository around `cwd`, the system clock and this process. */
  runSources?: RunSources;
  start?: Screen;
  /** The run the run screen opens on, when the app starts there. */
  runId?: string;
}

function TooSmall({ layout, quit }: { layout: Layout; quit: () => void }) {
  const theme = useTheme();
  const keys: KeyBinding[] = [{ keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: quit }];
  useInput((input, key) => void dispatch(keys, input, key));
  return h(Canvas, { layout }, h(Box, { paddingX: 1, paddingY: 1 }, h(Text, { color: theme.color("warn"), wrap: "wrap" }, TOO_SMALL)));
}

function Screens({ cwd, sources, runSources, start, runId: startRun }: Omit<AppProps, "theme">) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const layout = layoutOf(columns, rows);
  const [router, setRouter] = useState(() => startAt(start));
  const [runId, setRunId] = useState<string | null>(startRun ?? null);
  const homeFrom = useMemo(() => sources ?? homeSources(cwd), [sources, cwd]);
  const runFrom = useMemo(() => runSources ?? { repo: cwd, now: () => Date.now(), pid: process.pid }, [runSources, cwd]);
  const nav: Nav = useMemo(
    () => ({
      open: (screen) => setRouter((state) => route(state, { type: "open", screen })),
      openRun: (id) => {
        setRunId(id);
        setRouter((state) => route(state, { type: "open", screen: "run" }));
      },
      back: () => setRouter((state) => route(state, { type: "back" })),
      quit: () => exit(),
    }),
    [exit],
  );
  const screen = currentScreen(router);
  const shown = (name: Screen) => layout.fits && screen === name;
  const placeholder = screen !== "home" && screen !== "help" && !(screen === "run" && runId !== null);
  return h(
    Box,
    { flexDirection: "column" },
    layout.fits ? null : h(TooSmall, { layout, quit: nav.quit }),
    h(Box, { display: shown("home") ? "flex" : "none" }, h(Home, { layout, sources: homeFrom, nav, active: shown("home") })),
    screen === "help" ? h(Box, { display: shown("help") ? "flex" : "none" }, h(Help, { layout, nav, active: shown("help") })) : null,
    screen === "run" && runId !== null ? h(Box, { display: shown("run") ? "flex" : "none" }, h(RunScreen, { key: runId, layout, sources: runFrom, runId, nav, active: shown("run") })) : null,
    placeholder ? h(Box, { display: layout.fits ? "flex" : "none" }, h(Placeholder, { layout, nav, screen, active: layout.fits })) : null,
  );
}

export function App({ theme, ...rest }: AppProps) {
  return h(ThemeContext.Provider, { value: theme }, h(Screens, rest));
}
