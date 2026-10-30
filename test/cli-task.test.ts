import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import type { Terminal } from "../src/cli/live.ts";
import type { Prompter } from "../src/setup/index.ts";
import { listRuns, validateWorkflow } from "../src/sdk/index.ts";
import { addBareRemote, remoteBranch } from "./helpers/external.ts";
import { pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, git, removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** A person at the terminal who gives these answers, in order, and the questions they were asked. */
function person(answers: unknown[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async <T>(message: string) => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`no answer scripted for: ${message}`);
    return answers.shift() as T;
  };
  return { asked, select: ({ message }) => next(message), checkbox: ({ message }) => next(message), input: ({ message }) => next(message), confirm: ({ message }) => next(message), say: () => undefined };
}

/** Runs `ahp` in this process: in a terminal with `prompter`, or, with none, as a pipe would. */
async function ahpHere(args: string[], repo: string, prompter: Prompter | null) {
  const printed: string[] = [];
  const terminal: Terminal = { write: () => undefined, columns: () => 100, color: false, compact: true, prompter };
  const io: Io = { stdout: (text) => printed.push(text), stderr: (text) => printed.push(`stderr: ${text}`), ...(prompter ? { terminal } : {}) };
  const code = await main([...args, "--repo", repo], io);
  return { code, stdout: printed.join("\n") };
}

const CHECK = "check.mjs";
/** A project with nothing AHP can infer a check from; `node check.mjs` passes. */
const plainProject = (files: Record<string, string> = {}) => createTempRepo({ "README.md": "# app\n", [CHECK]: "process.exit(0);\n", ...files });
const TASK = "fix the cart total";
const runsOf = async (repo: string) => (await listRuns({ repo })).length;

describe("ahp \"<task>\": the summary", () => {
  it("shows what it worked out from the project, with where each answer came from, and Cancel starts nothing", async () => {
    const repo = plainProject({ "package.json": JSON.stringify({ scripts: { test: "node check.mjs" } }), "package-lock.json": "{}" });
    const prompter = person(["cancel"]);

    const run = await ahpHere([TASK, "--mock"], repo, prompter);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/task\s+fix the cart total/);
    expect(run.stdout).toMatch(/check\s+npm test\s+\(from package\.json\)/);
    expect(run.stdout).toMatch(/install\s+npm ci\s+\(from package-lock\.json\)/);
    expect(run.stdout).toMatch(/implement\s+Mock \(scripted\)\s+no real agent: its output is no evidence/);
    expect(run.stdout).toMatch(/review\s+Mock \(scripted\)/);
    expect(run.stdout).not.toMatch(/^\s+plan\s/m);
    expect(run.stdout).toMatch(/result\s+local branch ahp\/fix-the-cart-total\s+\(nothing is pushed\)/);
    expect(prompter.asked).toEqual(["Run it?"]);
    expect(run.stdout).toContain("cancelled: nothing was started");
    expect(await runsOf(repo)).toBe(0);
  });

  it("names the files the agents will not see because they are not committed", async () => {
    const repo = plainProject();
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "new.txt"), "x\n");

    const run = await ahpHere([TASK, "--mock", "--check", "node check.mjs"], repo, person(["cancel"]));

    expect(run.stdout).toContain("agents work from your last commit; 2 changed files are not in it");
  });

  it("adds the plan step with --plan, and numbers the branch when its name is taken", async () => {
    const repo = plainProject();
    git(repo, "branch", "ahp/fix-the-cart-total");

    const run = await ahpHere([TASK, "--mock", "--plan", "--check", "node check.mjs"], repo, person(["cancel"]));

    expect(run.stdout).toMatch(/plan\s+Mock \(scripted\)/);
    expect(run.stdout.indexOf("plan ")).toBeLessThan(run.stdout.indexOf("implement "));
    expect(run.stdout).toContain("local branch ahp/fix-the-cart-total-2");
  });
});

describe("ahp \"<task>\": running it", () => {
  it("asks for a check it cannot find, runs implement → review → gate, and puts the approved work on a local branch", async () => {
    const repo = plainProject();
    const prompter = person(["type", "node check.mjs", "run", "approve"]);

    const run = await ahpHere([TASK, "--mock"], repo, prompter);

    expect(run.code, run.stdout).toBe(0);
    expect(prompter.asked[0]).toMatch(/no command that checks the work/);
    expect(run.stdout).toMatch(/check\s+node check\.mjs\s+\(you typed it\)/);
    expect(git(repo, "show", "ahp/fix-the-cart-total:AHP-MOCK.md")).toContain(TASK);
    // No file was written: the workflow is the run's, in its ledger.
    expect(git(repo, "status", "--porcelain")).toBe("");
    const [listed] = await listRuns({ repo });
    expect(listed?.state?.state).toBe("succeeded");
    expect(listed?.state?.workflowName).toBe("fix-the-cart-total");
  });

  it("offers review only when there is no check, and labels the work not verified", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock"], repo, person(["none", "run", "approve"]));

    expect(run.code, run.stdout).toBe(0);
    expect(run.stdout).toMatch(/check\s+none: review only\s+\(not verified: no check command\)/);
    expect(git(repo, "show", "ahp/fix-the-cart-total:AHP-MOCK.md")).toContain(TASK);
  });

  it("verifies implement with the check it inferred, after the install it inferred", async () => {
    const repo = plainProject({ "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "node check.mjs" } }) });

    const run = await ahpHere([TASK, "--mock", "--yes"], repo, null);

    // No one at a terminal decides the gate: the run waits there, its implement step verified by `npm test`.
    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toMatch(/install\s+npm install\s+\(from package\.json\)/);
    expect(run.stdout).toMatch(/step implement: verifying \[mock\]: npm test\n(.*\n)*step implement: verification pass /);
  });

  it("runs with --yes and no terminal, and stops at the gate for `ahp approve`", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs"], repo, null);

    expect(run.code, run.stdout).toBe(4);
    expect(run.stdout).toMatch(/check\s+node check\.mjs\s+\(--check\)/);
    expect(run.stdout).toContain("ahp approve");
  });

  it("pushes to origin with --push once approved", async () => {
    const repo = plainProject();
    const remote = addBareRemote(repo);

    const run = await ahpHere([TASK, "--mock", "--push", "--check", "node check.mjs"], repo, person(["run", "approve"]));

    expect(run.code, run.stdout).toBe(0);
    expect(run.stdout).toMatch(/result\s+branch ahp\/fix-the-cart-total\s+\(pushed to origin once you approve\)/);
    expect(remoteBranch(remote, "ahp/fix-the-cart-total")).not.toBeNull();
  });

  it("pushes to the remote --push names", async () => {
    const repo = plainProject();
    const remote = addBareRemote(repo, "upstream");

    const run = await ahpHere([TASK, "--mock", "--push", "upstream", "--yes", "--check", "node check.mjs"], repo, person(["approve"]));

    expect(run.code, run.stdout).toBe(0);
    expect(remoteBranch(remote, "ahp/fix-the-cart-total")).not.toBeNull();
  });

  it("writes the workflow with --save, for running again with ahp run", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs", "--save", "cart.workflow.mjs"], repo, null);

    expect(run.code, run.stdout).toBe(4);
    const saved = ((await import(pathToFileURL(join(repo, "cart.workflow.mjs")).href)) as { default: unknown }).default;
    expect(validateWorkflow(saved)).toEqual([]);
    expect((saved as { steps: { id: string }[] }).steps.map((step) => step.id)).toEqual(["implement", "review", "approve", "publish"]);
  });
});

describe("ahp \"<task>\": refusals", () => {
  it("keeps a single unknown word an unknown command, so a misspelt command never starts agents", async () => {
    const repo = plainProject();

    const run = await ahpHere(["inspcet"], repo, person([]));

    expect(run.code).toBe(2);
    expect(run.stdout).toContain("unknown command: inspcet");
    expect(await runsOf(repo)).toBe(0);
  });

  it("says to quote a task given as separate words", async () => {
    const repo = plainProject();

    const run = await ahpHere(["fix", "the", "cart"], repo, person([]));

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('unknown command: fix (a task is one argument, in quotes: ahp "fix the cart")');
  });

  it("needs --yes without a terminal", async () => {
    const run = await ahpHere([TASK, "--mock", "--check", "node check.mjs"], plainProject(), null);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain("--yes");
  });

  it("needs --check without a terminal when the project names no check", async () => {
    const run = await ahpHere([TASK, "--mock", "--yes"], plainProject(), null);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain("--check <command>");
  });

  it("refuses --push to a remote the repository does not have, before any agent starts", async () => {
    const repo = plainProject();

    const run = await ahpHere([TASK, "--mock", "--push", "--yes", "--check", "node check.mjs"], repo, null);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('publishes to the remote "origin", which this repository does not have');
    expect(await runsOf(repo)).toBe(0);
  });

  it("refuses --save to a file that exists", async () => {
    const repo = plainProject({ "cart.workflow.mjs": "export default {};\n" });

    const run = await ahpHere([TASK, "--mock", "--yes", "--check", "node check.mjs", "--save", "cart.workflow.mjs"], repo, null);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain("already exists");
    expect(await runsOf(repo)).toBe(0);
  });

  it("refuses to run without a coding agent tool, unless --mock asks for scripted agents", async () => {
    const repo = plainProject();
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    const env = await pathWithoutTools();
    process.env.PATH = env.PATH;
    if (process.platform === "win32") process.env.Path = env.PATH;
    try {
      const run = await ahpHere([TASK, "--yes", "--check", "node check.mjs"], repo, null);

      expect(run.code).toBe(2);
      expect(run.stdout).toContain("no coding agent tool is usable here");
      expect(run.stdout).toContain("--mock");
    } finally {
      process.env.PATH = saved.PATH;
      if (process.platform === "win32") process.env.Path = saved.Path ?? saved.PATH;
    }
    expect(existsSync(join(repo, ".git", "ahp")) ? readdirSync(join(repo, ".git", "ahp")) : []).toEqual([]);
  });
});
