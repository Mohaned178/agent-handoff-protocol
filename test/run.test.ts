import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, mock, readRun, readRunEvents, runWorkflow, WorkflowValidationError } from "../src/index.ts";
import type { MockAttemptScript } from "../src/index.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

function workflowWith(script: MockAttemptScript, command = "node verify.mjs") {
  return defineWorkflow({
    name: "greeting",
    steps: [{ id: "implement", agent: mock({ attempts: [script] }), verification: { command } }],
  });
}

function greetingWorkflow(content: string, exitCode = 0) {
  return workflowWith({ edits: [{ path: "greeting.txt", content }], exitCode });
}

describe("one-step run with the mock adapter", () => {
  it("succeeds because verification passed", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    expect(runId).toMatch(/^run_[a-z0-9]+$/);
    expect(state.state).toBe("succeeded");
    const [step] = state.steps;
    expect(step?.state).toBe("succeeded");
    const [attempt] = step?.attempts ?? [];
    expect(attempt).toMatchObject({ state: "exited", outcome: "ok", exitCode: 0, adapter: "mock", mock: true });
    expect(attempt?.verification?.state).toBe("pass");
    expect(attempt?.verification?.evidence).toContainEqual(
      expect.objectContaining({ kind: "test_output", exitCode: 0, output: expect.stringContaining("greeting ok") }),
    );
  });

  it("fails the step and the run when the verification command fails, even though the agent exited 0", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(greetingWorkflow("goodbye\n"), { repo });

    expect(state.state).toBe("failed");
    const [step] = state.steps;
    expect(step).toMatchObject({ state: "failed", failureClass: "verification_failed" });
    const [attempt] = step?.attempts ?? [];
    expect(attempt).toMatchObject({ state: "exited", outcome: "ok", exitCode: 0 });
    expect(attempt?.verification?.state).toBe("fail");
    expect(attempt?.verification?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "test_output",
        command: "node verify.mjs",
        exitCode: 1,
        output: expect.stringContaining("greeting missing or wrong"),
      }),
    );
  });

  it("fails the step as an agent error without verifying when the agent exits non-zero", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(greetingWorkflow("hello\n", 3), { repo });

    expect(state.state).toBe("failed");
    const [step] = state.steps;
    expect(step).toMatchObject({ state: "failed", failureClass: "agent_error" });
    expect(step?.attempts[0]).toMatchObject({ state: "exited", outcome: "error", exitCode: 3, verification: null });
  });

  it("labels the run and every attempt as mock", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    expect(state.mock).toBe(true);
    expect(state.steps[0]?.mock).toBe(true);
    expect(state.steps[0]?.attempts[0]).toMatchObject({ mock: true, reportedModel: "unknown" });
  });
});

describe("workspaces", () => {
  it("runs the attempt as a fresh process in its own git worktree, leaving the repository's checkout untouched", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const headBefore = git(repo, "rev-parse", "HEAD");

    const { state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    const attempt = state.steps[0]?.attempts[0];
    expect(attempt?.pid).toBeGreaterThan(0);
    expect(attempt?.pid).not.toBe(process.pid);
    const worktrees = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSync.native(line.slice("worktree ".length)));
    expect(worktrees).toContain(realpathSync.native(attempt!.workspace));
    expect(realpathSync.native(attempt!.workspace)).not.toBe(repo);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("snapshots the workspace into a commit after the attempt even though the agent did not commit", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    const attempt = state.steps[0]?.attempts[0];
    const snapshot = attempt?.snapshot;
    expect(snapshot).not.toBeNull();
    expect(git(attempt!.workspace, "rev-parse", "HEAD")).toBe(state.baseCommit);
    expect(git(repo, "rev-parse", snapshot!.ref)).toBe(snapshot!.commit);
    expect(git(repo, "rev-parse", `${snapshot!.commit}^`)).toBe(state.baseCommit);
    expect(git(repo, "show", `${snapshot!.commit}:greeting.txt`)).toBe("hello");
  });

  it("snapshots the workspace when the agent exits with an error too", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(greetingWorkflow("partial\n", 1), { repo });

    const snapshot = state.steps[0]?.attempts[0]?.snapshot;
    expect(git(repo, "show", `${snapshot!.commit}:greeting.txt`)).toBe("partial");
  });
});

describe("verification", () => {
  it("runs in a fresh verification worktree built from the snapshot, not in the agent's workspace", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    const attempt = state.steps[0]?.attempts[0];
    const output = attempt?.verification?.evidence[0]?.output ?? "";
    const verifiedIn = /cwd=(.*)/.exec(output)?.[1]?.trim();
    expect(verifiedIn).toBeDefined();
    expect(attempt?.verification?.worktree).toBeDefined();
    expect(verifiedIn!.toLowerCase()).toBe(attempt!.verification!.worktree.toLowerCase());
    expect(verifiedIn!.toLowerCase()).not.toBe(attempt!.workspace.toLowerCase());
  });

  it("cannot resolve dependencies installed in the repository's own checkout", async () => {
    const repo = createTempRepo({
      ".gitignore": "node_modules/\n",
      "node_modules/leaked/package.json": `{ "name": "leaked", "main": "index.js" }\n`,
      "node_modules/leaked/index.js": "module.exports = 'from the live checkout';\n",
      "verify.mjs": `await import("leaked"); console.log("resolved leaked dependency");\n`,
    });

    const { state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    const verification = state.steps[0]?.attempts[0]?.verification;
    expect(verification?.evidence[0]?.output).not.toContain("resolved leaked dependency");
    expect(verification?.state).toBe("fail");
  });

  it("does not carry files that git ignores into verification", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, ".gitignore": "greeting.txt\n" });

    const { state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    expect(state.steps[0]?.attempts[0]?.verification?.state).toBe("fail");
    expect(state.state).toBe("failed");
  });
});

describe("ledger", () => {
  it("records the run as append-only events from which the same state is derived by replay", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(greetingWorkflow("hello\n"), { repo });

    const events = await readRunEvents({ repo, runId });
    expect(events.map((e) => e.type)).toEqual([
      "run_created",
      "run_started",
      "step_ready",
      "attempt_created",
      "attempt_dispatching",
      "attempt_running",
      "attempt_exited",
      "workspace_snapshot_committed",
      "verification_started",
      "verification_verdict",
      "step_terminal",
      "run_terminal",
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index + 1));
    expect(await readRun({ repo, runId })).toEqual(state);
  });

  it("keeps one ledger per run", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const first = await runWorkflow(greetingWorkflow("hello\n"), { repo });
    const second = await runWorkflow(greetingWorkflow("goodbye\n"), { repo });

    expect(first.runId).not.toBe(second.runId);
    expect((await readRun({ repo, runId: first.runId })).state).toBe("succeeded");
    expect((await readRun({ repo, runId: second.runId })).state).toBe("failed");
  });

  it("streams each recorded event with the state derived so far", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const seen: string[] = [];

    await runWorkflow(greetingWorkflow("hello\n"), {
      repo,
      onEvent: (event, state) => seen.push(`${event.type}:${state.state}`),
    });

    expect(seen[0]).toBe("run_created:pending");
    expect(seen[1]).toBe("run_started:running");
    expect(seen.at(-1)).toBe("run_terminal:succeeded");
  });
});

describe("workflow definition", () => {
  it("rejects an unknown adapter, a missing verification command and an unscripted mock", () => {
    const attempt = () =>
      defineWorkflow({
        name: "broken",
        steps: [
          { id: "plan", agent: { adapter: "no-such-tool" }, verification: { command: "node verify.mjs" } },
          { id: "implement", agent: { adapter: "mock", options: { attempts: [] } }, verification: { command: "" } },
        ],
      });

    expect(attempt).toThrow(WorkflowValidationError);
    try {
      attempt();
    } catch (error) {
      const problems = (error as WorkflowValidationError).problems.join("\n");
      expect(problems).toContain('step "plan": unknown adapter "no-such-tool"');
      expect(problems).toContain('step "implement": mock adapter options need a non-empty `attempts` array');
      expect(problems).toContain('step "implement": needs a non-empty `verification.command`');
    }
  });

  it("rejects an invalid workflow before anything is recorded", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const invalid = { name: "", steps: [] };

    await expect(runWorkflow(invalid, { repo })).rejects.toThrow(WorkflowValidationError);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "ahp"))).toBe(false);
  });
});
