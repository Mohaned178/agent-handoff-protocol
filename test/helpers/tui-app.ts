// The whole app over fake tools and a temporary repository, for the first-open and task-flow tests: nothing here runs a real
// claude, codex or opencode, and the settings file is the temporary AHP_HOME's.

import { rmSync } from "node:fs";
import { h } from "../../src/tui/h.ts";
import { App } from "../../src/tui/app.ts";
import { settingsPath } from "../../src/runtime/paths.ts";
import { homeSources } from "../../src/tui/screens/home.ts";
import { taskSources, type TaskSources } from "../../src/tui/sources.ts";
import type { TaskRunner } from "../../src/tui/task-runner.ts";
import { themeFor } from "../../src/tui/theme.ts";
import { fakeToolsDir, installFakeTool, pathWithFakes, pathWithoutTools } from "./fake-tools.ts";
import { renderTui, type Tui } from "./tui.ts";

export type FakeState = "ready" | "logged_out" | "missing";
export interface FakeTools {
  claude?: FakeState;
  codex?: FakeState;
  opencode?: FakeState;
  /** What `opencode models` prints, one per line. */
  models?: string[];
}

/** A PATH holding git and the fake tools as stated; a tool not named is not installed. */
export async function toolsEnv(tools: FakeTools): Promise<NodeJS.ProcessEnv> {
  if ((tools.claude ?? "missing") === "missing" && (tools.codex ?? "missing") === "missing" && (tools.opencode ?? "missing") === "missing") return pathWithoutTools();
  const { dir, log } = fakeToolsDir();
  if (tools.claude && tools.claude !== "missing") {
    installFakeTool(dir, log, "claude", `if (argv[0] === "--version") console.log("2.1.311 (Claude Code)"); else console.log(JSON.stringify({ loggedIn: ${tools.claude === "ready"} }));`);
  }
  if (tools.codex && tools.codex !== "missing") {
    installFakeTool(dir, log, "codex", `if (argv[0] === "--version") console.log("codex-cli 0.146.0"); else process.exitCode = ${tools.codex === "ready" ? 0 : 1};`);
  }
  if (tools.opencode && tools.opencode !== "missing") {
    installFakeTool(dir, log, "opencode", `if (argv[0] === "--version") console.log("1.2.3"); else if (argv[0] === "models") console.log(${JSON.stringify((tools.models ?? []).join("\n"))});`);
  }
  return pathWithFakes(dir);
}

export interface OpenedApp {
  tui: Tui;
  tasks: TaskSources;
}

const opened: Tui[] = [];

/** Closes every app opened with `openApp`: call from `afterEach`. */
export function closeApps(): void {
  for (const tui of opened.splice(0)) tui.unmount();
}

/** Forgets the saved settings, as on a machine where ahp was never opened. */
export const forgetSettings = (): void => rmSync(settingsPath(), { force: true });

export function openApp(options: { repo: string; env: NodeJS.ProcessEnv; startTask?: string; runner?: TaskRunner; columns?: number; rows?: number; now?: () => number; tasks?: (given: TaskSources) => TaskSources }): OpenedApp {
  const given = taskSources(options.repo, options.env);
  const tasks = options.tasks ? options.tasks(given) : given;
  const sources = { ...homeSources(options.repo, options.env, tasks.tools), ...(options.now ? { now: options.now } : {}) };
  const tui = renderTui(h(App, { cwd: options.repo, theme: themeFor("truecolor"), sources, task: tasks, ...(options.startTask !== undefined ? { startTask: options.startTask } : {}), ...(options.runner ? { runner: options.runner } : {}) }), { columns: options.columns ?? 120, rows: options.rows ?? 34 });
  opened.push(tui);
  return { tui, tasks };
}
