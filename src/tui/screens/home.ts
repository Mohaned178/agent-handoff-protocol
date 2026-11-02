// Home (spec "Home: the prompt"): the repository and branch, the runs waiting for you, the recent runs, the prompt, and
// who plays each step by default. A view over files the runtime owns: the runs are `listRuns`' reading of their
// ledgers, read again each time home comes back on screen. Running a task comes in ticket 05.

import { basename } from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, Text, usePaste, useInput } from "ink";
import type { RoleAssignment } from "../../doctor/init.ts";
import { diagnose, type DoctorReport } from "../../doctor/doctor.ts";
import { git } from "../../runtime/git.ts";
import { locateRepo, settingsPath } from "../../runtime/paths.ts";
import { listRuns, type RunListing } from "../../sdk/run.ts";
import { castRoles } from "../../setup/infer.ts";
import { readSettings } from "../../setup/settings.ts";
import { applySlash, type TaskSession } from "../../commands/task.ts";
import { COMMANDS, commandQuery, filterByName, parseSlash, RUN_COMMANDS, type SlashCommand } from "../commands.ts";
import type { TaskSources } from "../sources.ts";
import type { ActiveRun } from "../task-runner.ts";
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
import { homeModel, statusOf, type HomeRow } from "./home-model.ts";

export const PLACEHOLDER = 'describe a task, e.g. "fix the failing login test"';
export const RUN_GOING = "A run is going in this window: enter opens it, ctrl+c cancels it from there.";

/** Where home reads what it shows. Tests give their own environment (a PATH with no coding tool). */
export interface HomeSources {
  /** The repository's name and branch, or null outside a git repository. */
  where: () => Promise<{ name: string; branch: string } | null>;
  runs: () => Promise<RunListing[]>;
  /** Who plays each step: the tools found here, with the saved defaults on top. */
  roles: () => Promise<RoleAssignment[]>;
  now: () => number;
}

export function homeSources(cwd: string, env: NodeJS.ProcessEnv = process.env, tools?: () => Promise<DoctorReport>): HomeSources {
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
      const [report, saved] = await Promise.all([tools ? tools() : diagnose({ env }), readSettings(settingsPath())]);
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
  /** Whether a run started in this window is going, and the key that opens its screen. */
  running?: boolean;
  openRun?: () => void;
}

/** Home's keys: what the footer shows and what the input handler dispatches through. Typing goes to the prompt. */
export function homeKeys(context: HomeKeyContext): KeyBinding[] {
  const { prompt, menu, selected, edit, nav } = context;
  const typed = prompt.value !== "";
  const menuOpen = menu !== null;
  return [
    { keys: "enter", label: "run command", when: menuOpen, match: is.enter, run: () => context.runCommand(menu?.[selected] ?? null) },
    { keys: "enter", label: "run task", when: !menuOpen && typed, match: is.enter, run: context.submit },
    { keys: "enter", label: "open the run", when: !menuOpen && !typed && context.running === true, match: is.enter, run: () => context.openRun?.() },
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
  const nav: Nav = { open: nothing, openRun: nothing, back: nothing, quit: nothing };
  const context = (value: string, history: string[]): HomeKeyContext => {
    const query = commandQuery(value);
    return { prompt: { ...emptyPrompt(history), value, cursor: value.length }, menu: query === null ? null : filterByName(COMMANDS, (command) => command.name, query), selected: 0, edit: nothing, select: nothing, runCommand: nothing, submit: nothing, nav };
  };
  const seen = new Map<string, KeyBinding>();
  for (const keys of [homeKeys({ ...context("", ["a task"]), running: true }), homeKeys(context("", ["a task"])), homeKeys(context("a task", [])), homeKeys(context("/", []))]) {
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
  task: TaskSources;
  /** What the person changed for the next run (`/model`, `/plan`...), and the mock if chosen. */
  session: TaskSession;
  setSession: (change: (session: TaskSession) => TaskSession) => void;
  /** The run started in this window, going or ended. */
  running: ActiveRun | null;
  /** A task was entered: the app shows its summary. */
  onTask: (task: string) => void;
  /** Puts a task back in the prompt (esc on its summary); `id` tells one request from the last. */
  prefill: { id: number; text: string } | null;
}

export function Home({ layout, sources, nav, active, task, session, setSession, running, onTask, prefill }: HomeProps) {
  const theme = useTheme();
  const [prompt, setPrompt] = useState<PromptState>(emptyPrompt());
  const lastPrefill = useRef(0);
  useEffect(() => {
    if (prefill === null || prefill.id === lastPrefill.current) return;
    lastPrefill.current = prefill.id;
    setPrompt((current) => editPrompt(current, { type: "set", value: prefill.text }).state);
  }, [prefill]);
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
    // Read again when the run started here ends or stops for a person: it then belongs in the lists.
  }, [active, sources, running?.phase]);
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
  const going = running !== null && running.phase !== "ended";
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  /** `/model`, `/effort`, `/plan`, `/check` and `/push`: change the next run, and say so. */
  const changeNextRun = (name: string, argument: string) => {
    void (async () => {
      let outcome: ReturnType<typeof applySlash>;
      try {
        const { report, base } = await task.cast();
        outcome = applySlash(name, argument, { session, base, report, remotes: name === "push" ? await task.remotes() : [] });
      } catch (error) {
        outcome = { ok: false, error: `/${name} could not be checked: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!alive.current) return;
      if (outcome.ok) setSession(() => outcome.session);
      setNotice(outcome.ok ? { text: outcome.notice, tone: "text" } : { text: outcome.error, tone: "error" });
    })();
  };
  const runNamed = (command: SlashCommand, argument: string) => {
    setNotice(null);
    if (command.name === "help") return nav.open("help");
    if (command.name === "quit") return nav.quit();
    if (command.name === "runs" || command.name === "tools" || command.name === "settings") return nav.open(command.name);
    if ((RUN_COMMANDS as readonly string[]).includes(command.name)) return changeNextRun(command.name, argument);
    setNotice({ text: `/${command.name} comes in ticket ${command.comesIn}.`, tone: "muted" });
  };
  const runCommand = (command: SlashCommand | null) => {
    setPrompt(editPrompt(prompt, { type: "clear" }).state);
    if (command === null) return setNotice({ text: `No command ${prompt.value}: type / to see them.`, tone: "error" });
    runNamed(command, "");
  };
  const submit = () => {
    const result = editPrompt(prompt, { type: "enter" });
    setPrompt(result.state);
    const line = result.submitted;
    if (line === null) return;
    const slash = line.startsWith("/") ? parseSlash(line) : null;
    if (slash !== null) {
      const command = COMMANDS.find((candidate) => candidate.name === slash.name);
      if (!command) return setNotice({ text: `No command /${slash.name}: type / to see them.`, tone: "error" });
      return runNamed(command, slash.argument);
    }
    if (going) return setNotice({ text: RUN_GOING, tone: "warn" });
    setNotice(null);
    onTask(line);
  };
  const openRunning = () => running?.runId != null && nav.openRun(running.runId);
  const keys = homeKeys({ prompt, menu, selected: chosen, edit, select: setSelected, runCommand, submit, nav, running: going && running?.runId != null, openRun: openRunning });

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
  const status = roles.state === "loading" ? "checking the tools on this machine…" : roles.state === "failed" ? `the tools could not be checked: ${roles.message}` : statusOf(roles.value, session);

  const body: ReturnType<typeof h>[] = [];
  if (running && running.phase !== "ended") {
    body.push(
      h(
        Box,
        { key: "running" },
        h(Spinner, null),
        h(Text, { color: theme.color("text"), wrap: "truncate-end" }, `  ${running.phase === "cancelling" ? "cancelling" : "running"}  ${running.runId === null ? "starting" : `run ${running.runId.replace(/^run_/, "")}`}  ${running.name}${running.mock ? " · mock" : ""}`),
        running.runId !== null ? h(Text, { color: theme.color("muted") }, "   enter opens it") : null,
      ),
    );
    body.push(h(Text, { key: "running-gap" }, " "));
  } else if (running?.error) body.push(h(Text, { key: "run-error", color: theme.color("error"), wrap: "truncate-end" }, `The last run stopped: ${running.error}`));
  if (notice) body.push(h(Text, { key: "notice", color: theme.color(notice.tone), wrap: "truncate-end" }, notice.text));
  if (runs.state === "loading") body.push(h(Spinner, { key: "loading", label: "reading the runs" }));
  else if (runs.state === "failed") body.push(h(Text, { key: "failed", color: theme.color("error"), wrap: "truncate-end" }, `The runs could not be listed: ${runs.message}`));
  else {
    // The run going in this window is shown once, at the top.
    const model = homeModel(going && running?.runId ? runs.value.filter((listing) => listing.runId !== running.runId) : runs.value, sources.now());
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
