// The folder is not something a run can start from (spec "Empty, error and edge states"): not a repository, no first commit,
// git does not know who the person is, or the home folder. The state is `inspectRepository`'s; Enter makes it ready where
// that is AHP's to do (`git init` and a first commit, as the person), and Esc quits. Nothing is changed before Enter.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { GIT_IDENTITY_COMMANDS, type RepositoryState } from "../../setup/repository.ts";
import { Frame } from "../components/frame.ts";
import { Spinner } from "../components/spinner.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import type { TaskSources } from "../sources.ts";
import { useTheme } from "../theme.ts";

export interface ReadyProps {
  layout: Layout;
  sources: TaskSources;
  nav: Nav;
  active: boolean;
  state: RepositoryState;
  /** The state again, after the person fixed what was wrong or AHP made the repository. */
  onState: (state: RepositoryState) => void;
}

export function Ready({ layout, sources, nav, active, state, onState }: ReadyProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const recheck = () => {
    setBusy(true);
    setProblem(null);
    sources.inspectRepository().then(
      (next) => (setBusy(false), onState(next)),
      (error: unknown) => (setBusy(false), setProblem(error instanceof Error ? error.message : String(error))),
    );
  };
  const make = () => {
    setBusy(true);
    setProblem(null);
    sources
      .prepareRepository(state)
      .then(() => sources.inspectRepository())
      .then(
        (next) => (setBusy(false), onState(next)),
        (error: unknown) => (setBusy(false), setProblem(error instanceof Error ? error.message : String(error))),
      );
  };

  const makeable = state.kind === "not_repository" || state.kind === "no_commit";
  const keys: KeyBinding[] = [
    { keys: "enter", label: state.kind === "not_repository" ? "git init + first commit" : "commit what is in it", when: makeable && !busy, match: is.enter, run: make },
    { keys: "enter", label: "check again", when: state.kind === "no_identity" && !busy, match: is.enter, run: recheck },
    { keys: "esc", label: "quit", match: is.escape, run: nav.quit },
    { keys: "ctrl+c", label: "quit", footer: false, match: is.ctrl("c"), run: nav.quit },
  ];
  useInput((input, key) => void dispatch(keys, input, key), { isActive: active });

  const text = (value: string, tone: "text" | "muted" = "text") => h(Text, { color: theme.color(tone), wrap: "wrap" }, value);
  const lines: ReturnType<typeof h>[] = [];
  switch (state.kind) {
    case "not_repository":
      lines.push(text("This folder isn't a git repository."), text(state.dir, "muted"), text("A run starts from a commit, and the agents see only what is committed."));
      break;
    case "no_commit":
      lines.push(text("This repository has no commit yet."), text(state.repo, "muted"), text("A run starts from a commit, and the agents see only what is committed."));
      break;
    case "no_identity":
      lines.push(text("git does not know who you are, and the first commit is made as you."), text("Tell it, then press enter:"), ...GIT_IDENTITY_COMMANDS.map((command) => h(Text, { key: command, color: theme.color("accent") }, `  ${command}`)));
      break;
    case "home_folder":
      lines.push(text(`${state.dir} is your home folder, not a project.`), text("Run ahp in your project's folder."));
      break;
    case "ready":
      lines.push(text("Ready."));
      break;
  }
  return h(
    Frame,
    { layout, title: "not ready", keys },
    h(Box, { flexDirection: "column", marginTop: 1, marginLeft: 1 }, ...lines, busy ? h(Spinner, { label: "working" }) : null, problem ? h(Text, { color: theme.color("error"), wrap: "wrap" }, problem) : null),
  );
}
