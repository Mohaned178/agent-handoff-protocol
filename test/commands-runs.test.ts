import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/commands/main.ts";
import { MOCK_USAGE_SOURCE } from "../src/index.ts";
import { demosRoot } from "../src/runtime/index.ts";
import { listRuns } from "../src/sdk/index.ts";
import { plain } from "./helpers/cli.ts";
import { remoteBranch } from "./helpers/external.ts";
import { pathWithoutTools } from "./helpers/fake-tools.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

// `ahp demo` and `ahp doctor` look at this machine's tools: never the real ones in a test.
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

const hello = { edits: [{ path: "greeting.txt", content: "hello\n" }], outputFields: { summary: "Wrote the greeting." } };

const workflow = (attempt: object, { gate = false } = {}) => `export default {
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: [${JSON.stringify(attempt)}] } },
      verification: { command: "node verify.mjs" },
      retry: { budget: 0 },
    },
    ${gate ? `{ id: "approve", approval: {} },` : ""}
  ],
};
`;

/** Runs the plain commands in this process, and keeps what they printed. */
async function ahpHere(args: string[], repo?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await main(repo === undefined ? args : [...args, "--repo", repo], io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const runIdIn = (stdout: string) => /run (run_[a-z0-9]+): /.exec(stdout)?.[1];

describe("ahp runs and ahp inspect with no ID", () => {
  it("says there are no runs yet, and how to start one", async () => {
    const repo = createTempRepo({ "README.md": "x\n" });

    const runs = await ahpHere(["runs"], repo);
    const inspect = await ahpHere(["inspect"], repo);

    expect(runs.code).toBe(0);
    expect(runs.stdout).toMatch(/^no runs in .+ yet: `ahp run <workflow-file>` starts one$/);
    expect(inspect.code).toBe(2);
    expect(inspect.stderr).toMatch(/no runs in .+ yet/);
  });

  it("lists runs newest first, with the command that decides a run waiting at a gate", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "plain.mjs": workflow(hello), "gated.mjs": workflow(hello, { gate: true }) });
    const first = runIdIn((await ahpHere(["run", join(repo, "plain.mjs")], repo)).stdout)!;
    const gated = await ahpHere(["run", join(repo, "gated.mjs")], repo);
    expect(gated.code).toBe(4);
    const second = runIdIn(gated.stdout)!;

    const runs = await ahpHere(["runs"], repo);

    expect(runs.code).toBe(0);
    const lines = runs.stdout.split("\n");
    const at = (runId: string) => lines.findIndex((line) => line.trimStart().startsWith(runId));
    expect(at(second)).toBeGreaterThan(0);
    expect(at(second)).toBeLessThan(at(first));
    expect(lines[at(second)]).toMatch(/waiting_approval +greeting +\d{4}-\d\d-\d\d \d\d:\d\d \[mock\]$/);
    expect(lines[at(second) + 1]).toBe(`      next: \`ahp approve ${second} approve\`, or \`ahp reject ${second} approve --reason "..."\``);
    expect(lines[at(first)]).toMatch(/succeeded +greeting/);
    // A run that ended has nothing to do next.
    expect(lines[at(first) + 1] ?? "").not.toContain("next:");

    const json = JSON.parse((await ahpHere(["runs", "--json"], repo)).stdout) as { runId: string; state: { state: string } }[];
    expect(json.map((listing) => [listing.runId, listing.state.state])).toEqual([
      [second, "waiting_approval"],
      [first, "succeeded"],
    ]);

    // With no run ID, inspect shows the newest run.
    const inspect = await ahpHere(["inspect"], repo);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(`run ${second}: waiting_approval`);
  });

  it("lists a run whose ledger is broken with a pointer to inspect, rather than failing", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "plain.mjs": workflow(hello) });
    const good = runIdIn((await ahpHere(["run", join(repo, "plain.mjs")], repo)).stdout)!;
    const broken = "run_broken1";
    const dir = join(repo, ".git", "ahp", "runs", broken);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ seq: 0, prevHash: null, hash: "not the hash", type: "run_created" })}\n`);

    const listings = await listRuns({ repo });

    expect(listings.map((listing) => listing.runId)).toEqual([good, broken]);
    expect(listings[1]).toMatchObject({ state: null, problem: expect.any(String) });
    const runs = await ahpHere(["runs"], repo);
    expect(runs.stdout).toMatch(new RegExp(`${broken} +unreadable +\\?`));
    expect(runs.stdout).toContain(`next: \`ahp inspect ${broken}\` says what is wrong with its ledger`);
  });

  it("shows only the newest 20 runs unless --all is given", async () => {
    const repo = createTempRepo({ "README.md": "x\n" });
    const ledger = (runId: string) => join(repo, ".git", "ahp", "runs", runId, "ledger.jsonl");
    // Unreadable ledgers are enough to count rows: each is listed, by ID.
    for (let index = 0; index < 22; index += 1) {
      const runId = `run_x${String(index).padStart(2, "0")}`;
      mkdirSync(join(ledger(runId), ".."), { recursive: true });
      writeFileSync(ledger(runId), "{}\n");
    }

    const shown = await ahpHere(["runs"], repo);
    const all = await ahpHere(["runs", "--all"], repo);

    const rows = (stdout: string) => stdout.split("\n").filter((line) => /^ {2}run_x\d\d /.test(line)).length;
    expect(rows(shown.stdout)).toBe(20);
    expect(shown.stdout).toContain("2 older runs not shown: `ahp runs --all` lists every run");
    expect(rows(all.stdout)).toBe(22);
    expect(all.stdout).not.toContain("not shown");
  });
});

describe("the receipt at the end of a run", () => {
  it("says what each tool reported using, per adapter with its source, at the end of the run and in inspect", async () => {
    const reports = { ...hello, usage: { inputTokens: 1200, outputTokens: 300, cost: { amount: 0.25, currency: "USD" } } };
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(reports) });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^usage: mock 1\.2k in · 300 out · 0\.25 USD \(as reported; .+\)$/m);
    expect(run.stdout).toContain(MOCK_USAGE_SOURCE);
    const line = `  mock: 1 of 1 attempt reported; inputTokens 1200 (1), outputTokens 300 (1), cost 0.25 USD (1); source: ${MOCK_USAGE_SOURCE}`;
    const inspect = await ahpHere(["inspect", runIdIn(run.stdout)!], repo);
    expect(inspect.stdout).toContain(`  usage, as each tool reported it (per adapter, not summed across adapters; nothing is estimated):\n  ${line}`);
  });

  it("says no usage was reported rather than show a number, when the tool reported none", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(hello) });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.stdout).toContain("usage: mock reported none");
    expect(run.stdout).not.toMatch(/\d+(\.\d)?k? in/);
  });

  it("says it once when the run stops at a gate, with the one next line and exit code 4", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(hello, { gate: true }) });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(4);
    expect(run.stdout.match(/^usage: /gm)).toHaveLength(1);
    expect(run.stdout.match(/^next: /gm)).toHaveLength(1);
    expect(run.stdout).toContain("! approve  waits for a person");
  });

  it("is a line for each step that ends: a failed check names the step, the class and what failed, and exit code 1", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow({ edits: [{ path: "greeting.txt", content: "goodbye\n" }] }) });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("✗ implement  failed (verification_failed) [mock]");
    expect(run.stdout).toContain("last attempt att_");
    expect(run.stdout).toContain("greeting missing or wrong");
  });
});

describe("ahp run says which repository it uses", () => {
  it("names the repository before the run starts", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(hello) });

    const run = plain(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(0);
    expect(run.stdout.split("\n")[0]).toBe(`repository: ${repo}`);
  });

  it("refuses a home folder kept under git unless --repo names it", () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(hello) });
    const sub = join(repo, "projects", "new");
    mkdirSync(sub, { recursive: true });
    const home = { HOME: repo, USERPROFILE: repo };

    const refused = plain(["run", join(repo, "workflow.mjs")], sub, home);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(`the git repository around ${sub} is your home folder (${repo})`);
    expect(refused.stderr).not.toContain("Usage: ahp");
    expect(refused.stdout).not.toContain("created");

    const named = plain(["run", join(repo, "workflow.mjs"), "--repo", repo], sub, home);
    expect(named.code).toBe(0);
  });

  it("says plainly when there is no repository, with the command's usage line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahp-guidance-"));
    dirs.push(dir);
    writeFileSync(join(dir, "workflow.mjs"), workflow(hello));

    const run = plain(["run", "workflow.mjs"], dir, { GIT_CEILING_DIRECTORIES: dirname(dir) });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`${dir} is not in a git repository: run ahp in your project's folder, or pass --repo <dir>`);
    expect(run.stderr).toContain("usage: ahp run <workflow-file> [--repo <dir>]");
    expect(run.stderr).not.toContain("Usage: ahp");
  });

  it("refuses to start a run that would push to a remote the repository does not have, before any agent works", async () => {
    const pushing = `export default { name: "w", steps: [
  { id: "implement", agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: "hello\\n" }] }] } }, verification: { command: "node verify.mjs" } },
  { id: "approve", approval: {} },
  { id: "publish", action: { kind: "push_branch", branch: "ahp/x" } },
] };
`;
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": pushing });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('step "publish" publishes to the remote "origin", which this repository does not have');
    expect((await ahpHere(["runs"], repo)).stdout).toContain("no runs in");
  });
});

describe("ahp doctor", () => {
  it("says how to install each tool that is missing, and ends with where a bug goes", async () => {
    const doctor = await ahpHere(["doctor"]);

    expect(doctor.code).toBe(0);
    for (const install of ["npm install -g @anthropic-ai/claude-code", "npm install -g @openai/codex", "npm install -g opencode-ai"]) expect(doctor.stdout).toContain(`to install: ${install}`);
    expect(doctor.stdout).toContain("To report a bug: https://github.com/Mohaned178/agent-handoff-protocol/issues/new/choose");
  });

  it("prints the report as JSON with --json, led by AHP's version", async () => {
    const doctor = await ahpHere(["doctor", "--json"]);

    const report = JSON.parse(doctor.stdout) as { ahp: string; tools: { id: string; installed: boolean }[] };
    expect(report.ahp).toMatch(/^\d+\.\d+\.\d+ \(alpha\)$/);
    expect(report.tools.map((tool) => tool.id)).toEqual(["claude-code", "codex", "opencode"]);
    expect((await ahpHere(["doctor", "extra"])).code).toBe(2);
  });
});

describe("ahp demo", () => {
  const demos = () => {
    try {
      return readdirSync(demosRoot());
    } catch {
      return [];
    }
  };

  it("runs the reference scenario in a sample project it makes, stops at the gate, and pushes to its stand-in remote once approved", async () => {
    const before = demos();

    const demo = await ahpHere(["demo"]);

    expect(demo.code).toBe(4);
    expect(demo.stdout).toContain("agents: scripted mock agents, free and instant");
    const made = demos().filter((name) => !before.includes(name));
    expect(made).toHaveLength(1);
    const dir = join(demosRoot(), made[0]!);
    const project = join(dir, "project");
    expect(demo.stdout).toContain(`The demo is kept in ${dir}: \`cd ${project}\`, then \`ahp runs\` or \`ahp inspect\`, and \`ahp approve <run-id>\` to finish it.`);
    // The workflow holds the hidden test, so it is never committed where an agent's copy would have it.
    expect(git(project, "ls-files")).toBe("README.md");

    const approve = await ahpHere(["approve", runIdIn(demo.stdout)!], project);
    expect(approve.code).toBe(0);
    expect(remoteBranch(join(dir, "remote.git"), "ahp/password-reset")).not.toBeNull();
    expect(git(join(dir, "remote.git"), "show", "ahp/password-reset:src/password-reset.mjs")).toContain("export function requestReset");
  });

  it("needs --yes for --real, which spends the person's own usage, and falls back to the mock when no tool is usable", async () => {
    const refused = await ahpHere(["demo", "--real"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("their usage counts against your plans: pass --yes");

    const demo = await ahpHere(["demo", "--real", "--yes"]);
    expect(demo.code).toBe(4);
    expect(demo.stdout).toContain("none of your tools is usable here (`ahp doctor` says why), so the scripted mock plays every step");
  });
});
