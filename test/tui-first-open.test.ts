import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsPath } from "../src/runtime/paths.ts";
import { readSettings } from "../src/setup/settings.ts";
import { colorAt } from "./helpers/tui.ts";
import { closeApps, forgetSettings, openApp, toolsEnv } from "./helpers/tui-app.ts";
import { createTempRepo, git, removeTempRepos, trackForRemoval } from "./helpers/repo.ts";

let repo: string;
beforeEach(() => {
  forgetSettings();
  repo = createTempRepo({ "README.md": "# app\n" });
});
afterEach(() => {
  closeApps();
  removeTempRepos();
});
afterAll(forgetSettings);

const saved = async () => (await readSettings(settingsPath())).settings;

describe("first open with every tool ready", () => {
  it("shows the tools with version and login, then who does what, and Enter keeps them: home, and never the two screens again", async () => {
    const env = await toolsEnv({ claude: "ready", codex: "ready", opencode: "ready" });
    const { tui } = openApp({ repo, env });

    let frame = await tui.waitFor("Tools on this machine");
    await tui.waitFor("logged in");
    frame = tui.frame();
    expect(frame).toContain("▄▀█ █ █ █▀█");
    expect(frame).toContain("Several coding agents, one task, checked before anything lands.");
    expect(frame).toMatch(/✓ Claude Code +2\.1\.311 \(Claude Code\) +logged in/);
    expect(frame).toMatch(/✓ Codex CLI +codex-cli 0\.146\.0 +logged in/);
    // OpenCode's status command prints credentials as free text, which AHP does not read: it says so.
    expect(frame).toMatch(/✓ OpenCode +1\.2\.3 +installed, login not checked/);
    expect(colorAt(tui.raw(), "✓ Claude Code")).toContain("accent");
    expect(frame.split("\n").filter((line) => line.trim() !== "").at(-1)).toContain("enter continue  r check again  q quit");

    await tui.press("enter");
    frame = await tui.waitFor("Who does what?");
    expect(frame).toMatch(/plan +Claude Code · default model/);
    expect(frame).toMatch(/implement +Codex CLI · default model/);
    // OpenCode's login cannot be checked and Claude Code's was: review goes to Claude Code (ticket 10).
    expect(frame).toMatch(/review +Claude Code · default model/);
    expect(frame).toContain("enter continue");

    await tui.press("enter");
    await tui.waitFor("No runs here yet.");
    // Saved: that the screens were gone through, and no step (nothing was changed, so nothing is "your default").
    expect(await saved()).toEqual({ steps: {}, firstOpenDone: true });

    // Opened again: straight to home.
    const again = openApp({ repo, env });
    const home = await again.tui.waitFor("No runs here yet.");
    expect(home).not.toContain("Tools on this machine");
  });
});

describe("first open with a tool logged out or missing", () => {
  it("names the command that logs in or installs it, and casts the steps to the tools that are usable", async () => {
    const env = await toolsEnv({ claude: "ready", codex: "logged_out" });
    const { tui } = openApp({ repo, env });

    await tui.waitFor("not logged in");
    const frame = tui.frame();
    expect(frame).toMatch(/! Codex CLI +codex-cli 0\.146\.0 +not logged in +codex login/);
    expect(frame).toMatch(/✗ OpenCode +not installed +npm install -g opencode-ai/);
    expect(colorAt(tui.raw(), "! Codex CLI")).toContain("warn");
    expect(colorAt(tui.raw(), "✗ OpenCode")).toContain("error");

    await tui.press("enter");
    const roles = await tui.waitFor("Who does what?");
    // Codex is not logged in, OpenCode is not installed: Claude Code plays all three.
    expect(roles).toMatch(/plan +Claude Code/);
    expect(roles).toMatch(/implement +Claude Code/);
    expect(roles).toMatch(/review +Claude Code/);
  });

  it("checks the tools again on r", async () => {
    const env = await toolsEnv({ claude: "ready", codex: "logged_out" });
    const { tui } = openApp({ repo, env });
    await tui.waitFor("not logged in");
    await tui.type("r");
    await tui.waitFor("not logged in");
    expect(tui.frame()).toContain("Tools on this machine");
  });
});

describe("first open with no tool at all", () => {
  it("offers the mock on the second screen, and every screen after it marks the mock", async () => {
    const env = await toolsEnv({});
    const { tui } = openApp({ repo, env });

    await tui.waitFor("Tools on this machine");
    await tui.waitFor("not installed");
    expect(tui.frame()).toMatch(/✗ Claude Code +not installed +npm install -g @anthropic-ai\/claude-code/);
    await tui.press("enter");

    const roles = await tui.waitFor("No coding tool is usable here");
    expect(roles).toMatch(/Claude Code +npm install -g @anthropic-ai\/claude-code, then run `claude` and type \/login/);
    expect(roles).toMatch(/Codex CLI +npm install -g @openai\/codex, then codex login/);
    expect(roles).toContain("m try it on the mock");

    await tui.type("m");
    const home = await tui.waitFor("mock plays every step");
    expect(home).toContain("(scripted, its output is no evidence)");
    expect(await saved()).toEqual({ steps: {}, firstOpenDone: true });
  });
});

describe("who does what", () => {
  it("changes a step's tool, model and effort, and saves only that step with firstOpenDone", async () => {
    const env = await toolsEnv({ claude: "ready", codex: "ready", opencode: "ready" });
    const { tui } = openApp({ repo, env });
    await tui.waitFor("Tools on this machine");
    await tui.waitFor("logged in");
    await tui.press("enter");
    await tui.waitFor("Who does what?");

    // Pick implement (the second row), change it to Claude Code · opus · high.
    await tui.press("down", "down");
    expect(tui.frame()).toMatch(/❯ implement/);
    expect(tui.frame().split("\n").filter((line) => line.trim() !== "").at(-1)).toContain("enter change");
    await tui.press("enter");
    await tui.waitFor("Who does implement?");
    expect(tui.frame()).toMatch(/Claude Code +2\.1\.311 \(Claude Code\)/);
    await tui.type("claude");
    await tui.press("enter");

    await tui.waitFor("Which model for implement? (Claude Code)");
    expect(tui.frame()).toContain("the tool's own default");
    expect(tui.frame()).toContain("sonnet");
    expect(tui.frame()).toContain("type a model name…");
    await tui.type("opus");
    await tui.press("enter");

    await tui.waitFor("Which effort for implement?");
    await tui.type("high");
    await tui.press("enter");

    // Back on the list, changed; the first-open screen does not ask about next time (it saves on its own terms).
    const frame = await tui.waitFor("changed");
    expect(frame).toMatch(/implement +Claude Code · opus · high +changed/);
    expect(frame).not.toContain("next time?");
    await tui.press("ctrl+s");
    await tui.waitFor("No runs here yet.");

    expect(await saved()).toEqual({ steps: { implement: { tool: "claude-code", model: "opus", effort: "high" } }, firstOpenDone: true });
  });

  it("refuses a tool that is not usable with the command that fixes it, and cancels with Esc", async () => {
    const env = await toolsEnv({ claude: "ready", codex: "logged_out" });
    const { tui } = openApp({ repo, env });
    await tui.waitFor("not logged in");
    await tui.press("enter");
    await tui.waitFor("Who does what?");
    await tui.press("down", "down", "enter");
    await tui.waitFor("Who does implement?");
    await tui.type("codex");
    await tui.press("enter");
    const frame = tui.frame();
    expect(frame).toContain("Codex CLI is not usable here: not logged in: codex login");
    expect(colorAt(tui.raw(), "Codex CLI is not usable")).toContain("error");
    await tui.press("escape");
    await tui.waitFor("Who does what?");
    expect(tui.frame()).not.toContain("changed");
  });
});

describe("the folder opened in", () => {
  it("is a folder that is not a repository: Enter makes it one with a first commit", async () => {
    const env = await toolsEnv({ claude: "ready" });
    await writeSettingsDone();
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-bare-")));
    trackForRemoval(dir);
    writeFileSync(join(dir, "app.js"), "x\n");
    const { tui } = openApp({ repo: dir, env });

    const frame = await tui.waitFor("This folder isn't a git repository.");
    expect(frame).toContain("A run starts from a commit, and the agents see only what is committed.");
    expect(frame.split("\n").filter((line) => line.trim() !== "").at(-1)).toContain("enter git init + first commit");
    // Nothing was changed yet.
    expect(existsSync(join(dir, ".git"))).toBe(false);
    await afterPaint();
    await tui.press("enter");
    await tui.waitFor("No runs here yet.");
    expect(git(dir, "show", "HEAD:app.js")).toBe("x");
    expect(git(dir, "log", "--format=%s")).toBe("First commit");
  });

  it("is a repository with no commit: Enter commits what is in it", async () => {
    const env = await toolsEnv({ claude: "ready" });
    await writeSettingsDone();
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-nocommit-")));
    trackForRemoval(dir);
    git(dir, "init", "--quiet", "--initial-branch=main");
    git(dir, "config", "user.name", "AHP Test");
    git(dir, "config", "user.email", "ahp-test@localhost");
    writeFileSync(join(dir, "b.js"), "y\n");
    const { tui } = openApp({ repo: dir, env });

    await tui.waitFor("This repository has no commit yet.");
    await afterPaint();
    await tui.press("enter");
    await tui.waitFor("No runs here yet.");
    expect(git(dir, "show", "HEAD:b.js")).toBe("y");
  });

  it("is not something to make ready when git does not know who the person is: the two git config commands, nothing else asked", async () => {
    const env = await toolsEnv({ claude: "ready" });
    await writeSettingsDone();
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-noid-")));
    trackForRemoval(dir);
    const empty = join(dir, "..", `empty-${Date.now()}.gitconfig`);
    writeFileSync(empty, "");
    trackForRemoval(empty);
    const names = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_SYSTEM = empty;
    for (const name of names.slice(2)) delete process.env[name];
    try {
      const { tui } = openApp({ repo: dir, env });
      const frame = await tui.waitFor("git does not know who you are");
      expect(frame).toContain('git config --global user.name "Your Name"');
      expect(frame).toContain("git config --global user.email you@example.com");
      expect(frame.split("\n").filter((line) => line.trim() !== "").at(-1)).toContain("enter check again");
      // Esc quits: nothing was initialised.
      await afterPaint();
      await tui.press("escape");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(tui.exited()).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(false);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

/** Ink listens for keys a tick after a screen first paints; a key sent in that instant is lost. */
const afterPaint = () => new Promise((resolve) => setTimeout(resolve, 250));

async function writeSettingsDone() {
  const { markFirstOpenDone } = await import("../src/setup/settings.ts");
  await markFirstOpenDone(settingsPath());
}
