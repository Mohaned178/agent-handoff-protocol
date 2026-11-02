// First open, screen one (spec "First open"): what AHP is in a sentence, and the tools on this machine as `diagnose` found
// them, with the command that installs or logs in the one that is not ready. Nothing needs reading to get through it.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DoctorReport } from "../../doctor/doctor.ts";
import { Frame } from "../components/frame.ts";
import { Spinner } from "../components/spinner.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import type { TaskSources } from "../sources.ts";
import { useTheme } from "../theme.ts";
import { toolRows } from "../welcome-model.ts";

export const LOGO = ["▄▀█ █ █ █▀█", "█▀█ █▀█ █▀▀"] as const;
export const TAGLINE = "Several coding agents, one task, checked before anything lands.";

export function ToolList({ report }: { report: DoctorReport }) {
  const theme = useTheme();
  return h(
    Box,
    { flexDirection: "column" },
    ...toolRows(report).map((row) =>
      h(
        Box,
        { key: row.id },
        h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: theme.color(row.tone) }, row.symbol)),
        h(Box, { width: 14, flexShrink: 0 }, h(Text, { color: theme.color("text") }, row.name)),
        h(Box, { width: 24, flexShrink: 0 }, h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, row.version)),
        h(Box, { flexShrink: 0, marginRight: 2 }, h(Text, { color: theme.color(row.tone === "accent" ? "text" : row.tone) }, row.state)),
        row.fix ? h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, row.fix) : null,
      ),
    ),
  );
}

export interface WelcomeProps {
  layout: Layout;
  sources: TaskSources;
  nav: Nav;
  active: boolean;
  onContinue: () => void;
}

export function Welcome({ layout, sources, nav, active, onContinue }: WelcomeProps) {
  const theme = useTheme();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void sources.tools(reading > 0).then(
      (found) => live && (setReport(found), setProblem(null)),
      (error: unknown) => live && setProblem(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, [active, sources, reading]);

  const keys: KeyBinding[] = [
    { keys: "enter", label: "continue", match: is.enter, run: onContinue },
    { keys: "r", label: "check again", match: is.char("r"), run: () => (setReport(null), setReading((count) => count + 1)) },
    { keys: "q", label: "quit", match: is.char("q"), run: nav.quit },
    { keys: "ctrl+c", label: "quit", footer: false, match: is.ctrl("c"), run: nav.quit },
  ];
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active });

  return h(
    Frame,
    { layout, title: "welcome", keys },
    h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Box, { flexDirection: "column", marginLeft: 2 }, h(Text, { color: theme.color("accent"), bold: theme.bold }, LOGO[0]), h(Text, null, h(Text, { color: theme.color("accent"), bold: theme.bold }, LOGO[1]), h(Text, { color: theme.color("text") }, "   agent handoff"))),
      h(Box, { marginTop: 1, marginLeft: 2 }, h(Text, { color: theme.color("text") }, TAGLINE)),
      h(Box, { marginTop: 1, marginLeft: 2, flexDirection: "column" }, h(Text, { color: theme.color("text"), bold: theme.bold }, "Tools on this machine"), problem ? h(Text, { color: theme.color("error"), wrap: "wrap" }, `The tools could not be checked: ${problem}`) : report === null ? h(Spinner, { label: "looking" }) : h(Box, { marginLeft: 1 }, h(ToolList, { report }))),
    ),
  );
}
