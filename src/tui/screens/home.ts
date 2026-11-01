// Home (spec "Home: the prompt"): the repository and branch, the runs waiting for you, the recent runs, the prompt, and
// who plays each step by default. A view over files the runtime owns: the runs are `listRuns`' reading of their
// ledgers, read again each time home comes back on screen. Running a task comes in ticket 05.

import { basename } from "node:path";
import { useEffect, useState } from "react";
import { Box, Text, usePaste, useInput } from "ink";
import type { RoleAssignment } from "../../doctor/init.ts";
import { diagnose } from "../../doctor/doctor.ts";
import { git } from "../../runtime/git.ts";
import { locateRepo, settingsPath } from "../../runtime/paths.ts";
import { listRuns, type RunListing } from "../../sdk/run.ts";
import { castRoles } from "../../setup/infer.ts";
import { readSettings } from "../../setup/settings.ts";
import { COMMANDS, commandQuery, filterByName, type SlashCommand } from "../commands.ts";
import { CommandMenu } from "../components/command-menu.ts";
import { Frame } from "../components/frame.ts";
import { Prompt } from "../components/prompt.ts";
import { Spinner } from "../components/spinner.ts";
import { h } from "../h.ts";
import { dispatch, is, type KeyBinding } from "../keys.ts";
import type { Layout } from "../layout.ts";
import type { Nav } from "../nav.ts";
import { browsingHistory, editPrompt, emptyPrompt, type PromptAction, type PromptState } from "../prompt-model.ts";
import { useTheme, type Token } from "../theme.ts";
import { homeModel, rolesLine, type HomeRow } from "./home-model.ts";

export const PLACEHOLDER = 'describe a task, e.g. "fix the failing login test"';
export const TASKS_LATER = "Running a task comes in ticket 05: for now, `ahp \"<task>\"` runs one.";

/** Where home reads what it shows. Tests give their own environment (a PATH with no coding tool). */
export interface HomeSources {
  /** The repository's name and branch, or null outside a git repository. */
  where: () => Promise<{ name: string; branch: string } | null>;
  runs: () => Promise<RunListing[]>;
  /** Who plays each step: the tools found here, with the saved defaults on top. */
  roles: () => Promise<RoleAssignment[]>;
  now: () => number;
}

export function homeSources(cwd: string, env: NodeJS.ProcessEnv = process.env): HomeSources {
  return {
    where: async () => {
      let repo: string;
      try {
        repo = (await locateRepo(cwd)).repo;
      } catch {
        return null;
      }
      const branch = (await git(cwd, ["branch", "--show-current"]).catch(() => "")) || `detached at ${await git(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => "?")}`;
      return { name: basename(repo), branch };
    },
    runs: async () => {
      try {
        await locateRepo(cwd);
      } catch {
        return [];
      }
      return listRuns({ repo: cwd });
    },
    roles: async () => {
      const [report, saved] = await Promise.all([diagnose({ env }), readSettings(settingsPath())]);
      return castRoles(report, saved.settings.steps);
    },
    now: () => Date.now(),
  };
}

type Loaded<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; message: string };

const settle = <T>(promise: Promise<T>, set: (loaded: Loaded<T>) => void, live: () => boolean) =>
  promise.then(
    (value) => live() && set({ state: "ready", value }),
    (error: unknown) => live() && set({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
  );

export interface HomeKeyContext {
  prompt: PromptState;
  /** The commands matching what is typed after `/`, or null when no command is being typed. */
  menu: readonly SlashCommand[] | null;
  selected: number;
  edit: (action: PromptAction) => void;
  select: (index: number) => void;
  runCommand: (command: SlashCommand | null) => void;
  submit: () => void;
  nav: Nav;
}

/** Home's keys: what the footer shows and what the input handler dispatches through. Typing goes to the prompt. */
export function homeKeys(context: HomeKeyContext): KeyBinding[] {
  const { prompt, menu, selected, edit, nav } = context;
  const typed = prompt.value !== "";
  const menuOpen = menu !== null;
  return [
    { keys: "enter", label: "run command", when: menuOpen, match: is.enter, run: () => context.runCommand(menu?.[selected] ?? null) },
    { keys: "enter", label: "run task", when: !menuOpen && typed, match: is.enter, run: context.submit },
    { keys: "↑↓", label: "move", when: menuOpen, match: is.upOrDown, run: (_, key) => context.select(Math.max(0, Math.min((menu?.length ?? 1) - 1, selected + (key.upArrow ? -1 : 1)))) },
    { keys: "↑↓", label: "history", when: !menuOpen && browsingHistory(prompt), match: is.upOrDown, run: (_, key) => edit({ type: key.upArrow ? "up" : "down" }) },
    { keys: "esc", label: "close", when: menuOpen, match: is.escape, run: () => edit({ type: "clear" }) },
    { keys: "esc", label: "clear", when: !menuOpen && typed, match: is.escape, run: () => edit({ type: "clear" }) },
    { keys: "/", label: "commands", when: !typed, match: is.char("/"), run: () => edit({ type: "insert", text: "/" }) },
    { keys: "?", label: "help", when: !typed, match: is.char("?"), run: () => nav.open("help") },
    { keys: "ctrl+c", label: "clear", when: typed, match: is.ctrl("c"), run: () => edit({ type: "clear" }) },
    { keys: "ctrl+c", label: "quit", when: !typed, match: is.ctrl("c"), run: nav.quit },
  ];
}

/** Every key home has, in any state, once each: what the help screen lists. Read from `homeKeys` itself. */
export function allHomeKeys(): KeyBinding[] {
  const nothing = () => {};
  const nav: Nav = { open: nothing, back: nothing, quit: nothing };
  const context = (value: string, history: string[]): HomeKeyContext => {
    const query = commandQuery(value);
    return { prompt: { ...emptyPrompt(history), value, cursor: value.length }, menu: query === null ? null : filterByName(COMMANDS, (command) => command.name, query), selected: 0, edit: nothing, select: nothing, runCommand: nothing, submit: nothing, nav };
  };
  const seen = new Map<string, KeyBinding>();
  for (const keys of [homeKeys(context("", ["a task"])), homeKeys(context("a task", [])), homeKeys(context("/", []))]) {
    for (const binding of keys) if (binding.when !== false && !seen.has(`${binding.keys} ${binding.label}`)) seen.set(`${binding.keys} ${binding.label}`, binding);
  }
  return [...seen.values()];
}

function RunRow({ row, layout }: { row: HomeRow; layout: Layout }) {
  const theme = useTheme();
  return h(
    Box,
    null,
    h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: theme.color(row.tone) }, row.symbol)),
    h(Box, { width: layout.wide ? 32 : 24, flexShrink: 0, marginRight: 2 }, h(Text, { color: theme.color("text"), wrap: "truncate-end" }, row.title)),
    h(Box, { width: 10, flexShrink: 0 }, h(Text, { color: theme.color("muted") }, row.when)),
    h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, { color: theme.color("muted"), wrap: "truncate-end" }, row.detail)),
  );
}

function Heading({ text, tone }: { text: string; tone: Token }) {
  const theme = useTheme();
  return h(Text, { color: theme.color(tone), bold: theme.bold }, text);
}

export interface HomeProps {
  layout: Layout;
  sources: HomeSources;
  nav: Nav;
  /** False while another screen is on top: no input, and the runs are read again when home comes back. */
  active: boolean;
}

export function Home({ layout, sources, nav, active }: HomeProps) {
  const theme = useTheme();
  const [prompt, setPrompt] = useState<PromptState>(emptyPrompt());
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<{ text: string; tone: Token } | null>(null);
  const [where, setWhere] = useState<Loaded<{ name: string; branch: string } | null>>({ state: "loading" });
  const [runs, setRuns] = useState<Loaded<RunListing[]>>({ state: "loading" });
  const [roles, setRoles] = useState<Loaded<RoleAssignment[]>>({ state: "loading" });

  useEffect(() => {
    if (!active) return;
    let live = true;
    void settle(sources.where(), setWhere, () => live);
    void settle(sources.runs(), setRuns, () => live);
    return () => {
      live = false;
    };
  }, [active, sources]);
  useEffect(() => {
    let live = true;
    void settle(sources.roles(), setRoles, () => live);
    return () => {
      live = false;
    };
  }, [sources]);

  const query = commandQuery(prompt.value);
  const menu = query === null ? null : filterByName(COMMANDS, (command) => command.name, query);
  const chosen = menu === null ? 0 : Math.min(selected, Math.max(0, menu.length - 1));

  const edit = (action: PromptAction) => {
    const result = editPrompt(prompt, action);
    setPrompt(result.state);
    if (result.state.value !== prompt.value) setSelected(0);
  };
  const runCommand = (command: SlashCommand | null) => {
    setPrompt(editPrompt(prompt, { type: "clear" }).state);
    if (command === null) return setNotice({ text: `No command ${prompt.value}: type / to see them.`, tone: "error" });
    setNotice(null);
    if (command.name === "help") return nav.open("help");
    if (command.name === "quit") return nav.quit();
    if (command.name === "runs" || command.name === "tools" || command.name === "settings") return nav.open(command.name);
    setNotice({ text: `/${command.name} comes in ticket ${command.comesIn}.`, tone: "muted" });
  };
  const submit = () => {
    const result = editPrompt(prompt, { type: "enter" });
    setPrompt(result.state);
    if (result.submitted !== null) setNotice({ text: TASKS_LATER, tone: "muted" });
  };
  const keys = homeKeys({ prompt, menu, selected: chosen, edit, select: setSelected, runCommand, submit, nav });

  useInput(
    (input, key) => {
      if (dispatch(keys, input, key)) return;
      if (key.backspace) return edit({ type: "backspace" });
      if (key.delete) return edit({ type: "delete" });
      if (key.leftArrow) return edit({ type: "left" });
      if (key.rightArrow) return edit({ type: "right" });
      if (key.home) return edit({ type: "home" });
      if (key.end) return edit({ type: "end" });
      if (key.ctrl || key.meta || key.escape || key.tab || key.return || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
      if (input !== "") edit({ type: "insert", text: input });
    },
    { isActive: active },
  );
  usePaste((text) => edit({ type: "insert", text }), { isActive: active });

  const title = where.state === "loading" ? "" : where.state === "failed" ? where.message : where.value === null ? "not a git repository" : `${where.value.name} · ${where.value.branch}`;
  const status = roles.state === "loading" ? "checking the tools on this machine…" : roles.state === "failed" ? `the tools could not be checked: ${roles.message}` : rolesLine(roles.value);

  const body: ReturnType<typeof h>[] = [];
  if (notice) body.push(h(Text, { key: "notice", color: theme.color(notice.tone), wrap: "truncate-end" }, notice.text));
  if (runs.state === "loading") body.push(h(Spinner, { key: "loading", label: "reading the runs" }));
  else if (runs.state === "failed") body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "truncate-end" }, `The runs could not be listed: ${runs.message}`));
  else {
    const model = homeModel(runs.value, sources.now());
    if (model.waiting.length > 0) {
      body.push(h(Heading, { key: "waiting", text: "Waiting for you", tone: "warn" }));
      for (const row of model.waiting) body.push(h(RunRow, { key: `w-${row.runId}`, row, layout }));
      body.push(h(Text, { key: "gap" }, " "));
    }
    if (model.recent.length > 0) {
      body.push(h(Heading, { key: "recent", text: "Recent", tone: "text" }));
      for (const row of model.recent) body.push(h(RunRow, { key: `r-${row.runId}`, row, layout }));
      if (model.older > 0) body.push(h(Text, { key: "older", color: theme.color("muted") }, `${model.older} older ${model.older === 1 ? "run" : "runs"}: /runs lists them`));
    } else if (model.waiting.length === 0) {
      body.push(h(Text, { key: "empty", color: theme.color("muted") }, "No runs here yet. Describe a task below to start one."));
    }
  }

  return h(
    Frame,
    { layout, title, right: "? help", keys, status },
    h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden" }, ...body),
    menu !== null ? h(CommandMenu, { commands: menu, selected: chosen, height: Math.min(COMMANDS.length, Math.max(3, layout.rows - 14)) }) : null,
    h(Prompt, { state: prompt, placeholder: PLACEHOLDER, focused: active }),
  );
}
