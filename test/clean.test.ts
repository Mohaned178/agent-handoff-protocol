import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanRuns, formatClean, sizeText } from "../src/commands/clean.ts";
import { runWorkflow, type RunView } from "../src/index.ts";
import { worktreeRoot } from "../src/runtime/paths.ts";
import { gatedWorkflow } from "./helpers/approval.ts";
import { git, createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";
import { implemented, implementStep } from "./helpers/review.ts";

let repo: string;
const runs = {} as Record<"passed" | "failed" | "recovery" | "gate", { runId: string; state: RunView }>;

const worktreesOf = (runId: string) => {
  const dir = join(worktreeRoot(), runId);
  return existsSync(dir) ? readdirSync(dir) : [];
};
const registered = () => git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length - 1;

// One repository with four runs that left their attempts' worktrees behind (AHP never removes them itself).
beforeAll(async () => {
  repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  runs.passed = await runWorkflow(retryWorkflow([hello]), { repo });
  runs.failed = await runWorkflow(retryWorkflow([goodbye], { retry: { budget: 0 } }), { repo });
  runs.gate = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo });
  // The attempt after the failed one has no script: its outcome is unknown.
  runs.recovery = await runWorkflow(retryWorkflow([goodbye]), { repo });
}, 120_000);
afterAll(removeTempRepos);

describe("the runs the fixture made", () => {
  it("are in the states the clean tests rely on, each with worktrees on disk", () => {
    expect(runs.passed.state.state).toBe("succeeded");
    expect(runs.failed.state.state).toBe("failed");
    expect(runs.gate.state.state).toBe("waiting_approval");
    expect(runs.recovery.state.state).toBe("needs_recovery");
    for (const { runId } of Object.values(runs)) expect(worktreesOf(runId).length, runId).toBeGreaterThan(0);
  });
});

describe("a dry run", () => {
  it("says what would go and what stays, and removes nothing", async () => {
    const before = Object.fromEntries(Object.values(runs).map(({ runId }) => [runId, worktreesOf(runId)]));
    const report = await cleanRuns({ repo, dryRun: true });

    expect(report.dryRun).toBe(true);
    const outcomes = Object.fromEntries(report.runs.map((run) => [run.runId, run.outcome]));
    expect(outcomes).toEqual({ [runs.passed.runId]: "removed", [runs.failed.runId]: "removed", [runs.gate.runId]: "kept", [runs.recovery.runId]: "kept" });
    expect(report.freedBytes).toBeGreaterThan(0);
    for (const { runId } of Object.values(runs)) expect(worktreesOf(runId), runId).toEqual(before[runId]);
    const text = formatClean(report).join("\n");
    expect(text).toContain("would remove");
    expect(text).toContain("waiting for your approval at");
    expect(text).toContain("needs recovery at implement: an attempt's outcome is unknown");
    expect(text).toMatch(/Would remove \d+ worktrees? of 2 ended runs, freeing /);
  });
});

describe("a clean", () => {
  it("removes the worktrees of runs that ended, keeps those of a run waiting for a person, and keeps ledgers and snapshots", async () => {
    const snapshots = git(repo, "for-each-ref", "refs/ahp/snapshots").split("\n").filter(Boolean);
    expect(snapshots.length).toBeGreaterThan(0);
    const kept = { gate: worktreesOf(runs.gate.runId), recovery: worktreesOf(runs.recovery.runId) };

    const report = await cleanRuns({ repo });

    expect(report.dryRun).toBe(false);
    expect(report.runs.filter((run) => run.outcome === "failed")).toEqual([]);
    expect(worktreesOf(runs.passed.runId)).toEqual([]);
    expect(worktreesOf(runs.failed.runId)).toEqual([]);
    expect(existsSync(join(worktreeRoot(), runs.passed.runId))).toBe(false);
    // A needs_recovery run and a run at its approval gate are never touched.
    expect(worktreesOf(runs.gate.runId)).toEqual(kept.gate);
    expect(worktreesOf(runs.recovery.runId)).toEqual(kept.recovery);
    // Git no longer lists the removed ones.
    expect(registered()).toBe(kept.gate.length + kept.recovery.length);
    // The record stays.
    expect(existsSync(join(repo, ".git", "ahp", "runs", runs.passed.runId, "ledger.jsonl"))).toBe(true);
    expect(git(repo, "for-each-ref", "refs/ahp/snapshots").split("\n").filter(Boolean)).toEqual(snapshots);
    const text = formatClean(report).join("\n");
    expect(text).toMatch(/Removed \d+ worktrees? of 2 ended runs, freed /);
    expect(text).toContain("Ledgers and snapshots are kept.");
  });

  it("has nothing left to remove the second time, and says the rest are still needed", async () => {
    const report = await cleanRuns({ repo });
    expect(report.runs.map((run) => run.outcome).sort()).toEqual(["kept", "kept"]);
    expect(report.freedBytes).toBe(0);
    expect(formatClean(report).at(-1)).toBe("Nothing to remove: every run with worktrees is still needed.");
  });

  it("leaves another repository's worktrees alone: the worktree directory is shared", async () => {
    const other = join(worktreeRoot(), "run_zzzzzzzz", "att_other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "file.txt"), "belongs to another repository\n");
    await cleanRuns({ repo });
    expect(existsSync(join(other, "file.txt"))).toBe(true);
  });
});

describe("sizes", () => {
  it("are read in the unit that fits", () => {
    expect(sizeText(0)).toBe("0 B");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
