import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workflowFileName, renderWorkflowFile, saveTaskWorkflow, WorkflowFileExistsError } from "../src/commands/workflow-file.ts";
import { runWorkflow, type RunView } from "../src/index.ts";
import { listRuns } from "../src/sdk/run.ts";
import { settingsPath } from "../src/runtime/paths.ts";
import type { RunListing } from "../src/sdk/run.ts";
import { clearStepDefault, clearStepDefaults, markFirstOpenDone, markRealAgentsNoticed, readSettings, saveStepDefault } from "../src/setup/settings.ts";
import type { TaskRun } from "../src/setup/task.ts";
import { filterRuns, runsModel, usageLine, usageSegment } from "../src/tui/runs-model.ts";
import { settingsModel } from "../src/tui/settings-model.ts";
import { summarizeUsage } from "../src/runtime/usage.ts";
import { gatedWorkflow } from "./helpers/approval.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";
import { implemented, implementStep } from "./helpers/review.ts";
import { colorAt } from "./helpers/tui.ts";
import { closeApps, forgetSettings, openApp, toolsEnv } from "./helpers/tui-app.ts";

const saved = async () => (await readSettings(settingsPath())).settings;
const lastLine = (frame: string) => frame.split("\n").filter((line) => line.trim() !== "").at(-1)!.trim();

describe("the usage of a run, as each tool reported it", () => {
  const attempt = (adapter: string, usage: { input: number | null; output: number | null; total?: number | null } | null) => ({
    adapter,
    usage: usage && { source: `${adapter} report`, inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total ?? null, cachedInputTokens: null, cost: null },
  });

  it("names the tool before every number, and never adds one tool's to another's", () => {
    const summaries = summarizeUsage([attempt("claude-code", { input: 1200, output: 30 }), attempt("codex", { input: 5000, output: 70 }), attempt("claude-code", { input: 800, output: 20 })]);
    expect(summaries.map(usageSegment)).toEqual(["claude-code 2,000 in · 50 out", "codex 5,000 in · 70 out"]);
  });

  it("says 'not reported' for a tool that reported nothing, never 0, and how many attempts did when only some did", () => {
    const [none] = summarizeUsage([attempt("opencode", null), attempt("opencode", null)]);
    expect(usageSegment(none!)).toBe("opencode not reported");
    const [some] = summarizeUsage([attempt("codex", { input: 100, output: 5 }), attempt("codex", null), attempt("codex", null)]);
    expect(usageSegment(some!)).toBe("codex 100 in · 5 out (1 of 3 attempts)");
    const [total] = summarizeUsage([attempt("codex", { input: null, output: null, total: 900 })]);
    expect(usageSegment(total!)).toBe("codex 900 tokens");
  });
});

describe("the filter of /runs", () => {
  const rows = [
    { runId: "run_a", symbol: "✓", tone: "accent", title: "fix-cart-total", when: "1h ago", detail: "verified · branch ahp/fix", usage: "codex 10 in", openable: true },
    { runId: "run_b", symbol: "✗", tone: "error", title: "add-login", when: "2h ago", detail: "implement: npm test failed", usage: "", openable: true },
  ] as const;

  it("keeps the order, and every word must match", () => {
    expect(filterRuns(rows, "").map((row) => row.runId)).toEqual(["run_a", "run_b"]);
    expect(filterRuns(rows, "LOGIN").map((row) => row.runId)).toEqual(["run_b"]);
    expect(filterRuns(rows, "ahp verified").map((row) => row.runId)).toEqual(["run_a"]);
    expect(filterRuns(rows, "codex login")).toEqual([]);
    expect(filterRuns(rows, "run_b").map((row) => row.runId)).toEqual(["run_b"]);
  });
});

describe("saved defaults", () => {
  const read = (steps: object, problem: string | null = null) => ({ settings: { steps }, problem }) as Parameters<typeof settingsModel>[0];

  it("show 'automatic' for a step with none, and never what AHP would cast", () => {
    const model = settingsModel(read({ implement: { tool: "codex", model: "gpt-5.6", effort: "high" } }));
    expect(model.rows.map((row) => [row.role, row.text])).toEqual([
      ["plan", "automatic"],
      ["implement", "Codex CLI, model gpt-5.6, effort high"],
      ["review", "automatic"],
    ]);
  });

  it("forgetting one keeps the others and the flags; forgetting all keeps the flags, so the first-open screens do not come back", async () => {
    forgetSettings();
    await markFirstOpenDone(settingsPath());
    await markRealAgentsNoticed(settingsPath());
    await saveStepDefault(settingsPath(), "plan", { tool: "claude-code", model: "opus" });
    await saveStepDefault(settingsPath(), "review", { tool: "opencode" });

    await clearStepDefault(settingsPath(), "plan");
    expect(await saved()).toEqual({ steps: { review: { tool: "opencode" } }, firstOpenDone: true, realAgentsNoticed: true });
    await clearStepDefaults(settingsPath());
    expect(await saved()).toEqual({ steps: {}, firstOpenDone: true, realAgentsNoticed: true });
    forgetSettings();
  });
});

describe("a workflow file's name", () => {
  it("gets .mjs when it has no extension, and refuses another one", () => {
    expect(workflowFileName("reset")).toEqual({ name: "reset.mjs" });
    expect(workflowFileName(" flows/reset.mjs ")).toEqual({ name: "flows/reset.mjs" });
    expect(workflowFileName("")).toEqual({ error: "name the file, e.g. password-reset.mjs" });
    expect(workflowFileName("reset.json")).toEqual({ error: "the file must end in .mjs (ahp run loads it as a module), not .json" });
  });
});

describe("the screens behind /runs, /tools, /settings and /clean", () => {
  let repo: string;
  const runs = {} as Record<"passed" | "failed" | "gate", { runId: string; state: RunView }>;

  beforeAll(async () => {
    repo = createTempRepo({ "README.md": "# app\n", "verify.mjs": VERIFY_GREETING, "check.mjs": "process.exit(0);\n" });
    runs.passed = await runWorkflow(retryWorkflow([hello]), { repo });
    runs.failed = await runWorkflow(retryWorkflow([goodbye], { retry: { budget: 0 } }), { repo });
    runs.gate = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo });
  }, 120_000);
  afterAll(removeTempRepos);

  beforeEach(async () => {
    forgetSettings();
    await markFirstOpenDone(settingsPath());
  });
  afterEach(closeApps);

  async function open(tools: Parameters<typeof toolsEnv>[0], command: string, size: { columns?: number; rows?: number } = {}) {
    const opened = openApp({ repo, env: await toolsEnv(tools), ...size });
    await opened.tui.waitFor("Waiting for you");
    await opened.tui.type(command);
    await opened.tui.press("enter");
    return opened.tui;
  }

  describe("/runs", () => {
    it("lists every run newest first with state, outcome and the usage per tool, narrows as you type and opens one with Enter", async () => {
      const tui = await open({}, "/runs");
      const frame = await tui.waitFor("3 runs");
      expect(frame).toMatch(/✓ .*verified/);
      expect(frame).toMatch(/✗ .*implement: .* failed/);
      expect(frame).toMatch(/! .*waiting for your approval/);
      // Mock runs say so, and the mock reported no usage: said, not shown as 0.
      expect(frame).toContain("mock");
      expect(frame).toContain("usage: mock not reported");
      expect(frame).not.toMatch(/usage:.* 0 (in|out)/);
      expect(colorAt(tui.raw(), "usage: mock not reported")).toContain("muted");
      expect(lastLine(frame)).toContain("enter open");

      // Typing is a filter: `?` is a letter now, and Esc clears it before it goes back.
      await tui.type("approval");
      await tui.waitFor("1 of 3 runs");
      expect(tui.frame()).not.toContain("implement: ");
      expect(lastLine(tui.frame())).toContain("esc clear the filter");
      await tui.type("?");
      expect(tui.frame()).toContain("filter: approval?");
      expect(tui.frame()).toContain("nothing matches");
      await tui.press("backspace");
      await tui.press("escape");
      await tui.waitFor("3 runs");
      expect(lastLine(tui.frame())).toContain("esc back");

      await tui.type("failed");
      await tui.waitFor("1 of 3 runs");
      await tui.press("enter");
      const run = await tui.waitFor(`run ${runs.failed.runId}`);
      expect(lastLine(run)).toContain("esc back");
    });

    it("lists a run whose ledger cannot be read with its problem, and does not open it", async () => {
      const dir = join(repo, ".git", "ahp", "runs", "run_broken1");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ledger.jsonl"), "this is not a ledger\n");
      try {
        const tui = await open({}, "/runs");
        await tui.waitFor("run_broken1");
        expect(tui.frame()).toMatch(/✗ +run_broken1 .*cannot be read/);
        await tui.type("broken");
        await tui.waitFor("1 of 4 runs");
        await tui.press("enter");
        await tui.waitFor("cannot be opened");
        expect(colorAt(tui.raw(), "run_broken1 cannot be opened")).toContain("error");
      } finally {
        const { rmSync } = await import("node:fs");
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("/tools", () => {
    it("shows Node and git against their minimums, each tool's version, login and declared levels, and the command for one not ready", async () => {
      const tui = await open({ claude: "ready", codex: "logged_out" }, "/tools", { rows: 60 });
      const frame = await tui.waitFor("Coding tools");
      await tui.waitFor("OpenCode");
      expect(tui.frame()).toMatch(/✓ Node +\S+, needs 24 or newer/);
      expect(tui.frame()).toMatch(/✓ git +\d+\.\d+\S*, needs 2\.20 or newer/);
      expect(tui.frame()).toMatch(/✓ Claude Code +2\.1\.311 \(Claude Code\) +logged in +claude-code/);
      expect(tui.frame()).toMatch(/! Codex CLI +codex-cli 0\.146\.0 +not logged in +codex/);
      expect(tui.frame()).toMatch(/log in: codex login/);
      expect(tui.frame()).toMatch(/✗ OpenCode +not installed/);
      expect(tui.frame()).toMatch(/install: npm install -g opencode-ai/);
      expect(tui.frame()).toMatch(/(enforced_by_tool|cooperative|none): /);
      expect(tui.frame()).toContain("not what was observed here");
      expect(tui.frame()).toContain("it is not a security boundary");
      expect(colorAt(tui.raw(), "! Codex CLI")).toContain("warn");
      expect(colorAt(tui.raw(), "✗ OpenCode")).toContain("error");
      expect(frame).toContain("r check again");
    });

    it("says an OpenCode login AHP cannot read is unknown, not no", async () => {
      const tui = await open({ opencode: "ready" }, "/tools", { rows: 60 });
      await tui.waitFor("login unknown");
      expect(tui.frame()).not.toMatch(/OpenCode.*not logged in/);
    });

    it("keeps the install and log-in commands reachable at the smallest size by scrolling, and checks again on r", async () => {
      const tui = await open({ claude: "ready", codex: "logged_out" }, "/tools", { columns: 80, rows: 20 });
      await tui.waitFor("Coding tools");
      expect(lastLine(tui.frame())).toContain("↑↓ scroll");
      expect(tui.frame().split("\n").every((line) => line.length <= 80)).toBe(true);
      for (let i = 0; i < 12; i++) await tui.press("down");
      expect(tui.frame()).toContain("install: npm install -g opencode-ai");
      await tui.type("r");
      await tui.waitFor("Coding tools");
    });
  });

  describe("/settings", () => {
    it("shows 'automatic' for every step at first, changes one with the picker and saves it at once, which home then shows", async () => {
      const tui = await open({ claude: "ready", codex: "ready", opencode: "ready" }, "/settings");
      const frame = await tui.waitFor("Your defaults");
      expect(frame).toMatch(/plan +automatic/);
      expect(frame).toMatch(/implement +automatic/);
      expect(frame).toMatch(/review +automatic/);
      expect(frame).not.toContain("x forget");

      await tui.press("down", "enter");
      await tui.waitFor("Who does implement?");
      await tui.type("claude");
      await tui.press("enter");
      await tui.waitFor("Which model for implement? (Claude Code)");
      await tui.type("opus");
      await tui.press("enter");
      await tui.waitFor("Which effort for implement?");
      await tui.type("high");
      await tui.press("enter");

      await tui.waitFor("Claude Code, model opus, effort high");
      expect(tui.frame()).toMatch(/implement +Claude Code, model opus, effort high/);
      expect(await saved()).toEqual({ steps: { implement: { tool: "claude-code", model: "opus", effort: "high" } }, firstOpenDone: true });
      expect(lastLine(tui.frame())).toContain("x forget this one");

      // Home's status line shows it on coming back.
      await tui.press("escape");
      await tui.waitFor("implement opus·high");
    });

    it("forgets the picked step on x and every step on X after a yes, and keeps the first-open flag", async () => {
      await saveStepDefault(settingsPath(), "plan", { tool: "claude-code", model: "opus" });
      await saveStepDefault(settingsPath(), "implement", { tool: "codex" });
      const tui = await open({ claude: "ready", codex: "ready" }, "/settings");
      await tui.waitFor((frame) => /plan +Claude Code, model opus/.test(frame));

      await tui.type("x");
      await tui.waitFor((frame) => /plan +automatic/.test(frame));
      expect(await saved()).toEqual({ steps: { implement: { tool: "codex" } }, firstOpenDone: true });

      await tui.type("X");
      const asked = await tui.waitFor("Forget every saved default?");
      expect(lastLine(asked)).toContain("y forget all");
      await tui.type("n");
      expect(tui.frame()).not.toContain("Forget every saved default?");
      expect(await saved()).toEqual({ steps: { implement: { tool: "codex" } }, firstOpenDone: true });

      await tui.type("X");
      await tui.waitFor("Forget every saved default?");
      await tui.type("y");
      await tui.waitFor((frame) => /implement +automatic/.test(frame));
      expect(await saved()).toEqual({ steps: {}, firstOpenDone: true });
    });

    it("shows a broken entry and leaves it out", async () => {
      writeFileSync(settingsPath(), JSON.stringify({ steps: { plan: { tool: "nonsense" }, review: { tool: "opencode" } }, firstOpenDone: true }));
      const tui = await open({ opencode: "ready" }, "/settings");
      const frame = await tui.waitFor("left out:");
      expect(frame).toMatch(/plan: its tool must be claude-code, codex,\s+opencode/);
      expect(frame).toMatch(/plan +automatic/);
      expect(frame).toMatch(/review +OpenCode/);
      expect(colorAt(tui.raw(), "! left out")).toContain("warn");
    });
  });

  describe("/clean", () => {
    it("says what would go and removes nothing until Enter, then says what it removed", async () => {
      const worktrees = join(process.env.AHP_HOME!, "worktrees");
      const tui = await open({}, "/clean");
      const plan = await tui.waitFor("nothing is removed yet");
      expect(plan).toMatch(/would remove +\S+ +\d+ worktrees?, /);
      expect(plan).toMatch(/kept +\S+ .*waiting for your approval/);
      expect(lastLine(plan)).toContain("enter remove them");
      expect(existsSync(join(worktrees, runs.passed.runId))).toBe(true);
      // Leaving without a key removes nothing.
      await tui.press("escape");
      await tui.waitFor("Waiting for you");
      expect(existsSync(join(worktrees, runs.passed.runId))).toBe(true);

      await tui.type("/clean");
      await tui.press("enter");
      await tui.waitFor("enter remove them");
      await tui.press("enter");
      const done = await tui.waitFor("Cleaned:");
      expect(done).toMatch(/removed +\S+ +\d+ worktrees?, /);
      expect(done).toMatch(/Removed \d+ worktrees? of 2 ended runs, freed /);
      expect(done).toContain("Ledgers and snapshots are kept.");
      expect(existsSync(join(worktrees, runs.passed.runId))).toBe(false);
      expect(existsSync(join(worktrees, runs.failed.runId))).toBe(false);
      expect(existsSync(join(worktrees, runs.gate.runId))).toBe(true);
      expect((await listRuns({ repo })).length).toBe(3);
    });
  });
});

describe("save as workflow", () => {
  let repo: string;
  beforeEach(async () => {
    forgetSettings();
    await markFirstOpenDone(settingsPath());
    repo = createTempRepo({ "README.md": "# app\n", "check.mjs": "process.exit(0);\n", "package.json": JSON.stringify({ name: "app", scripts: { test: "node check.mjs" } }) });
  });
  afterEach(() => {
    closeApps();
    removeTempRepos();
  });

  async function summary(tools: Parameters<typeof toolsEnv>[0]) {
    const { tui } = openApp({ repo, env: await toolsEnv(tools) });
    await tui.waitFor("No runs here yet.");
    await tui.type("fix the cart total");
    await tui.press("enter");
    await tui.waitFor("save as workflow");
    return tui;
  }

  it("writes the task's workflow to the file named, adding .mjs, and says where; the file runs again with ahp run", async () => {
    const tui = await summary({ claude: "ready", codex: "ready", opencode: "ready" });
    await tui.type("w");
    await tui.waitFor("Save this task's workflow as");
    // Nothing typed yet: only Esc works. Once a name is there, Enter saves.
    expect(lastLine(tui.frame())).not.toContain("enter save");
    await tui.type("cart");
    expect(lastLine(tui.frame())).toContain("enter save");
    await tui.press("enter");
    const frame = await tui.waitFor("saved ");
    const path = join(realpathSync.native(repo), "cart.mjs");
    expect(frame).toContain("cart.mjs");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("export default");
    expect(text).toContain('"command": "npm test"');
    expect(text).toContain("ahp/fix-the-cart-total");
    expect(text).not.toContain("scripted mock");
  });

  it("refuses a file that is there, leaves it as it was, and lets the person name another", async () => {
    writeFileSync(join(repo, "cart.mjs"), "// mine\n");
    const tui = await summary({ claude: "ready" });
    await tui.type("w");
    await tui.waitFor("Save this task's workflow as");
    await tui.type("cart.mjs");
    await tui.press("enter");
    const refused = await tui.waitFor("already exists");
    expect(refused).toContain("it is not replaced");
    expect(colorAt(tui.raw(), "cart.mjs")).toBeDefined();
    expect(readFileSync(join(repo, "cart.mjs"), "utf8")).toBe("// mine\n");
    // Still asking: another name goes through.
    for (let i = 0; i < "cart.mjs".length; i++) await tui.press("backspace");
    await tui.type("cart2.mjs");
    await tui.press("enter");
    await tui.waitFor("saved ");
    expect(existsSync(join(repo, "cart2.mjs"))).toBe(true);
  });

  it("refuses a name that does not end in .mjs, with why, and esc leaves without writing", async () => {
    const tui = await summary({ claude: "ready" });
    await tui.type("w");
    await tui.waitFor("Save this task's workflow as");
    await tui.type("cart.json");
    await tui.press("enter");
    await tui.waitFor("the file must end in .mjs");
    expect(existsSync(join(repo, "cart.json"))).toBe(false);
    await tui.press("escape");
    await tui.waitFor("save as workflow");
  });

  it("says in the file when the scripted mock plays the steps", async () => {
    const run: TaskRun = {
      task: "fix the cart total",
      check: { command: "node check.mjs", source: "typed" },
      install: null,
      assignments: [{ role: "implement", adapter: "mock", tool: null, reason: "--mock" }, { role: "review", adapter: "mock", tool: null, reason: "--mock" }],
      branch: "ahp/fix-the-cart-total",
      remote: ".",
    };
    expect(renderWorkflowFile(run)).toContain("// The scripted mock plays implement, review: it is not a real coding agent, and its output is no evidence.");
    const path = await saveTaskWorkflow(repo, "mocked", run);
    await expect(saveTaskWorkflow(repo, "mocked", run)).rejects.toBeInstanceOf(WorkflowFileExistsError);
    expect(readFileSync(path, "utf8")).toContain("scripted mock");
  });
});

// The listing's model is data: the screens above are views over it.
describe("runsModel", () => {
  it("lists a run whose ledger cannot be read with its problem and marks it not openable", () => {
    const listing: RunListing = { runId: "run_x", state: null, lock: { state: "free" }, problem: "the hash chain is broken" };
    const [row] = runsModel([listing], Date.now());
    expect(row).toMatchObject({ runId: "run_x", openable: false, detail: "cannot be read: the hash chain is broken", usage: "" });
    expect(usageLine(listing)).toBe("");
  });
});
