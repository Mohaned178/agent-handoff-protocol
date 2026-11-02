import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/commands/main.ts";
import { prepareTask } from "../src/commands/task-command.ts";
import type { Values } from "../src/commands/args.ts";
import { settingsPath } from "../src/runtime/index.ts";
import { listRuns, validateWorkflow } from "../src/sdk/index.ts";
import { addBareRemote, remoteBranch } from "./helpers/external.ts";
import { fakeToolsDir, installFakeTool, pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, git, removeTempRepos } from "./helpers/repo.ts";

// Claude Code and Codex are installed and logged in here (fakes that answer only doctor's version and status commands);
// OpenCode is not. A test that casts real tools stops before an agent starts (`prepareTask`); the runs use the mock.
let saved: { PATH?: string; Path?: string };
async function onPath(path: string) {
  process.env.PATH = path;
  if (process.platform === "win32") process.env.Path = path;
}
beforeEach(() => {
  saved = { PATH: process.env.PATH, Path: process.env.Path };
});
afterEach(() => {
  delete process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = saved.PATH;
  if (process.platform === "win32") process.env.Path = saved.Path ?? saved.PATH;
  rmSync(settingsPath(), { force: true });
  removeTempRepos();
});

/** Puts a logged-in Claude Code and Codex on PATH, as `ahp doctor` finds tools. */
async function withTools() {
  const { dir, log } = fakeToolsDir();
  installFakeTool(dir, log, "claude", `if (argv[0] === "--version") console.log("2.1.311 (Claude Code)"); else console.log(JSON.stringify({ loggedIn: true }));`);
  installFakeTool(dir, log, "codex", `if (argv[0] === "--version") console.log("codex-cli 0.146.0");`);
  await onPath([dir, (await pathWithoutTools()).PATH].join(delimiter));
}

/** Runs the plain commands in this process, and keeps what they printed. */
async function ahpHere(args: string[], repo: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await main([...args, "--repo", repo], io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** What a task settles before an agent starts, and what it said. */
async function prepare(values: Values, repo: string, task = TASK) {
  const out: string[] = [];
  const io: Io = { stdout: (text) => out.push(text), stderr: (text) => out.push(`stderr: ${text}`) };
  const prepared = await prepareTask(task, { yes: true, ...values }, repo, io);
  return { prepared, stdout: out.join("\n") };
}

const CHECK = "check.mjs";
/** A project with nothing AHP can infer a check from; `node check.mjs` passes. */
const plainProject = (files: Record<string, string> = {}) => createTempRepo({ "README.md": "# app\n", [CHECK]: "process.exit(0);\n", ...files });
const TASK = "fix the cart total";
const runsOf = async (repo: string) => (await listRuns({ repo })).length;
const runIdIn = (stdout: string) => /run (run_[a-z0-9]+): /.exec(stdout)?.[1]!;
/** The summary's last line for `step`. */
const lineOf = (stdout: string, step: string) => stdout.split("\n").filter((line) => new RegExp(`^\\s+${step}\\s`).test(line)).at(-1) ?? "";
const saveSettings = (settings: unknown) => writeFileSync(settingsPath(), JSON.stringify(settings));
/** The step defaults saved so far: none when there is no settings file (the first real run also records its notice there). */
const savedSteps = () => (existsSync(settingsPath()) ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as { steps: unknown }).steps : {});

describe('ahp "<task>": the summary', () => {
  it("shows what it worked out from the project, with where each answer came from", async () => {
    const repo = plainProject({ "package.json": JSON.stringify({ scripts: { test: "node check.mjs" } }), "package-lock.json": "{}" });

    const { stdout } = await prepare({ mock: true }, repo);

    expect(stdout).toMatch(/task\s+fix the cart total/);
    expect(stdout).toMatch(/check\s+npm test\s+package\.json\n/);
    expect(stdout).toMatch(/install\s+npm ci\s+package-lock\.json\n/);
    expect(stdout).toMatch(/implement\s+mock\s+scripted, not a real agent/);
    expect(stdout).toMatch(/review\s+mock\s/);
    expect(stdout).not.toMatch(/^\s+plan\s/m);
    expect(stdout).toMatch(/result\s+branch ahp\/fix-the-cart-total, local only/);
    expect(await runsOf(repo)).toBe(0);
  });

  it("names the files the agents will not see because they are not committed", async () => {
    const repo = plainProject();
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "new.txt"), "x\n");

    const { stdout } = await prepare({ mock: true, check: "node check.mjs" }, repo);

    expect(stdout).toContain("2 files not committed: the agents will not see them");
  });

  it("adds the plan step with --plan, and numbers the branch when its name is taken", async () => {
    const repo = plainProject();
    git(repo, "branch", "ahp/fix-the-cart-total");

    const { stdout } = await prepare({ mock: true, plan: "", check: "node check.mjs" }, repo);

    expect(stdout).toMatch(/plan\s+mock\s/);
    expect(stdout.indexOf("plan ")).toBeLessThan(stdout.indexOf("implement "));
    expect(stdout).toContain("branch ahp/fix-the-cart-total-2, local only");
  });

  it("keeps two spaces between a long check and where it came from, so the source never reads as part of it", async () => {
    const { stdout } = await prepare({ mock: true, check: "node check.mjs --reporter=dot --long" }, plainProject());

    expect(stdout).toContain("node check.mjs --reporter=dot --long  --check\n");
  });

  it("says --no-check runs review only, labelled not verified", async () => {
    const { stdout, prepared } = await prepare({ mock: true, "no-check": true }, plainProject());

    expect(stdout).toMatch(/check\s+none: review only\s+not verified/);
    expect(prepared.run.check).toBeNull();
  });
});

describe('ahp "<task>": the check, run once on the last commit before any agent', () => {
  it("says when it already fails there, and goes on", async () => {
    const repo = createTempRepo({ "red.mjs": 'console.log("cart total: expected 30, got 10"); process.exit(1);\n' });

    const { stdout } = await prepare({ mock: true, check: "node red.mjs" }, repo);

    expect(stdout).toContain("the check already fails on your last commit: cart total: expected 30, got 10");
  });

  it("names a check command that does not exist, before any agent is spent on it", async () => {
    const { stdout } = await prepare({ mock: true, check: "no-such-check-cmd" }, createTempRepo({ "README.md": "x\n" }));

    expect(stdout).toMatch(/the check already fails on your last commit: .*no-such-check-cmd/);
  });

  it("says nothing when it passes, and is skipped with --no-precheck", async () => {
    const repo = createTempRepo({ "red.mjs": "process.exit(1);\n", "green.mjs": "process.exit(0);\n" });

    expect((await prepare({ mock: true, check: "node green.mjs" }, repo)).stdout).not.toContain("already fails");
    expect((await prepare({ mock: true, check: "node red.mjs", "no-precheck": true }, repo)).stdout).not.toContain("already fails");
  });
});

describe('ahp "<task>": who plays each step', () => {
  beforeEach(withTools);
  const CHECK_FLAG = { check: "node check.mjs" };

  it("sets a step's tool, model and effort for this run, and saves nothing", async () => {
    const { stdout } = await prepare({ ...CHECK_FLAG, review: "claude-code", "review-model": "opus", "implement-effort": "low" }, plainProject());

    expect(lineOf(stdout, "review")).toMatch(/Claude Code\s+opus$/);
    expect(lineOf(stdout, "implement")).toMatch(/Codex CLI\s+default model, effort low$/);
    expect(savedSteps()).toEqual({});
  });

  it("adds the plan step when a plan flag names its tool", async () => {
    const { stdout } = await prepare({ ...CHECK_FLAG, plan: "codex" }, plainProject());

    expect(lineOf(stdout, "plan")).toMatch(/Codex CLI\s+default model$/);
  });

  it.each<[string, string[], string]>([
    ["a tool that is not usable here", ["--review", "opencode"], "--review opencode: OpenCode is not usable here (not installed;"],
    ["a name that is no tool", ["--review", "gemini"], "--review must name claude-code, codex or opencode, not gemini"],
    ["an effort the tool does not have", ["--implement-effort", "extreme"], "--implement-effort extreme: Codex CLI's efforts are"],
    ["an empty model", ["--review-model", " "], "--review-model needs a model's name"],
    ["a step flag beside --mock", ["--mock", "--review", "codex"], "--mock casts every step"],
  ])("refuses %s before anything runs", async (_name, flags, message) => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--check", "node check.mjs", "--yes", ...flags], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("usage: ahp \"<task>\" --yes");
    expect(await listRuns({ repo })).toEqual([]);
  });

  it("uses the saved defaults and shows them as yours, and a flag still overrides them", async () => {
    saveSettings({ steps: { review: { tool: "claude-code", model: "opus" }, implement: { tool: "claude-code" } } });

    const { stdout } = await prepare({ ...CHECK_FLAG, implement: "codex" }, plainProject());

    expect(lineOf(stdout, "review")).toMatch(/Claude Code\s+opus · your default/);
    expect(lineOf(stdout, "implement")).toMatch(/Codex CLI\s+default model$/);
  });

  it("falls back to AHP's casting when a default's tool is no longer usable, and the summary says so", async () => {
    saveSettings({ steps: { review: { tool: "opencode", model: "opencode/big-pickle" } } });

    const { stdout } = await prepare(CHECK_FLAG, plainProject());

    expect(lineOf(stdout, "review")).toMatch(/Claude Code\s+default model · your default, OpenCode, is not usable here/);
  });

  it("leaves the saved defaults out, and says so, when the file cannot be read", async () => {
    writeFileSync(settingsPath(), "{ not json");

    const { stdout } = await prepare(CHECK_FLAG, plainProject());

    expect(stdout).toContain(`your saved defaults were not used: ${settingsPath()}`);
  });

  it("says once that agents run commands on this machine and their usage counts, then never again", async () => {
    const repo = plainProject();

    const first = await prepare(CHECK_FLAG, repo);
    const second = await prepare(CHECK_FLAG, repo);

    expect(first.stdout).toContain("first run with real agents: they run commands on this machine, and their usage counts against your own plans");
    expect(second.stdout).not.toContain("first run with real agents");
    expect(existsSync(settingsPath())).toBe(true);
  });

  it("does not say it for scripted agents", async () => {
    expect((await prepare({ mock: true, check: "node -e 0" }, plainProject())).stdout).not.toContain("first run with real agents");
  });

  it("refuses to run without a coding agent tool, naming how to install and log in to each, unless --mock asks for scripted agents", async () => {
    await onPath((await pathWithoutTools()).PATH!);
      const repo = plainProject();

    const run = await ahpHere([TASK, "--yes", "--check", "node check.mjs"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("no coding agent tool is usable here");
    for (const install of ["npm install -g @anthropic-ai/claude-code", "npm install -g @openai/codex", "npm install -g opencode-ai"]) expect(run.stderr).toContain(install);
    for (const logIn of ["run `claude` and type /login", "codex login", "opencode auth login"]) expect(run.stderr).toContain(logIn);
    expect(run.stderr).toContain("--mock");
    expect(existsSync(join(repo, ".git", "ahp")) ? readdirSync(join(repo, ".git", "ahp")) : []).toEqual([]);
  });
});

describe('ahp "<task>": running it', () => {
  it("runs implement → review → gate with --yes, stops at the gate for `ahp approve`, and puts the approved work on a local branch", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs"], repo);

    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toMatch(/check\s+node check\.mjs\s+--check/);
    expect(run.stdout).toContain("✓ implement  succeeded [mock]");
    expect(run.stdout).toContain("✓ review  succeeded [mock]");
    expect(run.stdout).toMatch(/^next: .*`ahp approve run_\w+ approve`/m);
    const approve = await ahpHere(["approve", runIdIn(run.stdout)], repo);
    expect(approve.code, approve.stdout).toBe(0);
    expect(git(repo, "show", "ahp/fix-the-cart-total:AHP-MOCK.md")).toContain(TASK);
    // No file was written: the workflow is the run's, in its ledger.
    expect(git(repo, "status", "--porcelain")).toBe("");
    const [listed] = await listRuns({ repo });
    expect(listed?.state?.state).toBe("succeeded");
    expect(listed?.state?.workflowName).toBe("fix-the-cart-total");
  });

  it("verifies implement with the check it inferred, after the install it inferred", async () => {
    const repo = plainProject({ "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "node check.mjs" } }) });

    const run = await ahpHere([TASK, "--mock", "--yes"], repo);

    // No one decides the gate: the run waits there, its implement step verified by `npm test`.
    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toMatch(/install\s+npm install\s+package\.json/);
    expect(run.stdout).toContain("✓ implement: `npm test` passed");
  });

  it("fails cleanly with --mock when the project's check fails, rather than leaving an attempt unknown", async () => {
    const repo = plainProject({ "red.mjs": "process.exit(1);\n" });

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node red.mjs"], repo);

    // The mock's scripts cover every attempt the retry budget allows, so the step fails as a step does.
    expect(run.code, run.stdout).toBe(1);
    expect(run.stdout).not.toContain("unknown");
    const [listed] = await listRuns({ repo });
    expect(listed?.state?.steps.find((step) => step.id === "implement")?.attempts).toHaveLength(3);
  });

  it("runs review only with --no-check, labelled not verified", async () => {
    const run = await ahpHere([TASK, "--mock", "--yes", "--no-check"], plainProject());

    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toMatch(/check\s+none: review only\s+not verified/);
    expect(run.stdout).toContain("! not verified: no check command");
  });

  it("pushes to origin with --push once approved", async () => {
    const repo = plainProject();
    const remote = addBareRemote(repo);

    const run = await ahpHere([TASK, "--mock", "--push", "--yes", "--check", "node check.mjs"], repo);

    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toMatch(/result\s+branch ahp\/fix-the-cart-total, pushed to origin once you approve/);
    expect(remoteBranch(remote, "ahp/fix-the-cart-total")).toBeNull();
    expect((await ahpHere(["approve", runIdIn(run.stdout)], repo)).code).toBe(0);
    expect(remoteBranch(remote, "ahp/fix-the-cart-total")).not.toBeNull();
  });

  it("pushes to the remote --push names", async () => {
    const repo = plainProject();
    const remote = addBareRemote(repo, "upstream");

    const run = await ahpHere([TASK, "--mock", "--push", "upstream", "--yes", "--check", "node check.mjs"], repo);

    expect(run.code, run.stdout).toBe(4);
    expect((await ahpHere(["approve", runIdIn(run.stdout)], repo)).code).toBe(0);
    expect(remoteBranch(remote, "ahp/fix-the-cart-total")).not.toBeNull();
  });

  it("writes the workflow with --save, for running again with ahp run", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs", "--save", "cart.workflow.mjs"], repo);

    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toContain(`saved the workflow to ${join(repo, "cart.workflow.mjs")}`);
    const savedWorkflow = ((await import(pathToFileURL(join(repo, "cart.workflow.mjs")).href)) as { default: unknown }).default;
    expect(validateWorkflow(savedWorkflow)).toEqual([]);
    expect((savedWorkflow as { steps: { id: string }[] }).steps.map((step) => step.id)).toEqual(["implement", "review", "approve", "publish"]);
  });
});

describe('ahp "<task>": refusals', () => {
  it("keeps a single unknown word an unknown command, so a misspelt command never starts agents", async () => {
    const repo = plainProject();

    const run = await ahpHere(["inspcet"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("unknown command: inspcet");
    expect(await runsOf(repo)).toBe(0);
  });

  it("says to quote a task given as separate words", async () => {
    const run = await ahpHere(["fix", "the", "cart"], plainProject());

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown command: fix (a task is one argument, in quotes: ahp "fix the cart")');
  });

  it("needs --yes: the app is where a task is shown and asked", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--check", "node check.mjs"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("pass --yes");
    expect(await runsOf(repo)).toBe(0);
  });

  it("needs --check when the project names no check", async () => {
    const run = await ahpHere([TASK, "--mock", "--yes"], plainProject());

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--check <command>");
    expect(run.stderr).toContain("--no-check");
  });

  it("refuses --no-check together with --check", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--yes", "--no-check", "--check", "node check.mjs"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--no-check and --check cannot be used together");
    expect(await runsOf(repo)).toBe(0);
  });

  it("refuses --push to a remote the repository does not have, before any agent starts", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--push", "--yes", "--check", "node check.mjs"], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('publishes to the remote "origin", which this repository does not have');
    expect(await runsOf(repo)).toBe(0);
  });

  it("refuses --save to a file that exists, and a file it could not import", async () => {
    const repo = plainProject({ "cart.workflow.mjs": "export default {};\n" });

    const exists = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs", "--save", "cart.workflow.mjs"], repo);
    expect(exists.code).toBe(2);
    expect(exists.stderr).toContain("already exists");
    const wrong = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs", "--save", "cart.json"], repo);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain("the file must end in .mjs");
    expect(await runsOf(repo)).toBe(0);
  });

  it("refuses an option the task does not have, with the task's usage line", async () => {
    const run = await ahpHere([TASK, "--mock", "--yes", "--reason", "x"], plainProject());

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("unknown option '--reason'");
    expect(run.stderr).toContain('usage: ahp "<task>" --yes');
  });

  it("refuses a folder that is not in a git repository, naming how it becomes one", async () => {
    const folder = createTempRepo({ "README.md": "x\n" });
    rmSync(join(folder, ".git"), { recursive: true, force: true });
    process.env.GIT_CEILING_DIRECTORIES = dirname(folder);

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node -e 0"], folder);

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/is not in a git repository: run ahp in your project's folder, or pass --repo <dir> \(a folder becomes one with `git init` and a first commit\)/);
  });
});
