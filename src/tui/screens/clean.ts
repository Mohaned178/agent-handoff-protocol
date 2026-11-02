// `/clean` (spec D10): says which worktrees of ended runs would go and how much space that frees, and removes nothing until
// Enter. A run waiting for a person, one still running, and one whose ledger cannot be read are listed as kept, with the
// reason. Ledgers and snapshots stay. Enter runs the clean again (the plan on screen may be old) and says what it removed.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatClean, type CleanReport } from "../../commands/clean.ts";
import { Frame } from "../components/frame.ts";
import { bodyHeight, LinesView, line, part, scrollKeys, type TextLine } from "../components/lines.ts";
import { Spinner } from "../components/spinner.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import { commonKeys, type Nav } from "../nav.ts";
import { useTheme } from "../theme.ts";

export interface CleanProps {
  layout: Layout;
  /** The clean of this repository; with `dryRun` it removes nothing. */
  clean: (dryRun: boolean) => Promise<CleanReport>;
  nav: Nav;
  active: boolean;
}

type Phase =
  | { state: "planning" }
  | { state: "failed"; message: string }
  | { state: "plan"; report: CleanReport }
  | { state: "removing" }
  | { state: "done"; report: CleanReport };

/** The report as lines: the heading says whether this is what would go or what went, each run's line takes the tone of its outcome. */
export function cleanLines(report: CleanReport, heading: string): TextLine[] {
  const text = formatClean(report);
  const summary = text.at(-1)!;
  const lines = [line("heading", part(heading, "text", true))];
  for (const [index, run] of report.runs.entries()) lines.push(line(`run-${run.runId}`, part(text[index]!, run.outcome === "failed" ? "error" : run.outcome === "kept" ? "muted" : "text")));
  lines.push(line("gap", part(" ")), line("summary", part(summary, report.runs.some((run) => run.outcome === "failed") ? "warn" : "text")));
  if (report.runs.some((run) => run.outcome === "failed")) lines.push(line("failed-note", part("! some worktrees could not be removed: a program may hold a file in one open. Close it and run /clean again.", "warn")));
  return lines;
}

export function Clean({ layout, clean, nav, active }: CleanProps) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({ state: "planning" });
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setPhase({ state: "planning" });
    setOffset(0);
    clean(true).then(
      (report) => live && setPhase({ state: "plan", report }),
      (error: unknown) => live && setPhase({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [active, clean]);

  const removable = phase.state === "plan" && phase.report.runs.some((run) => run.outcome === "removed");
  const remove = () => {
    setPhase({ state: "removing" });
    clean(false).then(
      (report) => (setOffset(0), setPhase({ state: "done", report })),
      (error: unknown) => setPhase({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
  };

  const report = phase.state === "plan" || phase.state === "done" ? phase.report : null;
  const lines = report ? cleanLines(report, phase.state === "plan" ? "These worktrees would be removed (nothing is removed yet):" : "Cleaned:") : [];
  const height = bodyHeight(layout.rows);
  const keys: KeyBinding[] = [
    { keys: "enter", label: "remove them", when: removable, match: is.enter, run: remove },
    ...scrollKeys(lines.length, height, offset, setOffset),
    ...commonKeys(nav),
  ];
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active && phase.state !== "removing" });

  const body =
    phase.state === "planning"
      ? h(Spinner, { label: "looking at the worktrees of this repository's runs" })
      : phase.state === "removing"
        ? h(Spinner, { label: "removing the worktrees" })
        : phase.state === "failed"
          ? h(Text, { color: theme.color("error"), wrap: "wrap" }, `The worktrees could not be cleaned: ${phase.message}`)
          : h(LinesView, { lines, offset, height });
  return h(Frame, { layout, title: "clean", keys }, h(Box, { flexDirection: "column" }, body));
}
