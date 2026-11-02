// The app: the theme, the size check and the router over the screens. Home stays mounted under the others, so the prompt's
// text and history survive a visit to help. Ctrl+C is the screens' (Ink's own exit on it is off). The app also holds what
// outlives a screen: what the person changed for the next run, OpenCode's access once asked, and the run started in this
// window, which `esc` leaves going and which quitting or cancelling must stop through its signal.

import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { cleanRuns } from "../commands/clean.ts";
import { afterRun, freshSession, type TaskSession } from "../commands/task.ts";
import type { RoleDefaults } from "../setup/infer.ts";
import type { OpenCodeAccess } from "../setup/models.ts";
import type { RepositoryState } from "../setup/repository.ts";
import { buildTaskRun } from "../setup/task.ts";
import { Canvas } from "./components/frame.ts";
import { h } from "./h.ts";
import { dispatch, is, type KeyBinding } from "./keys.ts";
import { layoutOf, TOO_SMALL, type Layout } from "./layout.ts";
import type { Nav } from "./nav.ts";
import { currentScreen, route, startAt, type Screen } from "./router.ts";
import { CANCEL_QUESTION, Confirm, QUIT_QUESTION } from "./screens/confirm.ts";
import { Help } from "./screens/help.ts";
import { Home, homeSources, type HomeSources } from "./screens/home.ts";
import { Placeholder } from "./screens/placeholder.ts";
import { Clean } from "./screens/clean.ts";
import { Ready } from "./screens/ready.ts";
import { Roles } from "./screens/roles.ts";
import { RunScreen, type RunSources } from "./screens/run.ts";
import { Runs } from "./screens/runs.ts";
import { Settings } from "./screens/settings.ts";
import { Summary } from "./screens/summary.ts";
import { Tools } from "./screens/tools.ts";
import { Welcome } from "./screens/welcome.ts";
import { taskSources, type TaskSources } from "./sources.ts";
import { TaskRunner } from "./task-runner.ts";
import { ThemeContext, useTheme, type Theme } from "./theme.ts";
import { useRunner } from "./use-runner.ts";

export interface AppProps {
  /** The directory ahp was opened in. */
  cwd: string;
  theme: Theme;
  /** Where home reads from; default the real repository, runs and tools around `cwd`. */
  sources?: HomeSources;
  /** Where the run screen reads from; default the repository around `cwd`, the system clock and this process. */
  runSources?: RunSources;
  /** What the task flow reads and writes; default the real tools, settings and repository around `cwd`. */
  task?: TaskSources;
  /** The run started in this window; default a new one. `dev.ts` gives its own so a signal can stop the run too. */
  runner?: TaskRunner;
  start?: Screen;
  /** The run the run screen opens on, when the app starts there. */
  runId?: string;
  /** `ahp "<task>"` on a terminal: the task the summary opens on once the first-open and readiness checks pass (else it waits in the prompt). */
  startTask?: string;
}

function TooSmall({ layout, quit }: { layout: Layout; quit: () => void }) {
  const theme = useTheme();
  const keys: KeyBinding[] = [{ keys: "ctrl+c", label: "quit", match: is.ctrl("c"), run: quit }];
  useInput((input, key) => void dispatch(keys, input, key));
  return h(Canvas, { layout }, h(Box, { paddingX: 1, paddingY: 1 }, h(Text, { color: theme.color("warn"), wrap: "wrap" }, TOO_SMALL)));
}

type Confirming = "cancel" | "quit" | "quitting" | null;

function Screens({ cwd, sources, runSources, task, runner, start, runId: startRun, startTask }: Omit<AppProps, "theme">) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const layout = layoutOf(columns, rows);
  const taskFrom = useMemo(() => task ?? taskSources(cwd), [task, cwd]);
  const homeFrom = useMemo(() => sources ?? homeSources(cwd, process.env, taskFrom.tools), [sources, cwd, taskFrom]);
  const runFrom = useMemo(() => runSources ?? { repo: cwd, now: () => Date.now(), pid: process.pid }, [runSources, cwd]);
  const started = useMemo(() => runner ?? new TaskRunner(), [runner]);
  const running = useRunner(started);

  // Opened on a screen by name (a test, `dev.ts <run-id>`): no first-open screens, no readiness check.
  const [router, setRouter] = useState(() => startAt(start));
  const [booted, setBooted] = useState(start !== undefined);
  const [repository, setRepository] = useState<RepositoryState | null>(null);
  const [runId, setRunId] = useState<string | null>(startRun ?? null);
  const [session, setSession] = useState<TaskSession>(freshSession());
  const [access, setAccess] = useState<readonly OpenCodeAccess[] | null>(null);
  const [asked, setAsked] = useState<{ text: string; nonce: number } | null>(null);
  // A task given on the command line that the summary could not open on (first open or a repository to fix comes first) waits in the prompt.
  const [prefill, setPrefill] = useState<{ id: number; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirming>(null);

  useEffect(() => {
    if (booted) return;
    let live = true;
    taskFrom.boot().then(
      ({ firstOpenDone, repository: found }) => {
        if (!live) return;
        setRepository(found);
        const first = !firstOpenDone ? "welcome" : found.kind === "ready" ? "home" : "ready";
        if (startTask !== undefined && first === "home") {
          setAsked({ text: startTask, nonce: 1 });
          setRouter(startAt("summary"));
        } else {
          if (startTask !== undefined) setPrefill({ id: 1, text: startTask });
          setRouter(startAt(first));
        }
        setBooted(true);
      },
      () => live && setBooted(true),
    );
    return () => {
      live = false;
    };
  }, [booted, taskFrom]);

  const nav: Nav = useMemo(
    () => ({
      open: (screen) => setRouter((state) => route(state, { type: "open", screen })),
      openRun: (id) => {
        setRunId(id);
        setRouter((state) => route(state, { type: "open", screen: "run", replace: currentScreen(state) === "summary" }));
      },
      back: () => setRouter((state) => route(state, { type: "back" })),
      // A run going in this window is stopped first, through its signal, and only then does ahp go.
      quit: () => (started.going() ? setConfirm("quit") : exit()),
    }),
    [exit, started],
  );

  const screen = currentScreen(router);
  const covered = confirm !== null;
  const shown = (name: Screen) => layout.fits && !covered && screen === name;
  const inStack = (name: Screen) => router.stack.includes(name);
  const owns = running !== null && running.phase !== "ended" && running.runId !== null && running.runId === runId;
  const placeholder = screen === "run" && runId === null;
  const clean = useMemo(() => (dryRun: boolean) => cleanRuns({ repo: runFrom.repo, dryRun }), [runFrom]);

  const finishFirstOpen = async (chosen: RoleDefaults, mock: boolean) => {
    await taskFrom.finishFirstOpen(chosen);
    if (mock) setSession((current) => ({ ...current, mock: true }));
    setRouter(startAt(repository === null || repository.kind === "ready" ? "home" : "ready"));
  };
  const answerCancel = (yes: boolean) => {
    if (yes) started.cancel();
    setConfirm(null);
  };
  const answerQuit = (yes: boolean) => {
    if (!yes) return setConfirm(null);
    started.cancel();
    setConfirm("quitting");
    const leave = () => exit();
    started.settled().then(leave, leave);
  };

  if (!booted) return h(Canvas, { layout }, h(Box, { paddingX: 1 }, h(Text, null, " ")));
  return h(
    Box,
    { flexDirection: "column" },
    layout.fits ? null : h(TooSmall, { layout, quit: nav.quit }),
    h(
      Box,
      { display: shown("home") ? "flex" : "none" },
      h(Home, {
        layout,
        sources: homeFrom,
        nav,
        active: shown("home"),
        task: taskFrom,
        session,
        setSession,
        running,
        prefill,
        onTask: (text) => {
          setAsked((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));
          nav.open("summary");
        },
      }),
    ),
    screen === "help" ? h(Box, { display: shown("help") ? "flex" : "none" }, h(Help, { layout, nav, active: shown("help") })) : null,
    inStack("welcome") ? h(Box, { display: shown("welcome") ? "flex" : "none" }, h(Welcome, { layout, sources: taskFrom, nav, active: shown("welcome"), onContinue: () => nav.open("roles") })) : null,
    inStack("roles") ? h(Box, { display: shown("roles") ? "flex" : "none" }, h(Roles, { layout, sources: taskFrom, nav, active: shown("roles"), access, setAccess, onFinish: finishFirstOpen })) : null,
    inStack("ready") && repository !== null
      ? h(
          Box,
          { display: shown("ready") ? "flex" : "none" },
          h(Ready, {
            layout,
            sources: taskFrom,
            nav,
            active: shown("ready"),
            state: repository,
            onState: (next) => {
              setRepository(next);
              if (next.kind === "ready") setRouter(startAt("home"));
            },
          }),
        )
      : null,
    inStack("summary") && asked !== null
      ? h(
          Box,
          { key: asked.nonce, display: shown("summary") ? "flex" : "none" },
          h(Summary, {
            layout,
            sources: taskFrom,
            runner: started,
            nav,
            active: shown("summary"),
            task: asked.text,
            session,
            setSession,
            access,
            setAccess,
            onStart: (run, context, mock) => {
              started.start({ workflow: buildTaskRun(run), repo: context.repo, mock });
              setSession(afterRun);
              if (!mock && context.settings.settings.realAgentsNoticed !== true) void taskFrom.noticedRealAgents().catch(() => undefined);
            },
            onEdit: () => {
              setPrefill((current) => ({ id: (current?.id ?? 0) + 1, text: asked.text }));
              nav.back();
            },
          }),
        )
      : null,
    screen === "run" && runId !== null
      ? h(Box, { display: shown("run") ? "flex" : "none" }, h(RunScreen, { key: runId, layout, sources: runFrom, runId, nav, active: shown("run"), cancel: owns ? () => setConfirm("cancel") : undefined, running, decide: (spec) => started.decide({ repo: runFrom.repo, ...spec }) }))
      : null,
    screen === "runs" ? h(Box, { display: shown("runs") ? "flex" : "none" }, h(Runs, { layout, sources: homeFrom, nav, active: shown("runs") })) : null,
    screen === "tools" ? h(Box, { display: shown("tools") ? "flex" : "none" }, h(Tools, { layout, tools: taskFrom.tools, nav, active: shown("tools") })) : null,
    screen === "settings" ? h(Box, { display: shown("settings") ? "flex" : "none" }, h(Settings, { layout, sources: taskFrom, nav, active: shown("settings"), access, setAccess })) : null,
    screen === "clean" ? h(Box, { display: shown("clean") ? "flex" : "none" }, h(Clean, { layout, clean, nav, active: shown("clean") })) : null,
    placeholder ? h(Box, { display: layout.fits && !covered ? "flex" : "none" }, h(Placeholder, { layout, nav, screen, active: layout.fits && !covered })) : null,
    confirm !== null
      ? h(Confirm, {
          layout,
          title: confirm === "cancel" ? "cancel the run" : "quit",
          question: confirm === "cancel" ? CANCEL_QUESTION : QUIT_QUESTION,
          waiting: confirm === "quitting",
          active: layout.fits,
          yes: confirm === "cancel" ? () => answerCancel(true) : () => answerQuit(true),
          no: confirm === "cancel" ? () => answerCancel(false) : () => answerQuit(false),
        })
      : null,
  );
}

export function App({ theme, ...rest }: AppProps) {
  return h(ThemeContext.Provider, { value: theme }, h(Screens, rest));
}
