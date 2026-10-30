import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import type { Terminal } from "../src/cli/live.ts";
import { initWorkflow } from "../src/doctor/index.ts";
import { demosRoot } from "../src/runtime/index.ts";
import type { Prompter } from "../src/setup/index.ts";
import { validateWorkflow } from "../src/sdk/index.ts";
import { pathWithoutTools } from "./helpers/fake-tools.ts";
import { addBareRemote } from "./helpers/external.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

// `ahp demo` and `ahp setup` look at this machine's tools as `ahp doctor` does: never the real ones in a test.
let savedPath: { PATH?: string; Path?: string };
beforeEach(async () => {
  savedPath = { PATH: process.env.PATH, Path: process.env.Path };
  const env = await pathWithoutTools();
  process.env.PATH = env.PATH;
  if (process.platform === "win32") process.env.Path = env.PATH;
});
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = savedPath.PATH;
  if (process.platform === "win32") process.env.Path = savedPath.Path ?? savedPath.PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  removeTempRepos();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A person at the terminal who gives these answers, in order. */
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
async function ahpHere(args: string[], prompter: Prompter | null) {
  const printed: string[] = [];
  const terminal: Terminal = { write: () => undefined, columns: () => 100, color: false, compact: true, prompter };
  const io: Io = { stdout: (text) => printed.push(text), stderr: (text) => printed.push(`stderr: ${text}`), ...(prompter ? { terminal } : {}) };
  const code = await main(args, io);
  return { code, stdout: printed.join("\n") };
}

/** A folder that is not in any git repository, holding one file. */
function plainFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "ahp-start-"));
  dirs.push(dir);
  writeFileSync(join(dir, "README.md"), "my project\n");
  return dir;
}

const demos = () => { try { return readdirSync(demosRoot()); } catch { return []; } };

/** The one demo `ahp demo` made since `before` was listed. */
function theDemo(before: string[]): { project: string; remote: string; dir: string } {
  const made = demos().filter((name) => !before.includes(name));
  expect(made).toHaveLength(1);
  const dir = join(demosRoot(), made[0]!);
  return { dir, project: join(dir, "project"), remote: join(dir, "remote.git") };
}

describe("ahp demo", () => {
  it("runs the reference scenario in a sample project it makes, and pushes to its stand-in remote once approved", async () => {
    const before = demos();
    const demo = await ahpHere(["demo"], person(["approve"]));

    expect(demo.code).toBe(0);
    expect(demo.stdout).toContain("agents: scripted mock agents, free and instant");
    expect(demo.stdout).toMatch(/✓ run succeeded/);
    const { dir, project, remote } = theDemo(before);
    expect(demo.stdout).toContain(`The demo is kept in ${dir}`);
    expect(git(remote, "show", "ahp/password-reset:src/password-reset.mjs")).toContain("export function requestReset");
    // The workflow holds the hidden test, so it is never committed where an agent's copy would have it.
    expect(git(project, "ls-files")).toBe("README.md");
  });

  it("stops at the gate with no one to approve, and says how to finish it", async () => {
    const before = demos();
    const demo = await ahpHere(["demo"], null);

    expect(demo.code).toBe(4);
    const { project } = theDemo(before);
    expect(demo.stdout).toContain(`\`cd ${project}\`, then \`ahp runs\` or \`ahp inspect\` to look at what happened, and \`ahp approve\` to finish it`);
  });

  it("falls back to the mock with --real when no tool is usable, and says so", async () => {
    const demo = await ahpHere(["demo", "--real"], null);

    expect(demo.code).toBe(4);
    expect(demo.stdout).toContain("none of your tools is usable here (`ahp doctor` says why), so the scripted mock plays every step");
  });
});

describe("ahp with no command", () => {
  it("prints the guide when no one is at a terminal", async () => {
    const guide = await ahpHere([], null);

    expect(guide.code).toBe(0);
    expect(guide.stdout).toContain("ahp demo");
  });

  it("in a terminal, makes a plain folder a repository when asked, then sets up, runs and publishes to a local branch", async () => {
    const dir = plainFolder();
    const prompter = person([
      true, // make it a git repository
      "workflow",
      "example",
      "mock", "mock", "mock",
      "ahp/reset",
      "ahp.workflow.mjs",
      true, // start it now
      "approve",
    ]);

    const run = await ahpHere(["--repo", dir], prompter);

    expect(run.code, run.stdout).toBe(0);
    expect(prompter.asked[0]).toContain("is not a git repository");
    expect(prompter.asked).toContain("Branch AHP makes in this repository after your approval (it has no remote named origin):");
    // What was in the folder is the first commit; the approved work is on a branch here, for the person to merge.
    expect(git(dir, "show", "HEAD:README.md")).toBe("my project");
    expect(git(dir, "show", "ahp/reset:src/password-reset.mjs")).toContain("export function resetPassword");
    expect(run.stdout).toContain("made branch ahp/reset: `git merge ahp/reset` takes it into your branch");
  });

  it("changes nothing when the person says no", async () => {
    const dir = plainFolder();

    const run = await ahpHere(["--repo", dir], person([false]));

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("setup stopped: AHP works on a git repository with a commit, and nothing was changed");
    expect(readdirSync(dir)).toEqual(["README.md"]);
  });

  it("offers a first commit to a repository that has none", async () => {
    const dir = plainFolder();
    git(dir, "init", "--quiet");
    const prompter = person([true]);

    // The setup questions after it are not scripted: the commit is made before them.
    await ahpHere(["--repo", dir], prompter);

    expect(prompter.asked[0]).toContain("has no commit yet");
    expect(git(dir, "show", "HEAD:README.md")).toBe("my project");
  });
});

describe("a home folder kept under git", () => {
  it("is not taken for the project: a folder below it is offered a repository of its own", async () => {
    const home = createTempRepo({ "notes.txt": "x\n" });
    const dir = join(home, "my-project");
    mkdirSync(dir);
    writeFileSync(join(dir, "README.md"), "my project\n");
    const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" };
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, ...Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]])) };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    // With HOME moved, git's global identity is not found; the person's own would be in real use.
    Object.assign(process.env, identity);
    try {
      const prompter = person([true]);
      await ahpHere(["--repo", dir], prompter);

      expect(prompter.asked[0]).toContain(`${dir} is not a git repository`);
      expect(realpathSync.native(git(dir, "rev-parse", "--show-toplevel"))).toBe(realpathSync.native(dir));
      expect(git(dir, "show", "HEAD:README.md")).toBe("my project");

      // The home folder itself is refused outright.
      const refused = await ahpHere(["--repo", home], person([]));
      expect(refused.code).toBe(2);
      expect(refused.stdout).toContain("is your home folder, not a project");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("publishing without a remote", () => {
  it("has ahp init write a workflow that puts the approved work on a local branch when there is no origin", async () => {
    const repo = createTempRepo({ "README.md": "x\n" });

    const init = await initWorkflow({ dir: repo });

    expect(init.remote).toBe(".");
    const text = readFileSync(init.path, "utf8");
    expect(text).toContain('"remote": "."');
    expect(text).toContain("there was no remote named origin");
  });

  it("keeps origin when the repository has one", async () => {
    const repo = createTempRepo({ "README.md": "x\n" });
    addBareRemote(repo);

    expect((await initWorkflow({ dir: repo })).remote).toBe("origin");
  });

  it("allows \".\" only for a push: a pull request needs a hosted remote", () => {
    const gated = (action: object) => ({
      name: "w",
      steps: [{ id: "implement", agent: { adapter: "mock", options: { attempts: [{}] } }, verification: { requiredOutputFields: ["summary"] } }, { id: "approve", approval: {} }, { id: "publish", action }],
    });

    expect(validateWorkflow(gated({ kind: "push_branch", branch: "b", remote: "." }))).toEqual([]);
    expect(validateWorkflow(gated({ kind: "open_pr", branch: "b", base: "main", title: "t", remote: "." }))).toContainEqual(
      expect.stringContaining('"." is this repository, which has no pull requests'),
    );
  });

  it("refuses to start a run that would push to a remote the repository does not have, before any agent works", async () => {
    const workflow = `export default { name: "w", steps: [
  { id: "implement", agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: "hello\\n" }] }] } }, verification: { command: "node verify.mjs" } },
  { id: "approve", approval: {} },
  { id: "publish", action: { kind: "push_branch", branch: "ahp/x" } },
] };
`;
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow });

    const run = await ahpHere(["run", join(repo, "workflow.mjs"), "--repo", repo], null);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('step "publish" publishes to the remote "origin", which this repository does not have');
    expect((await ahpHere(["runs", "--repo", repo], null)).stdout).toContain("no runs in");
  });
});
