import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect } from "react";
import { Text, useApp } from "ink";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defineWorkflow, mock, runWorkflow } from "../src/index.ts";
import { App } from "../src/tui/app.ts";
import { Picker } from "../src/tui/components/picker.ts";
import { Spinner, STILL } from "../src/tui/components/spinner.ts";
import { h } from "../src/tui/h.ts";
import { footerKeys } from "../src/tui/keys.ts";
import { TOO_SMALL } from "../src/tui/layout.ts";
import { emptyPrompt } from "../src/tui/prompt-model.ts";
import { homeKeys, homeSources, PLACEHOLDER, type HomeSources } from "../src/tui/screens/home.ts";
import { taskSources, type TaskSources } from "../src/tui/sources.ts";
import { markFirstOpenDone } from "../src/setup/settings.ts";
import { settingsPath } from "../src/runtime/paths.ts";
import { ENTER_ALTERNATE_SCREEN, RESTORE, runFullScreen } from "../src/tui/terminal.ts";
import { ThemeContext, themeFor, themeOf, type Theme } from "../src/tui/theme.ts";
import { gatedWorkflow } from "./helpers/approval.ts";
import { fakeClock } from "./helpers/clock.ts";
import { pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";
import { implemented, implementStep } from "./helpers/review.ts";
import { cellsNotOn, colorAt, FakeStdin, FakeStdout, hasEscapes, renderTui, stripAnsi, type Tui } from "./helpers/tui.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const LONG_NAME = "a-workflow-whose-name-goes-on-far-longer-than-any-terminal-column-would-hold-it";

let repo: string;
let sources: HomeSources;
let emptyRepo: string;
let emptySources: HomeSources;
let tasks!: TaskSources;

beforeAll(async () => {
  const env = await pathWithoutTools();
  // These tests are about home, not the first-open screens.
  await markFirstOpenDone(settingsPath());
  repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  // Oldest first, two hours apart, so each is listed "Nh ago" from NOW.
  await runWorkflow(retryWorkflow([hello]), { repo, clock: fakeClock("2026-01-01T02:00:00.000Z") });
  await runWorkflow(defineWorkflow({ name: LONG_NAME, steps: [{ id: "implement", agent: mock({ attempts: [goodbye] }), verification: { command: "node verify.mjs" }, retry: { budget: 0 } }] }), { repo, clock: fakeClock("2026-01-01T04:00:00.000Z") });
  // The retry has no script: its outcome is unknown, and the run waits for a person in needs_recovery.
  await runWorkflow(retryWorkflow([goodbye]), { repo, clock: fakeClock("2026-01-01T06:00:00.000Z") });
  await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock("2026-01-01T08:00:00.000Z") });
  // A ledger whose hash chain is broken.
  const broken = join(repo, ".git", "ahp", "runs", "run_broken0");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "ledger.jsonl"), '{"seq":0,"type":"run_created","prevHash":null,"hash":"bad"}\n');
  sources = { ...homeSources(repo, env), now: () => NOW };
  // The task flow reads the same PATH: the real claude, codex and opencode never run in a test.
  tasks = taskSources(repo, env);
  emptyRepo = createTempRepo({ "README.md": "hi\n" });
  emptySources = { ...homeSources(emptyRepo, env), now: () => NOW };
}, 120_000);

afterAll(removeTempRepos);

const open: Tui[] = [];
afterEach(() => {
  for (const tui of open.splice(0)) tui.unmount();
});

const TRUECOLOR = themeFor("truecolor");

function app(options: { theme?: Theme; columns?: number; rows?: number; sources?: HomeSources } = {}): Tui {
  const tui = renderTui(h(App, { cwd: repo, theme: options.theme ?? TRUECOLOR, sources: options.sources ?? sources, task: tasks }), { columns: options.columns ?? 120, rows: options.rows ?? 32 });
  open.push(tui);
  return tui;
}

/** Home, once the runs and the tools have been read. */
async function home(options: Parameters<typeof app>[0] = {}): Promise<Tui> {
  const tui = app(options);
  await tui.waitFor((frame) => frame.includes("Recent") && frame.includes("no coding tool is usable here"));
  return tui;
}

const lines = (frame: string) => frame.split("\n");
const footerOf = (frame: string) => lines(frame).filter((line) => line.trim() !== "").at(-1)!;

describe("the home screen", () => {
  it("shows the repository and branch, the runs waiting for you, the recent runs and who plays each step", async () => {
    const tui = await home();
    const frame = tui.frame();
    expect(lines(frame)[0]).toMatch(/^ AHP {2}ahp-test-\S+ · main +\? help $/);

    const waiting = frame.slice(frame.indexOf("Waiting for you"), frame.indexOf("Recent"));
    expect(waiting).toMatch(/! gated .*4h ago .*waiting for your approval at approve · mock/);
    expect(waiting).toMatch(/! retry .*6h ago .*needs recovery at implement: an attempt's outcome is unknown · mock/);

    const recent = frame.slice(frame.indexOf("Recent"));
    // From 110 columns the name column is 32 wide; a longer name is cut with "…".
    expect(recent).toMatch(/✗ a-workflow-whose-name-goes-on-f… +8h ago +implement: node verify\.mjs failed · mock/);
    expect(recent).toMatch(/✓ retry .*10h ago .*verified · mock/);
    expect(recent).toMatch(/✗ run_broken0 .*cannot be read: /);
    // Newest first.
    expect(recent.indexOf("✗ a-workflow")).toBeLessThan(recent.indexOf("✓ retry"));

    expect(frame).toContain(PLACEHOLDER);
    // No tool on this PATH: the status says so, and does not show the scripted mock as if it were the casting.
    expect(footerOf(frame)).toMatch(/^ no coding tool is usable here: a task offers the scripted mock /);
  });

  it("colours a state only where it carries meaning: ✓ green, ✗ red, ! amber, the caret green", async () => {
    const tui = await home();
    const raw = tui.raw();
    expect(colorAt(raw, "✓ retry")).toContain("accent");
    expect(colorAt(raw, "✗ a-workflow")).toContain("error");
    expect(colorAt(raw, "! gated")).toContain("warn");
    expect(colorAt(raw, "Waiting for you")).toContain("warn");
    expect(colorAt(raw, "❯ ")).toContain("accent");
    expect(colorAt(raw, "AHP")).toContain("accent");
  });

  it("paints the black background on every cell, the prompt's border included", async () => {
    const tui = await home();
    const frame = tui.frame();
    expect(frame).toContain("╭");
    expect(cellsNotOn(tui.raw(), "bg")).toEqual([]);
  });

  it("uses the 256-colour fallback when the terminal has no truecolor", async () => {
    const tui = await home({ theme: themeOf({}, true) });
    expect(tui.raw()).toContain("38;5;41");
    expect(tui.raw()).not.toContain("38;2;");
    expect(colorAt(tui.raw(), "✓ retry")).toContain("accent");
  });

  it("writes no escape code at all under NO_COLOR, and the symbols still carry the meaning", async () => {
    const tui = await home({ theme: themeOf({ NO_COLOR: "1", COLORTERM: "truecolor" }, true) });
    await tui.type("/");
    await tui.waitFor("/help");
    for (const write of tui.stdout.writes) expect(hasEscapes(write)).toBe(false);
    expect(tui.frame()).toContain("❯ /model");
    expect(tui.frame()).toContain("▏");
  });

  it("says there are no runs yet in a repository without any", async () => {
    const tui = app({ sources: emptySources });
    await tui.waitFor("No runs here yet. Describe a task below to start one.");
  });

  it("answers a task with its summary, and esc brings the task back into the prompt", async () => {
    const tui = await home();
    await tui.type("fix the failing login test");
    expect(tui.frame()).toContain("fix the failing login test");
    await tui.press("enter");
    // No coding tool on this PATH: the summary says so and offers the scripted mock. Nothing has run.
    const frame = await tui.waitFor("No coding tool is usable here");
    expect(frame).toContain("fix the failing login test");
    await tui.press("escape");
    await tui.waitFor("Recent");
    expect(tui.frame()).toContain("❯ fix the failing login test");
  });
});

describe("the command menu", () => {
  it("opens on /, narrows as you type, and Enter runs /help", async () => {
    const tui = await home();
    await tui.type("/");
    let frame = tui.frame();
    for (const name of ["/model", "/effort", "/runs", "/clean", "/help", "/quit"]) expect(frame).toContain(name);
    await tui.type("he");
    frame = tui.frame();
    expect(frame).toContain("❯ /help");
    expect(frame).toContain("/check");
    expect(frame).not.toContain("/model");
    await tui.press("enter");
    frame = await tui.waitFor("Commands (type / on the home screen)");
    expect(lines(frame)[0]).toMatch(/^ AHP {2}help/);
    await tui.press("escape");
    frame = await tui.waitFor("Recent");
    expect(frame).toContain(PLACEHOLDER);
  });

  it("moves with ↑↓, closes with Esc, and says when a command is not built yet or does not exist", async () => {
    const tui = await home();
    await tui.type("/");
    await tui.press("down");
    expect(tui.frame()).toContain("❯ /effort");
    await tui.press("enter");
    // /effort with no step is not a guess: it says how to write it.
    expect(tui.frame()).toContain("usage: /effort <step> <level>");
    // ...and waits in the prompt for those words (ticket 10); esc clears it.
    expect(tui.frame()).toContain("❯ /effort ");
    await tui.press("escape");
    await tui.type("/mock");
    await tui.press("enter");
    expect(tui.frame()).toContain("No command /mock: type / to see them.");
    await tui.type("/");
    await tui.press("escape");
    expect(tui.frame()).not.toContain("❯ /effort");
    expect(tui.frame()).toContain(PLACEHOLDER);
    await tui.type("/nothing");
    expect(tui.frame()).toContain("no command matches");
    await tui.press("enter");
    expect(tui.frame()).toContain("No command /nothing: type / to see them.");
    expect(colorAt(tui.raw(), "No command")).toContain("error");
  });

  it("opens /runs, and Esc comes back to home", async () => {
    const tui = await home();
    await tui.type("/runs");
    await tui.press("enter");
    await tui.waitFor("type to filter");
    await tui.press("escape");
    await tui.waitFor("Recent");
  });
});

/** A task entered and left again: its summary opens, Esc comes back with the text in the prompt, and clearing it keeps it in the history. */
async function entered(tui: Tui, text: string) {
  await tui.type(text);
  await tui.press("enter");
  await tui.waitFor("No coding tool is usable here");
  await tui.press("escape");
  await tui.waitFor("Recent");
  expect(tui.frame()).toContain(`❯ ${text}`);
  await tui.press("ctrl+c");
}

describe("the prompt", () => {
  it("keeps what was submitted, and ↑↓ bring it back while the prompt is empty", async () => {
    const tui = await home();
    await entered(tui, "first task");
    await entered(tui, "second task");
    await tui.press("up");
    expect(tui.frame()).toContain("❯ second task");
    await tui.press("up");
    expect(tui.frame()).toContain("❯ first task");
    await tui.press("down");
    expect(tui.frame()).toContain("❯ second task");
    await tui.press("down");
    expect(tui.frame()).toContain(PLACEHOLDER);
  });

  it("keeps its history across a visit to help", async () => {
    const tui = await home();
    await entered(tui, "a task");
    await tui.type("?");
    await tui.waitFor("Commands (type / on the home screen)");
    await tui.press("escape");
    await tui.waitFor("Recent");
    await tui.press("up");
    expect(tui.frame()).toContain("❯ a task");
  });

  it("takes a paste of several lines, and `\\` then Enter for a new line, without submitting", async () => {
    const tui = await home();
    await tui.paste("line one\r\nline two");
    let frame = tui.frame();
    expect(frame).toMatch(/❯ line one/);
    expect(frame).toMatch(/│ {3}line two/);
    expect(frame).not.toContain("No coding tool is usable here");
    await tui.type("\\");
    await tui.press("enter");
    await tui.type("line three");
    frame = tui.frame();
    expect(frame).toMatch(/│ {3}line three/);
    expect(frame).not.toContain("No coding tool is usable here");
  });

  it("edits: backspace, and moving the cursor to type in the middle", async () => {
    const tui = await home();
    await tui.type("fix tst");
    await tui.press("left", "left");
    await tui.type("e");
    await tui.press("end", "backspace");
    expect(tui.frame()).toContain("❯ fix tes");
  });
});

describe("the footer", () => {
  const nothing = () => {};
  const nav = { open: nothing, openRun: nothing, back: nothing, quit: nothing };
  const shown = (frame: string) => footerOf(frame);
  const expected = (value: string) =>
    footerKeys(homeKeys({ prompt: { ...emptyPrompt(), value, cursor: value.length }, menu: value.startsWith("/") ? [] : null, selected: 0, edit: nothing, select: nothing, runCommand: nothing, submit: nothing, nav }))
      .map((binding) => `${binding.keys} ${binding.label}`)
      .join("  ");

  it("lists the keys of home's table, and each one does what it says", async () => {
    const tui = await home();
    expect(shown(tui.frame()).endsWith(`${expected("")} `)).toBe(true);
    expect(expected("")).toBe("/ commands  ? help  ctrl+c quit");

    await tui.type("/");
    expect(shown(tui.frame())).toContain("enter run command  ↑↓ move  esc close");
    await tui.press("escape");

    await tui.type("?");
    await tui.waitFor("Commands (type / on the home screen)");
    expect(shown(tui.frame()).trim()).toBe("esc back  ctrl+c quit");
    await tui.press("escape");
    await tui.waitFor("Recent");

    await tui.type("some words");
    expect(shown(tui.frame()).endsWith(`${expected("some words")} `)).toBe(true);
    expect(expected("some words")).toBe("enter run task  esc clear  ctrl+c clear");
    await tui.press("ctrl+c");
    expect(tui.frame()).toContain(PLACEHOLDER);
    expect(tui.exited()).toBe(false);

    await tui.press("ctrl+c");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tui.exited()).toBe(true);
  });

  it("does nothing for a key the table does not hold", async () => {
    const tui = await home();
    const before = tui.frame();
    await tui.press("ctrl+s");
    expect(tui.frame()).toBe(before);
  });
});

describe("the terminal's size", () => {
  it("cuts every line to the width with … and keeps the frame within 80×20", async () => {
    const tui = await home({ columns: 80, rows: 20 });
    const frame = tui.frame();
    expect(lines(frame).length).toBeLessThanOrEqual(20);
    for (const line of lines(frame)) expect([...line].length).toBeLessThanOrEqual(80);
    expect(frame).toContain("a-workflow-whose-name-g…");
  });

  it("folds help's two columns below 110 columns", async () => {
    const wide = await home({ columns: 120, rows: 40 });
    await wide.type("?");
    let frame = await wide.waitFor("Commands (type / on the home screen)");
    expect(lines(frame).some((line) => line.includes("Commands (type /") && line.includes("On the home screen"))).toBe(true);
    const narrow = await home({ columns: 100, rows: 40 });
    await narrow.type("?");
    frame = await narrow.waitFor("Commands (type / on the home screen)");
    expect(lines(frame).some((line) => line.includes("Commands (type /") && line.includes("On the home screen"))).toBe(false);
    expect(frame).toContain("On the home screen");
  });

  it("refuses below 80×20 and comes back, prompt and all, when the terminal grows", async () => {
    const tui = await home();
    await tui.type("half a task");
    await tui.resize(79, 30);
    let frame = tui.frame();
    expect(frame).toContain(TOO_SMALL);
    expect(frame).not.toContain("Recent");
    await tui.resize(100, 19);
    expect(tui.frame()).toContain(TOO_SMALL);
    await tui.resize(100, 30);
    frame = await tui.waitFor("Recent");
    expect(frame).toContain("❯ half a task");
  });
});

describe("the parts", () => {
  const themed = (theme: Theme, node: ReturnType<typeof h>) => h(ThemeContext.Provider, { value: theme }, node);

  it("the spinner turns, and stands still under AHP_NO_ANIMATION=1", async () => {
    const turning = renderTui(themed(themeOf({}, true), h(Spinner, { label: "working" })));
    open.push(turning);
    const first = turning.frame();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(turning.frame()).not.toBe(first);

    const still = renderTui(themed(themeOf({ AHP_NO_ANIMATION: "1" }, true), h(Spinner, { label: "working" })));
    open.push(still);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(still.frame()).toContain(`${STILL} working`);
    expect(new Set(still.stdout.writes).size).toBe(1);
  });

  it("the picker moves with ↑↓, narrows as you type, chooses with Enter and cancels with Esc", async () => {
    const chosen: string[] = [];
    let cancelled = 0;
    const items = ["opus", "sonnet", "haiku"].map((label) => ({ label, value: label, hint: label === "opus" ? "the tool's default" : undefined }));
    const tui = renderTui(themed(TRUECOLOR, h(Picker<string>, { items, onSelect: (item) => chosen.push(item.value), onCancel: () => cancelled++ })));
    open.push(tui);
    expect(tui.frame()).toContain("❯ opus  the tool's default");
    await tui.press("down");
    expect(tui.frame()).toContain("❯ sonnet");
    await tui.press("enter");
    await tui.type("hai");
    expect(tui.frame()).toContain("filter: hai");
    expect(tui.frame()).not.toContain("sonnet");
    await tui.press("enter");
    await tui.press("backspace", "backspace", "backspace");
    expect(tui.frame()).toContain("sonnet");
    await tui.press("escape");
    expect(chosen).toEqual(["sonnet", "haiku"]);
    expect(cancelled).toBe(1);
  });
});

describe("the alternate screen", () => {
  const io = () => {
    const stdout = new FakeStdout(100, 30, true);
    const stderr = new FakeStdout(100, 30);
    return { stdout, stderr, stdin: new FakeStdin(), signals: new EventEmitter(), exits: [] as number[] };
  };
  const run = (node: ReturnType<typeof h>, given: ReturnType<typeof io>) =>
    runFullScreen(node, { stdout: given.stdout as never, stderr: given.stderr as never, stdin: given.stdin as never, signals: given.signals, exit: (code) => given.exits.push(code) });

  function Quits() {
    const { exit } = useApp();
    useEffect(() => void setTimeout(() => exit(), 20), [exit]);
    return h(Text, null, "bye");
  }
  function Throws(): never {
    throw new Error("a screen broke");
  }

  it("is entered first and left last on a normal quit", async () => {
    const given = io();
    expect(await run(h(Quits), given)).toBe(0);
    const written = given.stdout.written();
    expect(written.startsWith(ENTER_ALTERNATE_SCREEN)).toBe(true);
    expect(written.endsWith(RESTORE)).toBe(true);
  });

  it("is left, with the cursor shown, after a thrown error, which is then printed", async () => {
    const given = io();
    expect(await run(h(Throws), given)).toBe(1);
    const written = given.stdout.written();
    expect(written.startsWith(ENTER_ALTERNATE_SCREEN)).toBe(true);
    expect(written.endsWith(RESTORE)).toBe(true);
    expect(stripAnsi(given.stderr.written())).toContain("ahp: Error: a screen broke");
  });

  it("is left on a signal, and the process ends with the signal's code", async () => {
    const given = io();
    const running = run(h(Text, null, "waiting"), given);
    await new Promise((resolve) => setTimeout(resolve, 50));
    given.signals.emit("SIGTERM", "SIGTERM");
    await running;
    expect(given.stdout.written().endsWith(RESTORE)).toBe(true);
    expect(given.exits).toEqual([143]);
  });
});

describe("plain `ahp` without a terminal", () => {
  it("prints the usage instead of opening the app", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url))], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage");
  });

  it("answers `ahp setup`, `settings` and `init` with where they went", () => {
    for (const command of ["setup", "settings", "init"]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url)), command], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`\`ahp ${command}\` has moved into the app: run \`ahp\``);
    }
  });
});
