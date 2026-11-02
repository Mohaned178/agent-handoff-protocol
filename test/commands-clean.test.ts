import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type Io } from "../src/commands/main.ts";
import { runWorkflow } from "../src/index.ts";
import { worktreeRoot } from "../src/runtime/paths.ts";
import { gatedWorkflow } from "./helpers/approval.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello, retryWorkflow } from "./helpers/retry.ts";
import { implemented, implementStep } from "./helpers/review.ts";

let repo: string;
let passed: string;
let gate: string;

const worktreesOf = (runId: string) => {
  const dir = join(worktreeRoot(), runId);
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** Runs the plain commands in this process, and keeps what they printed. */
async function ahpHere(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await main([...args, "--repo", repo], io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

// One repository with a run that passed and one waiting at its approval gate; both left their worktrees behind.
beforeAll(async () => {
  repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  passed = (await runWorkflow(retryWorkflow([hello]), { repo })).runId;
  gate = (await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo })).runId;
}, 120_000);
afterAll(removeTempRepos);

describe("ahp clean", () => {
  it("says with --dry-run what would go and what stays, and removes nothing", async () => {
    const before = [worktreesOf(passed), worktreesOf(gate)];

    const clean = await ahpHere(["clean", "--dry-run"]);

    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain(`would remove  ${passed.replace(/^run_/, "")}`);
    expect(clean.stdout).toContain(`kept     ${gate.replace(/^run_/, "")}`);
    expect(clean.stdout).toContain("waiting for your approval at approve");
    expect(clean.stdout).toMatch(/Would remove \d+ worktrees? of 1 ended run, freeing /);
    expect([worktreesOf(passed), worktreesOf(gate)]).toEqual(before);
  });

  it("removes the worktrees of the run that ended, keeps those of the run waiting for a person, and says the rest is still needed the second time", async () => {
    const kept = worktreesOf(gate);

    const clean = await ahpHere(["clean"]);

    expect(clean.code).toBe(0);
    expect(clean.stdout).toMatch(/Removed \d+ worktrees? of 1 ended run, freed /);
    expect(clean.stdout).toContain("Ledgers and snapshots are kept.");
    expect(worktreesOf(passed)).toEqual([]);
    expect(worktreesOf(gate)).toEqual(kept);
    expect(existsSync(join(repo, ".git", "ahp", "runs", passed, "ledger.jsonl"))).toBe(true);

    const again = await ahpHere(["clean"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Nothing to remove: every run with worktrees is still needed.");
  });

  it("takes no argument and refuses an option it does not have, with its usage line", async () => {
    const extra = await ahpHere(["clean", "now"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("unexpected argument: now");
    const flag = await ahpHere(["clean", "--all"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain("usage: ahp clean [--dry-run] [--repo <dir>]");
  });
});
