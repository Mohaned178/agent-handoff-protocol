import { describe, expect, it } from "vitest";
import { commandQuery, COMMANDS, filterByName } from "../src/tui/commands.ts";
import { windowStart } from "../src/tui/components/command-menu.ts";
import { activeKeys, dispatch, footerKeys, is, type KeyBinding } from "../src/tui/keys.ts";
import { layoutOf } from "../src/tui/layout.ts";
import { browsingHistory, editPrompt, emptyPrompt, type PromptAction, type PromptState } from "../src/tui/prompt-model.ts";
import { currentScreen, route, startAt } from "../src/tui/router.ts";
import { ago, homeModel, rolesLine } from "../src/tui/screens/home-model.ts";
import { colorModeOf, PALETTE, themeFor, themeOf } from "../src/tui/theme.ts";

describe("the colour mode", () => {
  it.each([
    [{}, true, "ansi256"],
    [{ COLORTERM: "truecolor" }, true, "truecolor"],
    [{ COLORTERM: "24bit" }, true, "truecolor"],
    [{ WT_SESSION: "abc" }, true, "truecolor"],
    [{ COLORTERM: "truecolor" }, false, "none"],
    [{ COLORTERM: "truecolor", NO_COLOR: "1" }, true, "none"],
    [{ NO_COLOR: "" }, true, "ansi256"],
    [{ TERM: "dumb", COLORTERM: "truecolor" }, true, "none"],
  ] as const)("%o on a TTY=%s is %s", (env, isTTY, mode) => {
    expect(colorModeOf(env, isTTY)).toBe(mode);
  });

  it("gives each token its truecolor value, its 256-colour fallback, or nothing", () => {
    expect(themeFor("truecolor").color("accent")).toBe("#22e07a");
    expect(themeFor("ansi256").color("accent")).toBe("ansi256(41)");
    expect(themeFor("none").color("accent")).toBeUndefined();
    expect(themeFor("none").bold).toBe(false);
    expect(PALETTE.bg).toEqual({ truecolor: "#000000", ansi256: 16 });
  });

  it("stops the spinner under AHP_NO_ANIMATION=1", () => {
    expect(themeOf({ AHP_NO_ANIMATION: "1" }, true).animate).toBe(false);
    expect(themeOf({}, true).animate).toBe(true);
  });
});

describe("the router", () => {
  it("opens, goes back, and never goes back past home", () => {
    let state = startAt();
    expect(currentScreen(state)).toBe("home");
    expect(route(state, { type: "back" })).toBe(state);
    state = route(state, { type: "open", screen: "help" });
    expect(state.stack).toEqual(["home", "help"]);
    state = route(state, { type: "open", screen: "runs" });
    state = route(state, { type: "open", screen: "help" });
    expect(state.stack).toEqual(["home", "runs", "help"]);
    expect(route(state, { type: "open", screen: "help" })).toBe(state);
    expect(currentScreen(route(state, { type: "back" }))).toBe("runs");
    expect(route(state, { type: "home" }).stack).toEqual(["home"]);
    expect(route(state, { type: "open", screen: "home" }).stack).toEqual(["home"]);
    expect(startAt("welcome").stack).toEqual(["home", "welcome"]);
  });
});

describe("the prompt's editing", () => {
  const run = (actions: PromptAction[], start: PromptState = emptyPrompt()) => {
    let state = start;
    const submitted: string[] = [];
    for (const action of actions) {
      const result = editPrompt(state, action);
      state = result.state;
      if (result.submitted !== null) submitted.push(result.submitted);
    }
    return { state, submitted };
  };

  it("types, moves and deletes", () => {
    const { state } = run([{ type: "insert", text: "fix it" }, { type: "left" }, { type: "left" }, { type: "backspace" }, { type: "insert", text: "X" }, { type: "home" }, { type: "delete" }]);
    expect(state.value).toBe("ixXit");
    expect(state.cursor).toBe(0);
    expect(run([{ type: "backspace" }]).state).toEqual(emptyPrompt());
  });

  it("submits on Enter, trimmed, and remembers it once", () => {
    const { state, submitted } = run([{ type: "insert", text: "  add a test " }, { type: "enter" }, { type: "insert", text: "add a test" }, { type: "enter" }, { type: "enter" }]);
    expect(submitted).toEqual(["add a test", "add a test"]);
    expect(state.history).toEqual(["add a test"]);
    expect(state.value).toBe("");
  });

  it("makes `\\` then Enter a new line, not a submit", () => {
    const { state, submitted } = run([{ type: "insert", text: "line one\\" }, { type: "enter" }, { type: "insert", text: "line two" }]);
    expect(submitted).toEqual([]);
    expect(state.value).toBe("line one\nline two");
  });

  it("pastes several lines as they are, with Windows line endings made plain", () => {
    expect(run([{ type: "insert", text: "a\r\nb\rc\u0007" }]).state.value).toBe("a\nb\nc");
  });

  it("browses history with ↑↓ only while empty or showing a recalled entry", () => {
    const start = emptyPrompt(["first", "second"]);
    expect(run([{ type: "up" }], start).state.value).toBe("second");
    expect(run([{ type: "up" }, { type: "up" }, { type: "up" }], start).state.value).toBe("first");
    expect(run([{ type: "up" }, { type: "up" }, { type: "down" }], start).state.value).toBe("second");
    expect(run([{ type: "up" }, { type: "down" }], start).state.value).toBe("");
    const typed = run([{ type: "insert", text: "mine" }, { type: "up" }], start).state;
    expect(typed.value).toBe("mine");
    expect(browsingHistory(typed)).toBe(false);
    expect(browsingHistory(emptyPrompt())).toBe(false);
  });
});

describe("the command menu", () => {
  it("narrows by what follows `/`, those starting with it first", () => {
    expect(commandQuery("/he")).toBe("he");
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("fix /x")).toBeNull();
    expect(commandQuery("/model x")).toBeNull();
    expect(filterByName(COMMANDS, (command) => command.name, "he").map((command) => command.name)).toEqual(["help", "check"]);
    expect(filterByName(COMMANDS, (command) => command.name, "s").map((command) => command.name).slice(0, 2)).toEqual(["settings", "push"]);
    expect(filterByName(COMMANDS, (command) => command.name, "").length).toBe(COMMANDS.length);
  });

  it("keeps the selected item in its window", () => {
    expect(windowStart(11, 0, 8)).toBe(0);
    expect(windowStart(11, 7, 8)).toBe(0);
    expect(windowStart(11, 9, 8)).toBe(2);
    expect(windowStart(3, 2, 8)).toBe(0);
  });
});

describe("a key table", () => {
  it("dispatches the first binding that applies, and shows only those in the footer", () => {
    const ran: string[] = [];
    const table: KeyBinding[] = [
      { keys: "enter", label: "off", when: false, match: is.enter, run: () => ran.push("off") },
      { keys: "enter", label: "on", match: is.enter, run: () => ran.push("on") },
      { keys: "x", label: "hidden", footer: false, match: is.char("x"), run: () => ran.push("x") },
    ];
    const key = (overrides: object) => ({ upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false, ...overrides });
    expect(dispatch(table, "\r", key({ return: true }))).toBe(true);
    expect(dispatch(table, "x", key({}))).toBe(true);
    expect(dispatch(table, "y", key({}))).toBe(false);
    expect(ran).toEqual(["on", "x"]);
    expect(activeKeys(table).map((binding) => binding.label)).toEqual(["on", "hidden"]);
    expect(footerKeys(table).map((binding) => binding.label)).toEqual(["on"]);
  });
});

describe("the layout", () => {
  it.each([
    [120, 30, true, true],
    [109, 30, true, false],
    [80, 20, true, false],
    [79, 30, false, false],
    [100, 19, false, false],
  ])("%i×%i fits=%s wide=%s", (columns, rows, fits, wide) => {
    expect(layoutOf(columns, rows)).toMatchObject({ fits, wide });
  });
});

describe("the home screen's model", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");

  it.each([
    ["2026-11-02T11:59:30Z", "just now"],
    ["2026-11-02T11:15:00Z", "45m ago"],
    ["2026-11-02T10:00:00Z", "2h ago"],
    ["2026-10-31T12:00:00Z", "2d ago"],
    ["not a time", ""],
  ])("%s was %s", (iso, said) => {
    expect(ago(iso, now)).toBe(said);
  });

  it("lists a run whose ledger cannot be read with its problem", () => {
    const model = homeModel([{ runId: "run_broken", state: null, lock: { state: "free" }, problem: "hash chain broken at seq 3" }], now);
    expect(model.recent).toEqual([{ runId: "run_broken", symbol: "✗", tone: "error", title: "run_broken", when: "", detail: "cannot be read: hash chain broken at seq 3" }]);
    expect(model.waiting).toEqual([]);
  });

  it("names each step's player: its model and effort, else its tool, or the mock", () => {
    expect(
      rolesLine([
        { role: "plan", adapter: "claude-code", tool: "claude-code", reason: "", model: "opus", effort: "high" },
        { role: "implement", adapter: "codex", tool: "codex", reason: "" },
        { role: "review", adapter: "mock", tool: null, reason: "" },
      ]),
    ).toBe("plan opus·high  implement Codex CLI  review mock");
  });
});
