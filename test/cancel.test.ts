import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRun, readRunEvents, recoverAttempt, resumeRun, runWorkflow, type LedgerEvent, type MockAttemptScript, type RunView } from "../src/index.ts";
import type { Adapter } from "../src/adapters/index.ts";
import { mockAdapter } from "../src/adapters/mock/index.ts";
import { executeRun } from "../src/runtime/index.ts";
import { appendLedgerEvent, finishedRun, truncateLedgerAfter } from "./helpers/ledger.ts";
import { isRunning, until, untilGone } from "./helpers/process.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

const pidDirs: string[] = [];
const leftovers: number[] = [];
afterEach(async () => {
  // A test that fails partway can leave its agent's tree running; Windows cannot remove a running process's directory.
  for (const pid of leftovers.splice(0)) {
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
  }
  removeTempRepos();
  for (const dir of pidDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file for the mock agent to write its tree's PIDs to, and a way to read them once it has. */
function pidFile() {
  const dir = mkdtempSync(join(tmpdir(), "ahp-pids-"));
  pidDirs.push(dir);
  const path = join(dir, "pids");
  const pids = (count: number) =>
    until(() => {
      const lines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
      if (lines.length < count) return undefined;
      const read = lines.map(Number);
      leftovers.push(...read);
      return read;
    }, "the mock agent to write its PIDs");
  return { path, pids };
}

/** Aborts `controller` once the run records an event of `type`, as Ctrl+C would at that point. */
function abortOn(controller: AbortController, type: LedgerEvent["type"]) {
  return (event: LedgerEvent) => {
    if (event.type === type) controller.abort();
  };
}

const typesOf = (events: readonly LedgerEvent[]) => events.map((event) => event.type);

/** The events from the cancel request on. */
const fromCancel = (events: readonly LedgerEvent[]) => typesOf(events.slice(events.findIndex((e) => e.type === "run_cancel_requested")));

const attemptOf = (state: RunView) => implementOf(state).attempts.at(-1)!;

describe("cancelling a run", () => {
  it("stops a running agent and every process it started, then records it cancelled", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const pids = pidFile();
    const controller = new AbortController();
    const hanging: MockAttemptScript = { ...hello, hang: true, spawnGrandchild: true, pidFile: pids.path };
    let tree: number[] = [];

    const { runId, state } = await runWorkflow(retryWorkflow([hanging]), {
      repo,
      signal: controller.signal,
      cancelGraceMs: 500,
      onEvent: (event) => {
        if (event.type === "attempt_running") void pids.pids(2).then((read) => ((tree = read), controller.abort()));
      },
    });

    expect(state.state).toBe("cancelled");
    expect(implementOf(state)).toMatchObject({ state: "cancelled", failureClass: null });
    // The grandchild ignores SIGTERM, so the tree had to be killed, on every OS.
    expect(attemptOf(state)).toMatchObject({ state: "exited", outcome: "cancelled", cancellation: { result: { forced: true, via: "tree_kill" } } });
    expect(fromCancel(await readRunEvents({ repo, runId }))).toEqual([
      "run_cancel_requested",
      "attempt_cancelling",
      "attempt_exited",
      "step_terminal",
      "run_terminal",
    ]);
    expect(tree).toHaveLength(2);
    for (const pid of tree) expect(isRunning(pid)).toBe(false);
  });

  it("asks the agent to stop first: SIGTERM is graceful on Linux and macOS, and Windows always kills the tree", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const controller = new AbortController();

    const { state } = await runWorkflow(retryWorkflow([{ ...hello, hang: true }]), {
      repo,
      signal: controller.signal,
      onEvent: abortOn(controller, "attempt_running"),
    });

    const attempt = attemptOf(state);
    expect(attempt.outcome).toBe("cancelled");
    expect(attempt.cancellation!.result).toEqual(
      process.platform === "win32" ? { forced: true, via: "tree_kill" } : { forced: false, via: "signal" },
    );
    expect(isRunning(attempt.pid!)).toBe(false);
  });

  it("during a retry's backoff: no further attempt is dispatched", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const controller = new AbortController();
    const rateLimited: MockAttemptScript = { exitCode: 1, error: { kind: "transient", message: "429" } };
    // A minute's backoff on the real clock: only the cancel ends the wait.
    const workflow = retryWorkflow([rateLimited, hello], { retry: { backoff: { initialMs: 60_000 } } });

    const { runId, state } = await runWorkflow(workflow, { repo, signal: controller.signal, onEvent: abortOn(controller, "retry_scheduled") });

    expect(state.state).toBe("cancelled");
    expect(implementOf(state).attempts).toHaveLength(1);
    expect(fromCancel(await readRunEvents({ repo, runId }))).toEqual(["run_cancel_requested", "step_terminal", "run_terminal"]);
  });

  it("before the first attempt: the step is cancelled with no attempt", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const controller = new AbortController();

    const { state } = await runWorkflow(retryWorkflow([hello]), { repo, signal: controller.signal, onEvent: abortOn(controller, "handoff_accepted") });

    expect(state.state).toBe("cancelled");
    expect(implementOf(state)).toMatchObject({ state: "cancelled", attempts: [] });
  });

  it("during verification: the command is stopped, which says nothing about the attempt, and the step is cancelled", async () => {
    const repo = createTempRepo({ "verify.mjs": `setInterval(() => {}, 60000);\n` });
    const controller = new AbortController();

    const { state } = await runWorkflow(retryWorkflow([hello]), {
      repo,
      signal: controller.signal,
      cancelGraceMs: 500,
      onEvent: abortOn(controller, "verification_started"),
    });

    expect(state.state).toBe("cancelled");
    const attempt = attemptOf(state);
    expect(attempt).toMatchObject({ outcome: "ok", failureClass: null, verification: { state: "inconclusive" } });
    expect(attempt.verification!.evidence).toEqual([
      { kind: "validator_error", stage: "command", message: expect.stringMatching(/^the run was cancelled, so the command was stopped/) },
    ]);
  });

  it("an agent left dispatched by a process that stopped while cancelling is unknown, and waits for a person", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const controller = new AbortController();
    const { runId } = await runWorkflow(retryWorkflow([{ ...hello, hang: true }], { recovery: "abort" }), {
      repo,
      signal: controller.signal,
      onEvent: abortOn(controller, "attempt_running"),
    });
    truncateLedgerAfter(repo, runId, "attempt_cancelling");

    const { state } = await resumeRun({ repo, runId });

    // The step's policy would abort it; a run being cancelled leaves that to the person who cancelled it.
    expect(state.state).toBe("needs_recovery");
    expect(attemptOf(state)).toMatchObject({ state: "unknown", recovery: { reason: "no_terminal_record", awaited: true, decision: null } });
    const decided = await recoverAttempt({ repo, attemptId: attemptOf(state).id, policy: "abort" });
    expect(decided.state.state).toBe("cancelled");
    expect(implementOf(decided.state)).toMatchObject({ state: "failed", failureClass: "unknown" });
  });

  it("replay refuses a ledger that dispatches an agent after the cancel", async () => {
    const { repo, runId } = await finishedRun();
    truncateLedgerAfter(repo, runId, "attempt_created");
    appendLedgerEvent(repo, runId, { type: "run_cancel_requested" });
    const { attemptId } = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_created") as { attemptId: string };
    appendLedgerEvent(repo, runId, { type: "attempt_dispatching", attemptId });

    await expect(readRun({ repo, runId })).rejects.toThrow("the run is being cancelled, so no agent is dispatched");
  });
});

describe("a cancel whose kill is not confirmed", () => {
  it("makes the attempt unknown (unconfirmed_kill), never cancelled", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const controller = new AbortController();
    // The mock, but its kill can never confirm that the agent's processes are gone.
    const unkillable: Adapter = {
      ...mockAdapter,
      async startAttempt(input) {
        const started = await mockAdapter.startAttempt(input);
        leftovers.push(started.pid);
        return { ...started, cancel: async () => ({ confirmed: false, survivors: [started.pid], detail: "still there" }) };
      },
    };

    const { state } = await executeRun(retryWorkflow([{ ...hello, hang: true }]), {
      repo,
      adapters: new Map([["mock", unkillable]]),
      signal: controller.signal,
      onEvent: abortOn(controller, "attempt_running"),
    });

    expect(state.state).toBe("needs_recovery");
    const attempt = attemptOf(state);
    expect(attempt).toMatchObject({ state: "unknown", outcome: null, cancellation: { result: null } });
    expect(attempt.recovery).toMatchObject({ reason: "unconfirmed_kill", awaited: true });
    expect(attempt.recovery!.detail).toContain("not every process of its tree could be seen gone: still there");
    process.kill(attempt.pid!, "SIGKILL");
    await untilGone(attempt.pid!, "the agent to be killed");
  });
});
