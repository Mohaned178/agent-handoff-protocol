import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import type { Terminal } from "../src/cli/live.ts";
import { formatDoctor } from "../src/cli/format-doctor.ts";
import { settingsPath } from "../src/runtime/index.ts";
import type { DoctorReport, ToolReport } from "../src/doctor/index.ts";
import type { Prompter } from "../src/setup/index.ts";
import { listRuns } from "../src/sdk/index.ts";
import { fakeToolsDir, installFakeTool, pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, removeTempRepos } from "./helpers/repo.ts";

const saved: Record<string, string | undefined> = {};
const setEnv = (values: Record<string, string | undefined>) => {
  // Every key is saved before any is set: on Windows PATH and Path are one variable.
  for (const key of Object.keys(values)) if (!(key in saved)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
const dirs: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  rmSync(settingsPath(), { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  removeTempRepos();
});

async function onPath(path: string | undefined) {
  setEnv({ PATH: path, ...(process.platform === "win32" ? { Path: path } : {}) });
}

function person(answers: unknown[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async <T>(message: string) => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`no answer scripted for: ${message}`);
    return answers.shift() as T;
  };
  return { asked, select: ({ message }) => next(message), checkbox: ({ message }) => next(message), input: ({ message }) => next(message), confirm: ({ message }) => next(message), say: () => undefined };
}

async function ahpHere(args: string[], repo: string, prompter: Prompter | null) {
  const printed: string[] = [];
  const terminal: Terminal = { write: () => undefined, columns: () => 120, color: false, compact: true, prompter };
  const io: Io = { stdout: (text) => printed.push(text), stderr: (text) => printed.push(`stderr: ${text}`), ...(prompter ? { terminal } : {}) };
  const code = await main([...args, "--repo", repo], io);
  return { code, stdout: printed.join("\n") };
}

const TASK = "fix the cart total";

describe("no coding agent tool", () => {
  beforeEach(async () => onPath((await pathWithoutTools()).PATH));

  it("names how to install each tool and log in with it", async () => {
    const run = await ahpHere([TASK, "--yes", "--check", "node -e 0"], createTempRepo({ "README.md": "x\n" }), null);

    expect(run.code).toBe(2);
    for (const install of ["npm install -g @anthropic-ai/claude-code", "npm install -g @openai/codex", "npm install -g opencode-ai"]) expect(run.stdout).toContain(install);
    for (const logIn of ["run `claude` and type /login", "codex login", "opencode auth login"]) expect(run.stdout).toContain(logIn);
  });
});

describe("ahp doctor", () => {
  it("says how to install a tool that is missing and log in with one that is logged out", () => {
    const tool = (id: string, overrides: Partial<ToolReport>) => ({ id, name: id, command: id, installed: true, path: null, version: "1", problem: null, login: { state: "logged_in", detail: "" }, adapter: null, usable: true, ...overrides }) as ToolReport;
    const report = {
      system: { os: { platform: "win32", release: "10", label: "Windows", supported: true }, node: { version: "24", required: ">=24", meets: true }, git: { version: "2.50", required: "2.20", meets: true, detail: null } },
      tools: [tool("claude-code", { installed: false, problem: "not on PATH", usable: false }), tool("codex", { login: { state: "not_logged_in", detail: "codex login status" }, usable: false })],
      ok: true,
    } as unknown as DoctorReport;

    const text = formatDoctor(report);

    expect(text).toContain("to install: npm install -g @anthropic-ai/claude-code");
    expect(text).toContain("to log in: codex login");
  });
});

describe("no git identity", () => {
  it("is named, with the two commands that set it, before the person is asked to make a repository", async () => {
    const empty = join(mkdtempSync(join(tmpdir(), "ahp-nogit-")), "gitconfig");
    dirs.push(join(empty, ".."));
    writeFileSync(empty, "");
    setEnv({ GIT_CONFIG_GLOBAL: empty, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined });
    const folder = mkdtempSync(join(tmpdir(), "ahp-plain-"));
    dirs.push(folder);
    writeFileSync(join(folder, "README.md"), "x\n");
    const prompter = person([]);

    const run = await ahpHere([TASK, "--mock", "--check", "node -e 0"], folder, prompter);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('git config --global user.name "Your Name"');
    expect(run.stdout).toContain("git config --global user.email you@example.com");
    expect(prompter.asked).toEqual([]);
    expect(readdirSync(folder)).toEqual(["README.md"]);
  });
});

describe("the check, run once on the last commit before any agent", () => {
  it("says when it already fails there, and starts nothing when the person says not to run", async () => {
    const repo = createTempRepo({ "red.mjs": 'console.log("cart total: expected 30, got 10"); process.exit(1);\n' });
    const prompter = person(["run", false]);

    const run = await ahpHere([TASK, "--mock", "--check", "node red.mjs"], repo, prompter);

    expect(run.code).toBe(0);
    expect(run.stdout, run.stdout).toContain("the check already fails on your last commit: cart total: expected 30, got 10");
    expect(prompter.asked).toEqual(["Run it?", "Run it anyway? (the agents are asked to make it pass)"]);
    expect(run.stdout).toContain("cancelled: nothing was started");
    expect(await listRuns({ repo })).toEqual([]);
  });

  it("names a check command that does not exist, before any agent is spent on it", async () => {
    const repo = createTempRepo({ "README.md": "x\n" });

    const run = await ahpHere([TASK, "--mock", "--check", "no-such-check-cmd"], repo, person(["run", false]));

    expect(run.stdout).toMatch(/the check already fails on your last commit: .*no-such-check-cmd/);
    expect(await listRuns({ repo })).toEqual([]);
  });

  it("runs anyway when the person says so, and with --yes says it and goes on", async () => {
    const repo = createTempRepo({ "red.mjs": "process.exit(1);\n" });

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node red.mjs"], repo, null);

    expect(run.stdout).toContain("the check already fails on your last commit");
    expect((await listRuns({ repo })).length).toBe(1);
  });

  it("is said nothing about when it passes, and is skipped with --no-precheck", async () => {
    const repo = createTempRepo({ "red.mjs": "process.exit(1);\n", "green.mjs": "process.exit(0);\n" });

    const passing = await ahpHere([TASK, "--mock", "--check", "node green.mjs"], repo, person(["run", "approve"]));
    expect(passing.stdout).not.toContain("already fails");

    const skipped = await ahpHere([TASK, "--mock", "--no-precheck", "--check", "node red.mjs"], repo, person(["cancel"]));
    expect(skipped.stdout).not.toContain("already fails");
  });
});

describe("the first run with real agents", () => {
  beforeEach(async () => {
    const { dir, log } = fakeToolsDir();
    installFakeTool(dir, log, "claude", `if (argv[0] === "--version") console.log("2.1.311 (Claude Code)"); else console.log(JSON.stringify({ loggedIn: true }));`);
    installFakeTool(dir, log, "codex", `if (argv[0] === "--version") console.log("codex-cli 0.146.0");`);
    await onPath([dir, (await pathWithoutTools()).PATH].join(delimiter));
  });

  it("says once that agents run commands on this machine and their usage counts, then never again", async () => {
    const repo = createTempRepo({ "green.mjs": "process.exit(0);\n" });

    const first = await ahpHere([TASK, "--check", "node green.mjs"], repo, person(["cancel"]));
    const second = await ahpHere([TASK, "--check", "node green.mjs"], repo, person(["cancel"]));

    expect(first.stdout).toContain("first run with real agents: they run commands on this machine, and their usage counts against your own plans");
    expect(second.stdout).not.toContain("first run with real agents");
    expect(existsSync(settingsPath())).toBe(true);
  });

  it("is not said for a run of scripted agents", async () => {
    const run = await ahpHere([TASK, "--mock", "--check", "node -e 0"], createTempRepo({ "README.md": "x\n" }), person(["cancel"]));

    expect(run.stdout).not.toContain("first run with real agents");
  });
});
