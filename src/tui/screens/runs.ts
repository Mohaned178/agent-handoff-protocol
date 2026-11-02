// `/runs` (spec D7): every run of the repository, newest first, with its state, the workflow's name, age, outcome and the usage
// per tool in one line. Typing narrows the list; Enter opens the run's screen. A view over what `listRuns` reads from the
// ledgers, read again each time the screen comes up; a run whose ledger cannot be read is listed with its problem and is not
// opened.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RunListing } from "../../sdk/run.ts";
import { windowStart } from "../components/command-menu.ts";
import { Frame } from "../components/frame.ts";
import { Spinner } from "../components/spinner.ts";
import { filterText } from "../components/picker.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import { filterRuns, runsModel, type RunsRow } from "../runs-model.ts";
import { useTheme, type Token } from "../theme.ts";

export interface RunsSources {
  runs: () => Promise<RunListing[]>;
  now: () => number;
}

export interface RunsProps {
  layout: Layout;
  sources: RunsSources;
  nav: Nav;
  active: boolean;
}

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; rows: RunsRow[] };

/** Rows that fit: each run takes two lines (the run, then its usage). */
export const visibleRuns = (layout: Layout): number => Math.max(2, Math.floor((layout.rows - 7) / 2));

export function Runs({ layout, sources, nav, active }: RunsProps) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    sources.runs().then(
      (listings) => live && setLoaded({ state: "ready", rows: runsModel(listings, sources.now()) }),
      (error: unknown) => live && setLoaded({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [active, sources]);

  const rows = loaded.state === "ready" ? filterRuns(loaded.rows, query) : [];
  const at = Math.min(selected, Math.max(0, rows.length - 1));
  const typed = query !== "";
  const change = (next: string) => {
    setQuery(next);
    setSelected(0);
    setNotice(null);
  };
  const open = () => {
    const row = rows[at];
    if (!row) return;
    if (!row.openable) return setNotice(`${row.runId} cannot be opened: ${row.detail}`);
    nav.openRun(row.runId);
  };
  const move = (by: number) => {
    setSelected(Math.max(0, Math.min(rows.length - 1, at + by)));
    setNotice(null);
  };
  const keys: KeyBinding[] = [
    { keys: "enter", label: "open", when: rows.length > 0, match: is.enter, run: open },
    { keys: "↑↓", label: "move", when: rows.length > 1, match: is.upOrDown, run: (_, key) => move(key.upArrow ? -1 : 1) },
    { keys: "esc", label: "clear the filter", when: typed, match: is.escape, run: () => change("") },
    { keys: "esc", label: "back", when: !typed, match: is.escape, run: nav.back },
    { keys: "?", label: "help", when: !typed, match: is.char("?"), run: () => nav.open("help") },
    { keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: nav.quit },
  ];
  useInput(
    (input, key) => {
      if (dispatch(keys, input, key)) return;
      if ((key.backspace || key.delete) && typed) return change(query.slice(0, -1));
      const letter = filterText(input, key);
      if (letter !== null && !key.return && !key.escape && !key.tab) change(query + letter);
    },
    { isActive: active },
  );

  const height = visibleRuns(layout);
  const first = windowStart(rows.length, at, height);
  const body: ReturnType<typeof h>[] = [];
  if (loaded.state === "loading") body.push(h(Spinner, { key: "loading", label: "reading the runs" }));
  else if (loaded.state === "failed") body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "wrap" }, `The runs could not be listed: ${loaded.message}`));
  else {
    body.push(h(Text, { key: "filter", color: theme.color("muted"), wrap: "truncate-end" }, typed ? `filter: ${query}   ${rows.length} of ${loaded.rows.length} runs` : loaded.rows.length === 0 ? "type to filter" : `type to filter   ${loaded.rows.length} ${loaded.rows.length === 1 ? "run" : "runs"}`));
    if (loaded.rows.length === 0) body.push(h(Text, { key: "none", color: theme.color("muted") }, "No runs here yet. Describe a task on the home screen to start one."));
    else if (rows.length === 0) body.push(h(Text, { key: "nomatch", color: theme.color("muted") }, "nothing matches"));
    for (const [offset, row] of rows.slice(first, first + height).entries()) {
      const on = first + offset === at;
      body.push(
        h(
          Box,
          { key: row.runId, flexDirection: "column" },
          h(
            Box,
            { backgroundColor: on ? theme.color("surface") : undefined },
            h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: theme.color("accent") }, on ? "›" : " ")),
            h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: theme.color(row.tone as Token) }, row.symbol)),
            h(Box, { width: layout.wide ? 32 : 24, flexShrink: 0, marginRight: 2 }, h(Text, { color: theme.color("text"), wrap: "truncate-end" }, row.title)),
            h(Box, { width: 10, flexShrink: 0 }, h(Text, { color: theme.color("muted") }, row.when)),
            h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, row.detail)),
          ),
          h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, `      ${row.usage === "" ? "no attempt ran" : `usage: ${row.usage}`}`),
        ),
      );
    }
  }
  if (notice) body.push(h(Text, { key: "notice", color: theme.color("error"), wrap: "truncate-end" }, notice));
  return h(Frame, { layout, title: "runs", keys }, h(Box, { flexDirection: "column" }, ...body));
}
