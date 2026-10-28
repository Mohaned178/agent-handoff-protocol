import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, opencode, readRunEvents, resumeRun, runWorkflow } from "../src/index.ts";
import { runsDir, locateRepo } from "../src/runtime/paths.ts";
import { ahp } from "./helpers/cli.ts";
import { truncateLedgerAfter } from "./helpers/ledger.ts";
import { captures, completingScenario, installFakeOpencode } from "./helpers/opencode.ts";
import { createTempRepo, removeTempRepos, VERIFY_OK } from "./helpers/repo.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  removeTempRepos();
});

const workflow = () => defineWorkflow({ name: "review", steps: [{ id: "review", agent: opencode(), verification: { command: "node verify.mjs" } }] });

/** A run of an OpenCode step that made two tool calls, cut right after its agent started: its process "stopped" there. */
async function stoppedWhileRunning() {
  const fake = installFakeOpencode(
    completingScenario({
      prompt: {
        steps: [{ send: captures.bashToolCallRunning }, { request: captures.bashPermissionRequest }, { send: captures.bashToolCallFailed }, { send: captures.writeToolCallRunning }],
        result: captures.completeResult,
      },
    }),
  );
  restores.push(fake.restore);
  const repo = createTempRepo({ "verify.mjs": VERIFY_OK });
  const { runId, state } = await runWorkflow(workflow(), { repo });
  expect(state.state).toBe("succeeded");
  truncateLedgerAfter(repo, runId, "attempt_running");
  return { repo, runId };
}

describe("the tool-call log in a recovery report", () => {
  it("shows what an ACP agent's tool calls were doing when its attempt was found unknown", async () => {
    const { repo, runId } = await stoppedWhileRunning();

    const { state } = await resumeRun({ repo, runId });

    expect(state.state).toBe("needs_recovery");
    const report = state.steps[0]!.attempts[0]!.recovery!.report!;
    expect(report.toolCallLog).toEqual({
      truncated: false,
      entries: [
        { time: expect.any(String), toolCallId: "call_bash", kind: "execute", title: "git push origin main", status: "in_progress", paths: ["."], permission: null },
        { time: expect.any(String), toolCallId: "call_bash", kind: "execute", title: "git push origin main", status: "permission_requested", paths: ["."], permission: "rejected" },
        { time: expect.any(String), toolCallId: "call_bash", kind: "execute", title: "git push origin main", status: "failed", paths: ["."], permission: null },
        { time: expect.any(String), toolCallId: "call_write", kind: "edit", title: "write", status: "in_progress", paths: ["out.txt"], permission: null },
      ],
    });
  });

  it("is kept in the repository's AHP directory, outside the attempt's workspace, so it never shows in the attempt's diff", async () => {
    const { repo, runId } = await stoppedWhileRunning();
    const { state } = await resumeRun({ repo, runId });
    const attempt = state.steps[0]!.attempts[0]!;

    const location = await locateRepo(repo);
    const file = join(runsDir(location), runId, "tool-calls", `${attempt.id}.jsonl`);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
    expect(attempt.recovery!.report!.workspace.changed).toEqual([]);
  });

  it("lists the last hundred entries of a longer log and says the earlier ones were left out, and skips a line a crash tore", async () => {
    const { repo, runId } = await stoppedWhileRunning();
    const location = await locateRepo(repo);
    const attemptId = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_created")!.attemptId;
    const file = join(runsDir(location), runId, "tool-calls", `${attemptId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    for (let n = 0; n < 150; n++) {
      appendFileSync(file, `${JSON.stringify({ time: "2026-10-28T00:00:00.000Z", toolCallId: `call_${n}`, kind: "read", title: `read ${n}`, status: "completed", paths: [], permission: null })}\n`);
    }
    appendFileSync(file, '{"time": "2026-10-28T00:00:00.000Z", "toolCallId": "call_torn", "ki');

    const { state } = await resumeRun({ repo, runId });

    const log = state.steps[0]!.attempts[0]!.recovery!.report!.toolCallLog!;
    expect(log.truncated).toBe(true);
    expect(log.entries).toHaveLength(100);
    expect(log.entries.at(-1)!.toolCallId).toBe("call_149");
  });
});

describe("ahp recover, for an attempt that has a tool-call log", () => {
  it("prints each entry, the last one last, with AHP's answer to a permission request", async () => {
    const { repo, runId } = await stoppedWhileRunning();

    const recover = ahp(["recover", runId], repo);

    expect(recover.stderr).toBe("");
    expect(recover.stdout).toContain("tool-call log: 4 entries");
    expect(recover.stdout).toMatch(/in_progress: execute "git push origin main" on \./);
    expect(recover.stdout).toMatch(/permission_requested, rejected by AHP: execute "git push origin main"/);
    expect(recover.stdout).toMatch(/in_progress: edit "write" on out\.txt\n.*Host and external effects are undetermined/s);
  });
});
