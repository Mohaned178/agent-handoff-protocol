import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import { MOCK_USAGE_SOURCE } from "../src/index.ts";
import { listRuns } from "../src/sdk/index.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(() => removeTempRepos());

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

/** Runs `ahp` in this process with no terminal (the plain event log), and keeps what it printed. */
async function ahpHere(args: string[], repo: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await main([...args, "--repo", repo], io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const runIdIn = (stdout: string) => /run (run_[a-z0-9]+): /.exec(stdout)?.[1];

describe("ahp runs", () => {
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

describe("usage at the end of a run", () => {
  it("sums what each attempt's tool reported, per adapter, with its source, at the end of the run and in inspect", async () => {
    const reports = { ...hello, usage: { inputTokens: 1200, outputTokens: 300, cost: { amount: 0.25, currency: "USD" } } };
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(reports) });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(0);
    const line = `  mock: 1 of 1 attempt reported; inputTokens 1200 (1), outputTokens 300 (1), cost 0.25 USD (1); source: ${MOCK_USAGE_SOURCE}`;
    expect(run.stdout).toContain(`usage, as each tool reported it (per adapter, not summed across adapters; nothing is estimated):\n${line}`);
    const inspect = await ahpHere(["inspect", runIdIn(run.stdout)!], repo);
    expect(inspect.stdout).toContain(`  ${line}`);
  });

  it("says no usage was reported rather than show a number, when the tool reported none", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(hello) });

    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.stdout).toContain("  mock: none reported by 1 attempt");
    expect(run.stdout).not.toMatch(/inputTokens \d/);
  });

  it("prints the summary once when the run stops at a gate with no one here to decide it", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow(hello, { gate: true }) });

    // Without a person at the terminal the run stops at the gate: that is where this process leaves it.
    const run = await ahpHere(["run", join(repo, "workflow.mjs")], repo);

    expect(run.code).toBe(4);
    expect(run.stdout.match(/usage, as each tool reported it/g)).toHaveLength(1);
  });
});
