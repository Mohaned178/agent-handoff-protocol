// `/settings` (spec D7): each step's saved default, the tool, model and effort the person chose and kept, or "automatic".
// Enter changes the picked step with the same picker the summary uses and saves at once; `x` forgets the picked step's
// default, `X` all of them after a yes. The first-open flag and the notices stay: forgetting defaults never brings the
// welcome screens back. A broken entry in the file is shown and left out.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DoctorReport } from "../../doctor/doctor.ts";
import { ROLES, type Role } from "../../doctor/init.ts";
import { castRoles, YOUR_DEFAULT } from "../../setup/infer.ts";
import type { OpenCodeAccess } from "../../setup/models.ts";
import type { SettingsRead } from "../../setup/settings.ts";
import { Frame } from "../components/frame.ts";
import { Spinner } from "../components/spinner.ts";
import { useStepChoice } from "../components/step-choice.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import { AUTOMATIC, settingsModel } from "../settings-model.ts";
import type { TaskSources } from "../sources.ts";
import { defaultOf } from "../step-choice-model.ts";
import { useTheme } from "../theme.ts";

export interface SettingsProps {
  layout: Layout;
  sources: TaskSources;
  nav: Nav;
  active: boolean;
  access: readonly OpenCodeAccess[] | null;
  setAccess: (access: readonly OpenCodeAccess[]) => void;
}

export const CLEAR_ALL_QUESTION = "Forget every saved default? Each step goes back to automatic.";

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; read: SettingsRead };

export function Settings({ layout, sources, nav, active, access, setAccess }: SettingsProps) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    sources.settings().then(
      (read) => live && setLoaded({ state: "ready", read }),
      (error: unknown) => live && setLoaded({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    // The tools are needed to offer the choice; the screen is usable while they are read.
    sources.tools().then(
      (found) => live && setReport(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [active, sources, round]);

  const written = (action: Promise<void>, failure: string) =>
    action.then(
      () => setProblem(null),
      (error: unknown) => setProblem(`${failure}: ${error instanceof Error ? error.message : String(error)}`),
    ).finally(() => setRound((current) => current + 1));

  const choosing = useStepChoice({
    report,
    models: sources.models,
    access,
    setAccess,
    askKeep: false,
    reason: YOUR_DEFAULT,
    isActive: active && !confirming,
    onDone: (assignment) => {
      const chosen = defaultOf(assignment);
      if (chosen) void written(sources.saveDefault(assignment.role, chosen), "your default could not be saved");
    },
  });

  const model = loaded.state === "ready" ? settingsModel(loaded.read, report ? castRoles(report) : null) : null;
  const role: Role = ROLES[cursor]!;
  const savedHere = model?.rows.find((row) => row.role === role)?.saved != null;
  const anySaved = model?.rows.some((row) => row.saved !== null) === true;
  const move = (by: number) => setCursor((current) => (current + by + ROLES.length) % ROLES.length);

  let keys: KeyBinding[];
  if (choosing.active) keys = choosing.keys;
  else if (confirming) {
    keys = [
      { keys: "y", label: "forget all", match: is.char("y"), run: () => (setConfirming(false), void written(sources.clearDefaults(), "the defaults could not be cleared")) },
      { keys: "n", label: "keep them", match: is.char("n"), run: () => setConfirming(false) },
      { keys: "esc", label: "keep them", footer: false, match: is.escape, run: () => setConfirming(false) },
    ];
  } else {
    keys = [
      { keys: "↑↓", label: "pick", when: model !== null, match: is.upOrDown, run: (_, key) => move(key.upArrow ? -1 : 1) },
      { keys: "enter", label: "change", when: model !== null && report !== null, match: is.enter, run: () => choosing.start(role) },
      { keys: "x", label: "forget this one", when: savedHere, match: is.char("x"), run: () => void written(sources.clearDefault(role), "the default could not be cleared") },
      { keys: "X", label: "forget all", when: anySaved, match: is.char("X"), run: () => setConfirming(true) },
      { keys: "esc", label: "back", match: is.escape, run: nav.back },
      { keys: "?", label: "help", footer: false, match: is.char("?"), run: () => nav.open("help") },
      { keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: nav.quit },
    ];
  }
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active && !choosing.active });

  const body: ReturnType<typeof h>[] = [];
  if (loaded.state === "loading") body.push(h(Spinner, { key: "loading", label: "reading your defaults" }));
  else if (loaded.state === "failed") body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "wrap" }, `The settings could not be read: ${loaded.message}`));
  else if (choosing.active) body.push(h(Box, { key: "choice", flexDirection: "column" }, choosing.view));
  else if (model) {
    body.push(h(Text, { key: "heading", color: theme.color("text"), bold: theme.bold }, "Your defaults  ", h(Text, { color: theme.color("muted") }, "(used by every new task unless you change a step for one run)")));
    for (const [index, row] of model.rows.entries()) {
      const on = index === cursor;
      body.push(
        h(
          Box,
          { key: row.role, marginLeft: 1, backgroundColor: on ? theme.color("surface") : undefined },
          h(Text, { color: theme.color("accent") }, on ? "❯ " : "  "),
          h(Box, { width: 11, flexShrink: 0 }, h(Text, { color: theme.color(on ? "accent" : "text") }, row.role)),
          h(Text, { color: theme.color(row.saved ? "text" : "muted"), wrap: "truncate-end" }, row.text),
        ),
      );
    }
    body.push(h(Text, { key: "automatic", color: theme.color("muted"), wrap: "truncate-end" }, `${AUTOMATIC}: AHP casts the step from the tools found here each time.`));
    if (model.problem) body.push(h(Text, { key: "left-out", color: theme.color("warn"), wrap: "wrap" }, `! left out: ${model.problem}`));
    if (confirming) body.push(h(Text, { key: "confirm", color: theme.color("warn") }, `${CLEAR_ALL_QUESTION}  y / n`));
  }
  if (problem) body.push(h(Text, { key: "problem", color: theme.color("error"), wrap: "wrap" }, problem));
  return h(Frame, { layout, title: "settings", keys }, h(Box, { flexDirection: "column", marginTop: 1 }, ...body));
}
