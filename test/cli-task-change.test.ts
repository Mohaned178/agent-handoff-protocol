import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import type { Terminal } from "../src/cli/live.ts";
import { settingsPath } from "../src/runtime/index.ts";
import type { Prompter } from "../src/setup/index.ts";
import { listRuns } from "../src/sdk/index.ts";
import { fakeToolsDir, installFakeTool, pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, removeTempRepos } from "./helpers/repo.ts";

// Claude Code and Codex are installed and logged in here (fakes that answer only doctor's version and status commands);
// OpenCode is not. No test runs an agent: each stops at the summary.
let saved: { PATH?: string; Path?: string };
beforeEach(async () => {
  saved = { PATH: process.env.PATH, Path: process.env.Path };
  const { dir, log } = fakeToolsDir();
  installFakeTool(dir, log, "claude", `if (argv[0] === "--version") console.log("2.1.311 (Claude Code)"); else console.log(JSON.stringify({ loggedIn: true }));`);
  installFakeTool(dir, log, "codex", `if (argv[0] === "--version") console.log("codex-cli 0.146.0");`);
  const path = [dir, (await pathWithoutTools()).PATH].join(delimiter);
  process.env.PATH = path;
  if (process.platform === "win32") process.env.Path = path;
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (process.platform === "win32") process.env.Path = saved.Path ?? saved.PATH;
  rmSync(settingsPath(), { force: true });
  removeTempRepos();
});

function person(answers: unknown[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async <T>(message: string) => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`no answer scripted for: ${message}`);
    return answers.shift() as T;
  };
  return { asked, select: ({ message }) => next(message), checkbox: ({ message }) => next(message), input: ({ message }) => next(message), confirm: ({ message }) => next(message), say: () => undefined };
}

async function ahpHere(args: string[], repo: string | null, prompter: Prompter | null) {
  const printed: string[] = [];
  const terminal: Terminal = { write: () => undefined, columns: () => 100, color: false, compact: true, prompter };
  const io: Io = { stdout: (text) => printed.push(text), stderr: (text) => printed.push(`stderr: ${text}`), ...(prompter ? { terminal } : {}) };
  const code = await main([...args, ...(repo ? ["--repo", repo] : [])], io);
  return { code, stdout: printed.join("\n") };
}

const project = () => createTempRepo({ "README.md": "# app\n", "check.mjs": "process.exit(0);\n" });
const TASK = "fix the cart total";
const CHECK = ["--check", "node check.mjs"];
const saveSettings = (settings: unknown) => writeFileSync(settingsPath(), JSON.stringify(settings));
/** The step defaults saved so far: none when there is no settings file (the first real run also records its notice there). */
const savedSteps = () => (existsSync(settingsPath()) ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as { steps: unknown }).steps : {});
/** The summary's last line for `step`. */
const lineOf = (stdout: string, step: string) => stdout.split("\n").filter((line) => new RegExp(`^\\s+${step}\\s`).test(line)).at(-1) ?? "";

describe("changing a step in the summary's menu", () => {
  it("asks the step, its tool, model and effort, shows the summary again, and keeps it for next time when asked", async () => {
    const repo = project();
    const prompter = person(["change", "review", "claude-code", "opus", "high", true, "cancel"]);

    const run = await ahpHere([TASK, ...CHECK], repo, prompter);

    expect(run.code, run.stdout).toBe(0);
    expect(prompter.asked).toEqual([
      "Run it?",
      "Which step?",
      "Who reviews it? (review)",
      "Which model for review? (Claude Code's aliases)",
      "Which effort for review? (the model may refuse a level; the tool says so when it runs)",
      "Use Claude Code (opus, effort high) for review next time?",
      "Run it?",
    ]);
    expect(lineOf(run.stdout, "review")).toMatch(/Claude Code\s+opus, effort high · your default/);
    expect(savedSteps()).toEqual({ review: { tool: "claude-code", model: "opus", effort: "high" } });
    expect(await listRuns({ repo })).toEqual([]);
  });

  it("saves nothing when the person says no to next time", async () => {
    const run = await ahpHere([TASK, ...CHECK], project(), person(["change", "implement", "claude-code", null, null, false, "cancel"]));

    expect(lineOf(run.stdout, "implement")).toMatch(/Claude Code\s+default model$/);
    expect(savedSteps()).toEqual({});
  });
});

describe("changing a step with flags", () => {
  it("sets a step's tool, model and effort, and saves nothing", async () => {
    const run = await ahpHere([TASK, ...CHECK, "--review", "claude-code", "--review-model", "opus", "--implement-effort", "low"], project(), person(["cancel"]));

    expect(run.code, run.stdout).toBe(0);
    expect(lineOf(run.stdout, "review")).toMatch(/Claude Code\s+opus$/);
    expect(lineOf(run.stdout, "implement")).toMatch(/Codex CLI\s+default model, effort low$/);
    expect(savedSteps()).toEqual({});
  });

  it("adds the plan step when a plan flag names its tool", async () => {
    const run = await ahpHere([TASK, ...CHECK, "--plan", "codex"], project(), person(["cancel"]));

    expect(lineOf(run.stdout, "plan")).toMatch(/Codex CLI\s+default model$/);
  });

  it.each<[string, string[], string]>([
    ["a tool that is not usable here", ["--review", "opencode"], "--review opencode: OpenCode is not usable here (not installed;"],
    ["a name that is no tool", ["--review", "gemini"], "--review must name claude-code, codex or opencode, not gemini"],
    ["an effort the tool does not have", ["--implement-effort", "extreme"], "--implement-effort extreme: Codex CLI's efforts are"],
    ["an empty model", ["--review-model", " "], "--review-model needs a model's name"],
    ["a step flag beside --mock", ["--mock", "--review", "codex"], "--mock casts every step"],
  ])("refuses %s before anything runs", async (_name, flags, message) => {
    const repo = project();

    const run = await ahpHere([TASK, ...CHECK, "--yes", ...flags], repo, null);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain(message);
    expect(await listRuns({ repo })).toEqual([]);
  });
});

describe("saved defaults", () => {
  it("are used and shown as yours, and a flag still overrides them", async () => {
    saveSettings({ steps: { review: { tool: "claude-code", model: "opus" }, implement: { tool: "claude-code" } } });

    const run = await ahpHere([TASK, ...CHECK, "--implement", "codex"], project(), person(["cancel"]));

    expect(lineOf(run.stdout, "review")).toMatch(/Claude Code\s+opus · your default/);
    expect(lineOf(run.stdout, "implement")).toMatch(/Codex CLI\s+default model$/);
  });

  it("fall back to AHP's casting when their tool is no longer usable, and the summary says so", async () => {
    saveSettings({ steps: { review: { tool: "opencode", model: "opencode/big-pickle" } } });

    const run = await ahpHere([TASK, ...CHECK], project(), person(["cancel"]));

    expect(lineOf(run.stdout, "review")).toMatch(/Claude Code\s+default model · your default, OpenCode, is not usable here/);
  });

  it("are left out, and said to be, when the file cannot be read", async () => {
    writeFileSync(settingsPath(), "{ not json");

    const run = await ahpHere([TASK, ...CHECK], project(), person(["cancel"]));

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`your saved defaults were not used: ${settingsPath()}`);
  });
});

describe("ahp settings", () => {
  it("prints the saved defaults and the file's path, and --clear removes them", async () => {
    saveSettings({ steps: { review: { tool: "claude-code", model: "opus", effort: "high" } } });

    const shown = await ahpHere(["settings"], null, null);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(settingsPath());
    expect(shown.stdout).toMatch(/review\s+Claude Code, model opus, effort high/);

    const cleared = await ahpHere(["settings", "--clear"], null, null);
    expect(cleared.code).toBe(0);
    expect(cleared.stdout).toContain("removed the saved defaults");
    expect(existsSync(settingsPath())).toBe(false);

    const none = await ahpHere(["settings"], null, null);
    expect(none.stdout).toContain("no saved defaults");
  });
});
