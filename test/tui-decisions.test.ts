import { hostname } from "node:os";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerWriter } from "../src/ledger/index.ts";
import { readRun, readRunEvents, runWorkflow, type MockAttemptScript } from "../src/index.ts";
import { decisionOf } from "../src/commands/decision.ts";
import { App } from "../src/tui/app.ts";
import { h } from "../src/tui/h.ts";
import { TaskRunner } from "../src/tui/task-runner.ts";
import type { RunSources } from "../src/tui/screens/run.ts";
import { taskSources } from "../src/tui/sources.ts";
import { homeSources } from "../src/tui/screens/home.ts";
import { markFirstOpenDone } from "../src/setup/settings.ts";
import { settingsPath } from "../src/runtime/paths.ts";
import { themeFor } from "../src/tui/theme.ts";
import { gatedWorkflow } from "./helpers/approval.ts";
import { fakeClock } from "./helpers/clock.ts";
import { addBareRemote, publishingWorkflow, pushStep, remoteBranch } from "./helpers/external.ts";
import { pathWithoutTools } from "./helpers/fake-tools.ts";
import { GONE_PID, ledgerFile, lockFile, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello, retryWorkflow } from "./helpers/retry.ts";
import { implemented, implementStep } from "./helpers/review.ts";
import { renderTui, type Tui } from "./helpers/tui.ts";

const THEME = themeFor("truecolor");
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

afterEach(removeTempRepos);

const open: Tui[] = [];
afterEach(() => {
  for (const tui of open.splice(0)) tui.unmount();
});

const lines = (frame: string) => frame.split("\n");
const footerOf = (frame: string) => lines(frame).filter((line) => line.trim() !== "").at(-1)!.trim();

function runApp(repo: string, runId: string, options: { runner?: TaskRunner; rows?: number } = {}): Tui {
  const sources: RunSources = { repo, now: () => NOW, pid: process.pid, pollMs: 40 };
  const runner = options.runner ?? new TaskRunner({ clock: fakeClock() });
  const tui = renderTui(h(App, { cwd: repo, theme: THEME, runSources: sources, start: "run", runId, runner }), { columns: 120, rows: options.rows ?? 34 });
  open.push(tui);
  return tui;
}

const freshRepo = () => createTempRepo({ "verify.mjs": VERIFY_GREETING });

describe("a gate decided on the run screen", () => {
  it("shows what you are approving from the pinned commit, and a approves: AHP pushes and the run ends on the same screen", async () => {
    const repo = freshRepo();
    const remote = addBareRemote(repo);
    const { runId } = await runWorkflow(publishingWorkflow(implementStep([implemented(1)]), pushStep()), { repo, clock: fakeClock() });
    const tui = runApp(repo, runId);

    const frame = await tui.waitFor("+1 −0");
    expect(frame).toContain("What you are approving");
    expect(frame).toContain("waiting for your approval: 2 changed files");
    expect(frame).toMatch(/✎ greeting\.txt/);
    expect(frame).not.toContain("decide: ahp approve");
    expect(footerOf(frame)).toBe("a approve  r reject  ↑↓ scroll  esc back  ctrl+c quit");
    expect(remoteBranch(remote)).toBeNull();

    await tui.type("a");
    const done = await tui.waitFor("Receipt");
    expect(done).toContain("✓ approve    → branch ahp/greeting on origin");
    // The push is a step with its outcome, told on the gate's block.
    await tui.press("enter");
    const opened = await tui.waitFor("push: done by AHP");
    expect(opened).toMatch(/approved by/);
    expect(remoteBranch(remote)).not.toBeNull();
    expect((await readRun({ repo, runId })).state).toBe("succeeded");
  });

  it("r asks for a reason, refuses an empty one, sends the step back with it, and the run reaches the next gate on the same screen", async () => {
    const repo = freshRepo();
    const { runId } = await runWorkflow(gatedWorkflow(implementStep([implemented(1), implemented(2)])), { repo, clock: fakeClock() });
    const tui = runApp(repo, runId);
    await tui.waitFor("What you are approving");

    await tui.type("r");
    let frame = await tui.waitFor("Why reject?");
    expect(footerOf(frame)).toBe("enter reject  esc back  ctrl+c quit");
    await tui.press("enter");
    frame = await tui.waitFor("a reason is needed");
    expect((await readRun({ repo, runId })).state).toBe("waiting_approval");

    await tui.type("rename the greeting");
    await tui.press("enter");
    // The step ran again and the run stopped at the gate once more: two requests, the first rejected.
    frame = await tui.waitFor((text) => text.includes("rejected by") && text.includes("waiting for your approval") && text.includes("What you are approving"));
    expect(frame).toContain("rename the greeting");
    expect(frame).toMatch(/round 2|round\.txt/);
    const gate = (await readRun({ repo, runId })).steps.find((step) => step.id === "approve")!;
    expect(gate.approvals.map((approval) => approval.decision?.decision ?? null)).toEqual(["rejected", null]);

    // Gate after gate: the second is approved with the same key.
    await tui.type("a");
    await tui.waitFor("Receipt");
    expect((await readRun({ repo, runId })).state).toBe("succeeded");
  });

  it("esc leaves a reason being written without deciding", async () => {
    const repo = freshRepo();
    const { runId } = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock() });
    const tui = runApp(repo, runId);
    await tui.waitFor("What you are approving");

    await tui.type("r");
    await tui.waitFor("Why reject?");
    await tui.press("escape");
    const frame = await tui.waitFor((text) => !text.includes("Why reject?"));
    expect(footerOf(frame)).toBe("a approve  r reject  ↑↓ scroll  esc back  ctrl+c quit");
    expect((await readRun({ repo, runId })).state).toBe("waiting_approval");
  });

  it("scrolls the diff with ↑↓", async () => {
    const repo = freshRepo();
    const long: MockAttemptScript = { edits: [{ path: "greeting.txt", content: "hello\n" }, { path: "notes.txt", content: Array.from({ length: 40 }, (_, i) => `note ${i}\n`).join("") }], outputFields: { summary: "long" } };
    const { runId } = await runWorkflow(gatedWorkflow(implementStep([long])), { repo, clock: fakeClock() });
    const tui = runApp(repo, runId, { rows: 20 });
    const before = await tui.waitFor("+1 −0");
    expect(before).toContain("What you are approving");

    expect(before).not.toContain("note 39");
    for (let i = 0; i < 45; i++) await tui.press("down");
    const down = await tui.waitFor((text) => text.includes("note 39"));
    expect(down).not.toContain("What you are approving");

    for (let i = 0; i < 70; i++) await tui.press("up");
    const top = await tui.waitFor((text) => text.includes("✓ implement") || text.includes("! approve"));
    expect(top).toContain("implement");
  });
});

describe("an unknown attempt decided on the run screen", () => {
  const lost: MockAttemptScript = { ...hello, loseContact: true };

  async function awaitingRecovery() {
    const repo = freshRepo();
    const { runId, state } = await runWorkflow(retryWorkflow([lost]), { repo, clock: fakeClock() });
    expect(state.state).toBe("needs_recovery");
    return { repo, runId };
  }

  it("shows what the attempt did and its workspace, and a adopts it: the workspace is verified and the run ends", async () => {
    const { repo, runId } = await awaitingRecovery();
    const tui = runApp(repo, runId);

    const frame = await tui.waitFor("+1 −0");
    expect(frame).toContain("What happened to attempt 1");
    expect(frame).toContain("Its workspace");
    expect(frame).toMatch(/✎ greeting\.txt/);
    expect(frame).toContain("Host and external effects are undetermined");
    expect(frame).not.toContain("decide: ahp recover");
    expect(footerOf(frame)).toBe("a adopt  x abort  ↑↓ scroll  esc back  ctrl+c quit");

    await tui.type("a");
    await tui.waitFor("Receipt");
    expect((await readRun({ repo, runId })).state).toBe("succeeded");
  });

  it("x aborts it: the step ends and so does the run, with nothing run again", async () => {
    const { repo, runId } = await awaitingRecovery();
    const tui = runApp(repo, runId);
    await tui.waitFor("What happened to attempt 1");

    await tui.type("x");
    await tui.waitFor("Receipt");
    const state = await readRun({ repo, runId });
    expect(state.state).not.toBe("needs_recovery");
    expect(state.steps[0]!.attempts).toHaveLength(1);
  });

  it("is adopted or aborted after a crash cut as well: a run stopped while its agent ran is resumed, then decided", async () => {
    const repo = freshRepo();
    const { runId } = await runWorkflow(retryWorkflow([hello]), { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, "attempt_running");
    writeFileSync(lockFile(repo, runId), `${JSON.stringify({ host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" })}\n`);
    const tui = runApp(repo, runId);

    let frame = await tui.waitFor("its process stopped partway: enter resumes it");
    expect(footerOf(frame)).toMatch(/^enter resume/);
    await tui.press("enter");
    // The attempt has no record of how it ended, so it is unknown and awaits the person.
    frame = await tui.waitFor("What happened to attempt 1");
    expect(footerOf(frame)).toBe("a adopt  x abort  ↑↓ scroll  esc back  ctrl+c quit");

    await tui.type("x");
    await tui.waitFor("Receipt");
    expect((await readRun({ repo, runId })).state).not.toBe("needs_recovery");
  });
});

describe("a run whose process stopped", () => {
  it("is resumed with enter, taking the stale lock over as ahp recover does, and goes on to its end", async () => {
    const repo = freshRepo();
    const { runId } = await runWorkflow(retryWorkflow([hello]), { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, "attempt_exited");
    const stale = { host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(lockFile(repo, runId), `${JSON.stringify(stale)}\n`);
    const tui = runApp(repo, runId);

    const frame = await tui.waitFor("its process stopped partway: enter resumes it");
    expect(frame).not.toContain("ahp recover");
    expect(footerOf(frame)).toMatch(/^enter resume/);

    await tui.press("enter");
    await tui.waitFor("Receipt");
    const state = await readRun({ repo, runId });
    expect(state.state).toBe("succeeded");
    expect(state.resumptions).toEqual([expect.objectContaining({ takenOverFrom: stale })]);
  });
});

describe("a decision that is refused", () => {
  it("shows one error line, writes nothing, and the screen offers the decision again once the lock is free", async () => {
    const repo = freshRepo();
    const { runId } = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock() });
    const runner = new TaskRunner({ clock: fakeClock() });
    const tui = runApp(repo, runId, { runner });
    await tui.waitFor("What you are approving");
    const before = (await readRunEvents({ repo, runId })).length;

    // Another process starts writing the run between the screen's last read and the key.
    const { writer } = await LedgerWriter.open(ledgerFile(repo, runId));
    try {
      runner.decide({ repo, runId, name: "gated", mock: true, request: { type: "approve", stepId: "approve" } });
      expect(runner.current()?.decided).toBe(true);
      await runner.settled();
      const frame = await tui.waitFor(`lock held by PID ${process.pid}`);
      expect(frame.split("\n").filter((line) => line.includes("lock held by PID"))).toHaveLength(1);
    } finally {
      await writer.close();
    }
    expect((await readRunEvents({ repo, runId })).length).toBe(before);

    const frame = await tui.waitFor((text) => text.includes("a approve"));
    expect(frame).toContain("What you are approving");
    await tui.type("a");
    await tui.waitFor("Receipt");
    expect((await readRun({ repo, runId })).state).toBe("succeeded");
  });

  it("is only read while another process writes the run: no key decides it", async () => {
    const repo = freshRepo();
    const { runId } = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock() });
    const { writer } = await LedgerWriter.open(ledgerFile(repo, runId));
    try {
      // This screen's process is not the one holding the lock.
      const sources: RunSources = { repo, now: () => NOW, pid: process.pid + 1, pollMs: 40 };
      const tui = renderTui(h(App, { cwd: repo, theme: THEME, runSources: sources, start: "run", runId, runner: new TaskRunner({ clock: fakeClock() }) }), { columns: 120, rows: 34 });
      open.push(tui);
      const frame = await tui.waitFor(`is running in another terminal (PID ${process.pid})`);
      expect(frame).not.toContain("What you are approving");
      expect(footerOf(frame)).not.toMatch(/approve/);
      await tui.type("a");
      expect((await readRun({ repo, runId })).state).toBe("waiting_approval");
    } finally {
      await writer.close();
    }
  });
});

describe("decisionOf", () => {
  it("offers nothing while a process writes the run, the lock is unread or unreadable, or the run ended", async () => {
    const repo = freshRepo();
    const waiting = (await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock() })).state;
    const owner = { host: hostname(), pid: 4120, startedAt: "2026-01-01T00:00:00.000Z" };
    expect(decisionOf(waiting, { state: "free" })?.kind).toBe("gate");
    expect(decisionOf(waiting, { state: "stale", owner })?.kind).toBe("gate");
    expect(decisionOf(waiting, { state: "held", owner })).toBeNull();
    expect(decisionOf(waiting, { state: "other_host", owner })).toBeNull();
    expect(decisionOf(waiting, { state: "unreadable" })).toBeNull();
    expect(decisionOf(waiting, null)).toBeNull();
    const ended = (await runWorkflow(retryWorkflow([hello]), { repo, clock: fakeClock() })).state;
    expect(decisionOf(ended, { state: "free" })).toBeNull();
  });
});

describe("home's waiting for you", () => {
  it("opens straight on the decision with enter", async () => {
    const env = await pathWithoutTools();
    await markFirstOpenDone(settingsPath());
    const repo = freshRepo();
    await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo, clock: fakeClock() });
    const tui = renderTui(
      h(App, { cwd: repo, theme: THEME, sources: { ...homeSources(repo, env), now: () => NOW }, task: taskSources(repo, env), runSources: { repo, now: () => NOW, pid: process.pid, pollMs: 40 }, runner: new TaskRunner({ clock: fakeClock() }) }),
      { columns: 120, rows: 34 },
    );
    open.push(tui);
    const frame = await tui.waitFor("Waiting for you");
    expect(footerOf(frame)).toContain("enter decide");

    await tui.press("enter");
    const run = await tui.waitFor("What you are approving");
    expect(footerOf(run)).toBe("a approve  r reject  ↑↓ scroll  esc back  ctrl+c quit");
  });
});
