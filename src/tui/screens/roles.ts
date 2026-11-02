// First open, screen two (spec "First open"): who plays each step. Enter keeps AHP's casting and goes on; ↑↓ or Tab picks a
// step and Enter then changes it (tool, model, effort). What is saved, once, is the steps the person changed: the casting AHP
// worked out is recomputed from the tools found, and is never called "your default". With no usable tool this screen says
// what to install and offers the scripted mock, which every screen after it marks as one.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DoctorReport } from "../../doctor/doctor.ts";
import { ROLES, type Role, type RoleAssignment } from "../../doctor/init.ts";
import { TOOLS } from "../../doctor/tools.ts";
import { castRoles, YOUR_DEFAULT, type RoleDefaults } from "../../setup/infer.ts";
import type { OpenCodeAccess } from "../../setup/models.ts";
import { Frame } from "../components/frame.ts";
import { Spinner } from "../components/spinner.ts";
import { useStepChoice } from "../components/step-choice.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import type { TaskSources } from "../sources.ts";
import { defaultOf } from "../step-choice-model.ts";
import { playerOf } from "../summary-model.ts";
import { useTheme } from "../theme.ts";
import { anyUsable } from "../welcome-model.ts";

export interface RolesProps {
  layout: Layout;
  sources: TaskSources;
  nav: Nav;
  active: boolean;
  access: readonly OpenCodeAccess[] | null;
  setAccess: (access: readonly OpenCodeAccess[]) => void;
  /** Save the steps changed here, mark the first open done, and go on; `mock` when the scripted mock was chosen instead. */
  onFinish: (chosen: RoleDefaults, mock: boolean) => Promise<void>;
}

/** Install and log-in commands of every tool, for a machine where none can play a step. */
export function NoToolLines({ report }: { report: DoctorReport }) {
  const theme = useTheme();
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.color("warn"), wrap: "wrap" }, "No coding tool is usable here. Install one and log in with your own account:"),
    ...TOOLS.map((tool) => {
      const found = report.tools.find((candidate) => candidate.id === tool.id);
      return h(
        Box,
        { key: tool.id },
        h(Box, { width: 14, flexShrink: 0 }, h(Text, { color: theme.color("text") }, tool.name)),
        h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, found?.installed ? tool.logIn : `${tool.install}, then ${tool.logIn}`),
      );
    }),
  );
}

export function Roles({ layout, sources, nav, active, access, setAccess, onFinish }: RolesProps) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<{ report: DoctorReport; base: RoleAssignment[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [changed, setChanged] = useState<Partial<Record<Role, RoleAssignment>>>({});
  const [selected, setSelected] = useState<Role | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (chosen: RoleDefaults, mock: boolean) => {
    setProblem(null);
    onFinish(chosen, mock).catch((error: unknown) => setProblem(`your choices could not be saved: ${error instanceof Error ? error.message : String(error)}`));
  };

  useEffect(() => {
    if (!active) return;
    let live = true;
    void sources.cast().then(
      (cast) => live && setLoaded({ report: cast.report, base: cast.base }),
      (error: unknown) => live && setFailed(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, [active, sources]);

  const choosing = useStepChoice({
    report: loaded?.report ?? null,
    models: sources.models,
    access,
    setAccess,
    askKeep: false,
    reason: YOUR_DEFAULT,
    isActive: active,
    onDone: (assignment) => setChanged((current) => ({ ...current, [assignment.role]: assignment })),
  });

  const casting = loaded ? ROLES.map((role) => changed[role] ?? loaded.base.find((assignment) => assignment.role === role)!) : [];
  const noTool = loaded !== null && !anyUsable(loaded.report);
  const finish = () => {
    const chosen: RoleDefaults = {};
    for (const role of ROLES) {
      const step = changed[role];
      const kept = step ? defaultOf(step) : null;
      if (kept) chosen[role] = kept;
    }
    submit(chosen, false);
  };
  const pick = (by: 1 | -1) => setSelected((current) => ROLES[(current === null ? (by === 1 ? 0 : ROLES.length - 1) : ROLES.indexOf(current) + by + ROLES.length) % ROLES.length]!);

  const keys: KeyBinding[] = choosing.active
    ? choosing.keys
    : [
        { keys: "↑↓", label: "pick", when: loaded !== null && !noTool, match: is.upOrDown, run: (_, key) => pick(key.upArrow ? -1 : 1) },
        { keys: "tab", label: "next", when: loaded !== null && !noTool, match: is.tab, run: () => pick(1) },
        { keys: "enter", label: "change", when: selected !== null, match: is.enter, run: () => choosing.start(selected!) },
        { keys: "enter", label: "continue", when: loaded !== null && selected === null && !noTool, match: is.enter, run: finish },
        { keys: "ctrl+s", label: "save and start", when: loaded !== null && !noTool, match: is.ctrl("s"), run: finish },
        { keys: "m", label: "try it on the mock", when: noTool, match: is.char("m"), run: () => submit({}, true) },
        { keys: "esc", label: "unpick", when: selected !== null, match: is.escape, run: () => setSelected(null) },
        { keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: nav.quit },
      ];
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active && !choosing.active });

  const body = [];
  if (failed) body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "wrap" }, `The tools could not be checked: ${failed}`));
  else if (loaded === null) body.push(h(Spinner, { key: "loading", label: "looking at the tools on this machine" }));
  else if (choosing.active) body.push(h(Box, { key: "choice", flexDirection: "column" }, choosing.view));
  else {
    body.push(h(Text, { key: "heading", color: theme.color("text"), bold: theme.bold }, "Who does what?  ", h(Text, { color: theme.color("muted") }, "(you can change this any time with /model)")));
    for (const assignment of casting) {
      const on = selected === assignment.role;
      body.push(
        h(
          Box,
          { key: assignment.role, marginLeft: 1, backgroundColor: on ? theme.color("surface") : undefined },
          h(Text, { color: theme.color("accent") }, on ? "❯ " : "  "),
          h(Box, { width: 11, flexShrink: 0 }, h(Text, { color: theme.color(on ? "accent" : "text") }, assignment.role)),
          h(Text, { color: theme.color("text"), wrap: "truncate-end" }, playerOf(assignment)),
          changed[assignment.role] ? h(Text, { color: theme.color("muted") }, "  changed") : null,
        ),
      );
    }
    if (noTool) body.push(h(Box, { key: "none", marginTop: 1 }, h(NoToolLines, { report: loaded.report })));
  }
  if (problem) body.push(h(Text, { key: "problem", color: theme.color("error"), wrap: "wrap" }, problem));
  return h(Frame, { layout, title: "who does what", keys }, h(Box, { flexDirection: "column", marginTop: 1 }, ...body));
}
