import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatReceipt } from "../src/cli/receipt.ts";
import { runWorkflow, type MockAttemptScript, type RunView } from "../src/index.ts";
import type { ActivityEntry } from "../src/protocol/index.ts";
import { activityLogPath, locateRepo } from "../src/runtime/paths.ts";
import { App } from "../src/tui/app.ts";
import { h } from "../src/tui/h.ts";
import { layoutOf } from "../src/tui/layout.ts";
import { RunScreen, type RunSources } from "../src/tui/screens/run.ts";
import { ThemeContext, themeFor, type Theme } from "../src/tui/theme.ts";
import { gatedWorkflow } from "./helpers/approval.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";
import { approved, changesRequested, implemented, implementStep, reviewedWorkflow, reviewStep } from "./helpers/review.ts";
import { colorAt, hasEscapes, renderTui, type Tui } from "./helpers/tui.ts";

const TRUECOLOR = themeFor("truecolor");
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

let repo: string;
let sources: RunSources;
const runs: Record<"pass" | "retry" | "sentBack" | "failed" | "gate" | "unknown", { runId: string; state: RunView }> = {} as never;

beforeAll(async () => {
  repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  sources = { repo, now: () => NOW, pid: process.pid };
  runs.pass = await runWorkflow(retryWorkflow([hello]), { repo });
  runs.retry = await runWorkflow(retryWorkflow([goodbye, hello]), { repo });
  runs.sentBack = await runWorkflow(reviewedWorkflow(implementStep([implemented(1), implemented(2)]), reviewStep([changesRequested("rename the greeting", "add a test"), approved()])), { repo });
  runs.failed = await runWorkflow(retryWorkflow([goodbye], { retry: { budget: 0 } }), { repo });
  runs.gate = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo });
  // The retry has no script: its outcome is unknown.
  runs.unknown = await runWorkflow(retryWorkflow([goodbye]), { repo });
}, 120_000);

afterAll(removeTempRepos);

const open: Tui[] = [];
afterEach(() => {
  for (const tui of open.splice(0)) tui.unmount();
});

function runApp(runId: string, options: { columns?: number; rows?: number; theme?: Theme } = {}): Tui {
  const tui = renderTui(h(App, { cwd: repo, theme: options.theme ?? TRUECOLOR, runSources: sources, start: "run", runId }), { columns: options.columns ?? 120, rows: options.rows ?? 32 });
  open.push(tui);
  return tui;
}

const lines = (frame: string) => frame.split("\n");
const footerOf = (frame: string) => lines(frame).filter((line) => line.trim() !== "").at(-1)!.trim();

describe("the run screen over a run that ended", () => {
  it("shows each step's block, the sidebar's usage as reported, and the receipt with the same facts as ahp inspect", async () => {
    const tui = runApp(runs.retry.runId);
    const frame = await tui.waitFor("Receipt");

    expect(lines(frame)[0]).toMatch(new RegExp(`^ AHP {2}run ${runs.retry.runId} · retry · \\d+s · mock`));
    expect(frame).toMatch(/✓ implement {2}mock · default model/);
    expect(frame).toContain("↻ attempt 1: greeting missing or wrong, retrying (retry 1 of 2)");
    // The sidebar: mock usage, which the mock never reports.
    expect(frame).toContain("mock (scripted, not evidence)");
    expect(frame).toContain("not reported");
    expect(frame).toContain("Limits (AHP) · implement");
    // The receipt says what `ahp inspect` says.
    const inspect = formatReceipt(runs.retry.state);
    expect(inspect).toContain("implement: verified: `node verify.mjs` passed in a clean copy");
    expect(frame).toContain("✓ implement: verified: `node verify.mjs` passed in a clean copy");
    expect(inspect).toContain("attempt 1: greeting missing or wrong");
    expect(frame).toMatch(/the agent reported done once before its check passed; first: attempt 1:\s+(│.*\n\s+)?greeting missing or wrong/);
    expect(frame).toContain("scripted mock agents: their results are not evidence");
    expect(footerOf(frame)).toBe("enter expand  d full diff  l raw log  esc back  ctrl+c quit");
  });

  it("colours a pass in the accent and a failure as an error, and writes no colour under NO_COLOR", async () => {
    const passed = runApp(runs.pass.runId);
    await passed.waitFor("Receipt");
    expect(colorAt(passed.raw(), "✓ implement")).toContain("accent");

    const failed = runApp(runs.failed.runId);
    const frame = await failed.waitFor("Receipt");
    expect(colorAt(failed.raw(), "✗ implement")).toContain("error");
    expect(frame).toContain("✗ reported done · not verified: greeting missing or wrong");
    expect(frame).toContain(`next ahp inspect ${runs.failed.runId} shows every attempt and its evidence`);

    const plain = runApp(runs.failed.runId, { theme: themeFor("none") });
    await plain.waitFor("Receipt");
    expect(hasEscapes(plain.raw())).toBe(false);
  });

  it("moves between steps with ↑↓, and enter expands and folds the selected one", async () => {
    const tui = runApp(runs.sentBack.runId);
    let frame = await tui.waitFor("Receipt");
    expect(frame).toContain("↻ sent back by review: rename the greeting (retry 1 of 2)");
    expect(frame).not.toContain("| add a test");
    expect(footerOf(frame)).toBe("↑↓ step  enter expand  d full diff  l raw log  esc back  ctrl+c quit");

    await tui.press("up", "enter");
    frame = await tui.waitFor("| add a test");
    expect(frame).toContain("| rename the greeting");
    expect(footerOf(frame)).toMatch(/^↑↓ step {2}enter fold/);

    await tui.press("enter");
    frame = await tui.waitFor((text) => !text.includes("| add a test"));
    expect(frame).toContain("↻ sent back by review: rename the greeting (retry 1 of 2)");
  });

  it("d shows the selected step's whole diff, scrollable, and esc goes back to the timeline", async () => {
    const tui = runApp(runs.pass.runId);
    await tui.waitFor("Receipt");

    await tui.type("d");
    const frame = await tui.waitFor("attempt 1's snapshot");
    expect(frame).toMatch(/✎ greeting\.txt {2}\+1 −0 {2}added/);
    expect(frame).toMatch(/1 \+ hello/);
    expect(footerOf(frame)).toBe("↑↓ scroll  pgup pgdn page  esc timeline  ctrl+c quit");

    await tui.press("escape");
    await tui.waitFor("Receipt");
  });

  it("l shows the raw transcript of the selected step's last attempt, its tail first", async () => {
    const tui = runApp(runs.pass.runId);
    await tui.waitFor("Receipt");

    await tui.type("l");
    // The mock agent's report, as it printed it.
    const frame = await tui.waitFor('"outputFields"');
    expect(frame).toContain(`implement: attempt 1's raw output`);
  });

  it("says when a gate waits, with the changed files and how to decide, and shows no receipt yet", async () => {
    const tui = runApp(runs.gate.runId);
    const frame = await tui.waitFor("waiting for your approval");

    expect(frame).toMatch(/! approve/);
    expect(frame).toContain("waiting for your approval: 2 changed files");
    expect(frame).toContain("✎ greeting.txt  added");
    expect(frame).toContain(`decide: ahp approve ${runs.gate.runId} approve`);
    expect(frame).not.toContain("Receipt");
    expect(colorAt(tui.raw(), "! approve")).toContain("warn");
  });

  it("says when an attempt's outcome is unknown, with the command that decides it", async () => {
    const tui = runApp(runs.unknown.runId);
    const unknown = runs.unknown.state.steps[0]!.attempts[1]!;
    const frame = await tui.waitFor("outcome unknown");

    expect(frame).toContain(`decide: ahp recover ${unknown.id} --policy adopt|abort`);
  });

  it("below 110 columns folds the sidebar away, and u shows it over the timeline", async () => {
    const tui = runApp(runs.pass.runId, { columns: 100 });
    let frame = await tui.waitFor("Receipt");
    expect(frame).not.toContain("mock (scripted, not evidence)");
    expect(footerOf(frame)).toBe("enter expand  d full diff  l raw log  u usage  esc back  ctrl+c quit");

    await tui.type("u");
    frame = await tui.waitFor("mock (scripted, not evidence)");
    expect(frame).not.toContain("Receipt");
    expect(footerOf(frame)).toContain("u timeline");
  });
});

describe("the run screen while the run goes on", () => {
  it("follows the ledger, the activity log and the worktree as they change, and ctrl+c cancels through the run's signal", async () => {
    const controller = new AbortController();
    let attempt: { runId: string; id: string; workspace: string } | null = null;
    const script: MockAttemptScript = { ...hello, hang: true, activity: [{ type: "message", text: "starting on the greeting" }] };
    const done = runWorkflow(retryWorkflow([script]), {
      repo,
      signal: controller.signal,
      cancelGraceMs: 100,
      onEvent: (event, state) => {
        if (event.type !== "attempt_running") return;
        const running = state.steps[0]!.attempts.at(-1)!;
        attempt = { runId: state.runId, id: running.id, workspace: running.workspace };
      },
    });
    try {
      await followAndCancel(controller, done, () => attempt);
    } finally {
      // Whatever failed, the hanging agent is stopped before the temporary directories go.
      controller.abort();
      await done.catch(() => undefined);
    }
  }, 60_000);
});

async function followAndCancel(controller: AbortController, done: Promise<{ state: RunView }>, running: () => { runId: string; id: string; workspace: string } | null) {
  {
    const deadline = Date.now() + 20_000;
    while (running() === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const { runId, id, workspace } = running()!;

    let cancelled = 0;
    const tui = renderTui(
      h(ThemeContext.Provider, { value: TRUECOLOR }, h(RunScreen, { layout: layoutOf(120, 32), sources: { repo, now: () => Date.now(), pid: process.pid, pollMs: 50 }, runId, nav: { open: () => {}, openRun: () => {}, back: () => {}, quit: () => {} }, active: true, cancel: () => ((cancelled += 1), controller.abort()) })),
      { columns: 120, rows: 32 },
    );
    open.push(tui);

    // What the activity log held when the screen opened, and the agent's first file, read from its worktree.
    let frame = await tui.waitFor((text) => text.includes('"starting on the greeting"') && text.includes("✎ greeting.txt"));
    expect(frame).toContain("reported at the end of its turn");
    expect(frame).toMatch(/attempt \d+s\/20m/);
    expect(footerOf(frame)).toBe("enter fold  d full diff  l raw log  esc back  ctrl+c cancel");

    // The activity log grows.
    const log = activityLogPath(await locateRepo(repo), runId, id);
    const entry = (item: Omit<ActivityEntry, "time">) => appendFileSync(log, `${JSON.stringify({ ...item, time: new Date().toISOString() })}\n`);
    entry({ type: "tool_call", toolCallId: "t1", kind: "execute", title: "npm test", status: "completed", paths: [], permission: null } as Omit<ActivityEntry, "time">);
    entry({ type: "usage", scope: "attempt", usage: { source: "scripted for this test", inputTokens: 1_200, outputTokens: 300, totalTokens: null, cachedInputTokens: null, cost: null } } as Omit<ActivityEntry, "time">);
    frame = await tui.waitFor((text) => text.includes("$ npm test") && text.includes("in 1.2k · out 300"));
    expect(frame).toContain("cached not reported");
    expect(frame).toContain("cost not reported");

    // The worktree changes: the newest file is expanded, the older one folds to a line.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(workspace, "verify.mjs"), `${VERIFY_GREETING}// checked by hand\n`);
    frame = await tui.waitFor("+ // checked by hand", 15_000);
    expect(frame).toMatch(/✎ greeting\.txt {2}\+1 −0 {2}added/);
    expect(frame).toMatch(/✎ verify\.mjs {2}\+1 −0/);

    // Ctrl+C cancels through the run's signal; the ledger grows to the end, and the receipt comes.
    await tui.press("ctrl+c");
    const result = await done;
    expect(cancelled).toBe(1);
    expect(result.state.state).toBe("cancelled");
    expect(result.state.cancelRequestedAt).not.toBeNull();
    frame = await tui.waitFor("Receipt", 15_000);
    expect(frame).toContain("✗ cancelled");
    expect(footerOf(frame)).toMatch(/ctrl\+c quit$/);
  }
}
