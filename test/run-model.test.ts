import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatBriefReceipt, formatReceipt } from "../src/commands/receipt-text.ts";
import { receiptOf } from "../src/commands/receipt.ts";
import { defineWorkflow, mock, readRunEvents, rejectStep, runWorkflow, type MockAttemptScript } from "../src/index.ts";
import { replay } from "../src/ledger/replay.ts";
import type { ActivityEntry, LedgerEvent } from "../src/protocol/index.ts";
import { parseUnifiedDiff, untrackedFile, type DiffFile } from "../src/tui/diff-model.ts";
import { bodyOf, costBasisOf, duration, limitText, runModel, windowStart, type Block, type Line, type RunFiles, type RunModel } from "../src/tui/run-model.ts";
import { homeModel } from "../src/tui/screens/home-model.ts";
import { gatedWorkflow, gateStep } from "./helpers/approval.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";
import { approved, changesRequested, implemented, implementStep, reviewedWorkflow, reviewStep } from "./helpers/review.ts";

afterAll(removeTempRepos);

const PID = 4242;
const text = (line: Line) => line.segments.map((segment) => segment.text).join("");
const texts = (lines: readonly Line[]) => lines.map(text);
const blockOf = (model: RunModel, stepId: string): Block => model.blocks.find((block) => block.stepId === stepId)!;

let repo: string;
beforeAll(() => {
  repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
});

/** What the screen would have read of the run's files, the ledger from its file. */
async function filesOf(runId: string, extra: Partial<RunFiles> = {}, cut?: (event: LedgerEvent) => boolean): Promise<RunFiles> {
  let events = await readRunEvents({ repo, runId });
  if (cut) events = events.slice(0, events.findIndex(cut) + 1);
  return { events, state: replay(events), activity: {}, diff: null, lastOutput: {}, lock: { state: "free" }, ...extra };
}

const NOW = Date.parse("2026-01-01T00:01:12.000Z");
const modelOf = (files: RunFiles, toggled: string[] = []) => runModel(files, { now: NOW, pid: PID, toggled: new Set(toggled) });

describe("the run model: each step's block", () => {
  it("a clean pass: ✓, the tool and models, the agent reported done and the check verified it", async () => {
    const script: MockAttemptScript = { ...hello, reportedModel: "mock-large", usage: { inputTokens: 3_100, outputTokens: 800 } };
    const workflow = defineWorkflow({ name: "clean", steps: [{ id: "implement", agent: { ...mock({ attempts: [script] }), model: "mock-small" }, verification: { command: "node verify.mjs" } }] });
    const { runId } = await runWorkflow(workflow, { repo });

    const model = modelOf(await filesOf(runId));
    const block = blockOf(model, "implement");

    expect(block).toMatchObject({ mark: "ok", who: "mock · mock-small", reportedModel: "mock-large", tokens: "3.1k in · 800 out", expanded: false });
    expect(texts(block.lines)).toEqual(["✓ reported done · verified: `node verify.mjs` passed in a clean copy"]);
    expect(model.title).toMatch(/^run run_[a-z0-9]+ · clean · \d+s · mock$/);
    expect(model.receipt && texts(model.receipt)).toEqual([
      "✓ implement: verified: `node verify.mjs` passed in a clean copy",
      expect.stringMatching(/^usage mock: 3\.1k in · 800 out \(as reported; .+\)$/),
      "scripted mock agents: their results are not evidence",
    ]);
  });

  it("a retry: one line with why and the budget, the failing output when the block is expanded", async () => {
    const { runId } = await runWorkflow(retryWorkflow([goodbye, hello]), { repo });
    const files = await filesOf(runId);

    const folded = blockOf(modelOf(files), "implement");
    expect(folded.mark).toBe("ok");
    // Folded, the retry and how it ended: a retry line alone reads as still failing (ticket 10).
    expect(texts(bodyOf(folded))).toEqual(["↻ attempt 1: greeting missing or wrong, retrying (retry 1 of 2)", "✓ reported done · verified: `node verify.mjs` passed in a clean copy"]);

    const expanded = blockOf(modelOf(files, ["implement"]), "implement");
    // The check's own output, its last lines: VERIFY_GREETING prints where it ran, then what is wrong.
    expect(texts(bodyOf(expanded))).toEqual([
      "↻ attempt 1: greeting missing or wrong, retrying (retry 1 of 2)",
      expect.stringMatching(/^ {4}cwd=/),
      "    greeting missing or wrong",
      "✓ reported done · verified: `node verify.mjs` passed in a clean copy",
    ]);
  });

  it("a send-back: the review's finding on the step it sent back, the review's verdict on its own", async () => {
    const { runId } = await runWorkflow(reviewedWorkflow(implementStep([implemented(1), implemented(2)]), reviewStep([changesRequested("rename the greeting", "add a test"), approved()])), { repo });
    const model = modelOf(await filesOf(runId), ["implement", "review"]);

    expect(texts(blockOf(model, "implement").folded)).toEqual(["↻ sent back by review: rename the greeting (retry 1 of 2)", "✓ reported done · verified: `node verify.mjs` passed in a clean copy"]);
    expect(texts(blockOf(model, "implement").lines).slice(0, 3)).toEqual(["↻ sent back by review: rename the greeting (retry 1 of 2)", "    | rename the greeting", "    | add a test"]);
    expect(texts(blockOf(model, "review").lines).slice(-2)).toEqual(["✓ reported done · verified: its output is complete (a structural check, not of its quality) · verdict: approved", "    | nothing to change"]);
    expect(texts(model.receipt!)).toContain("  sent back by review (attempt 1): the next review approved the revision");
  });

  it("a rejection at the gate sends the review back: folded, its block shows the rejection and the review's answer (ticket 10)", async () => {
    const workflow = defineWorkflow({ name: "reviewed-gate", steps: [implementStep([implemented(1)]), reviewStep([approved("looks right"), approved("the test already covers a cart with several items")]), gateStep()] });
    const { runId } = await runWorkflow(workflow, { repo });
    await rejectStep({ repo, runId, stepId: "approve", reason: "add a test for several items" });

    const model = modelOf(await filesOf(runId));
    expect(blockOf(model, "approve").mark).toBe("wait");
    expect(blockOf(model, "review").expanded).toBe(false);
    expect(texts(bodyOf(blockOf(model, "review")))).toEqual([
      expect.stringMatching(/^↻ rejected at approve by .+: add a test for several items \(retry 1 of 2\)$/),
      "✓ reported done · verified: its output is complete (a structural check, not of its quality) · verdict: approved",
      "    | the test already covers a cart with several items",
    ]);
  });

  it("a failure: ✗, expanded, the failing line; the receipt says not verified and what to run next", async () => {
    const { runId } = await runWorkflow(retryWorkflow([goodbye], { retry: { budget: 0 } }), { repo });
    const model = modelOf(await filesOf(runId));
    const block = blockOf(model, "implement");

    expect(block).toMatchObject({ mark: "fail", expanded: true });
    expect(texts(block.lines)).toEqual(["✗ reported done · not verified: greeting missing or wrong"]);
    expect(texts(model.receipt!)).toEqual([
      "✗ implement: not verified: `node verify.mjs` failed",
      "  the agent reported done once and its check never passed; first: attempt 1: greeting missing or wrong",
      "usage mock: none reported",
      `next ahp inspect ${runId} shows every attempt and its evidence`,
      "scripted mock agents: their results are not evidence",
    ]);
  });

  it("a gate waiting: !, the changed files and how to decide; no receipt while the run waits", async () => {
    const { runId } = await runWorkflow(gatedWorkflow(implementStep([implemented(1)])), { repo });
    const model = modelOf(await filesOf(runId));
    const gate = blockOf(model, "approve");

    expect(gate).toMatchObject({ mark: "wait", expanded: true });
    expect(texts(gate.lines)).toEqual([
      "! waiting for your approval: 2 changed files",
      "  ✎ greeting.txt  added",
      "  ✎ round.txt  added",
      `  decide: ahp approve ${runId} approve, or ahp reject ${runId} approve --reason <text>`,
    ]);
    expect(model.blocks[model.active]!.stepId).toBe("approve");
    expect(model.receipt).toBeNull();
    // Nobody holds the run while it waits for a person, and that is no "stopped partway".
    expect(model.notice).toBeNull();
  });

  it("an unknown attempt: !, why, and the command that decides it", async () => {
    const { runId, state } = await runWorkflow(retryWorkflow([goodbye]), { repo });
    const unknown = state.steps[0]!.attempts[1]!;
    const block = blockOf(modelOf(await filesOf(runId)), "implement");

    expect(block.mark).toBe("wait");
    expect(texts(block.lines).slice(-2)).toEqual([`! outcome unknown: ${unknown.recovery!.detail}`, `  decide: ahp recover ${unknown.id} --policy adopt|abort`]);
  });
});

describe("the run model while an attempt works", () => {
  let running: RunFiles;
  let attemptId: string;
  const time = (seconds: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString();

  beforeAll(async () => {
    const { runId, state } = await runWorkflow(retryWorkflow([hello]), { repo });
    attemptId = state.steps[0]!.attempts[0]!.id;
    // The ledger as it was while the agent ran, held by a live process.
    running = await filesOf(runId, { lock: { state: "held", owner: { host: "here", pid: PID, startedAt: time(0) } } }, (event) => event.type === "attempt_running");
    running = { ...running, events: running.events.map((event) => ({ ...event, time: time(0) })) };
  });

  const activity = (): ActivityEntry[] => [
    { type: "tool_call", time: time(2), toolCallId: "c1", kind: "read", title: "reading src/cart.ts", status: "in_progress", paths: ["src/cart.ts"], permission: null },
    { type: "tool_call", time: time(3), toolCallId: "c1", kind: "read", title: "reading src/cart.ts", status: "completed", paths: ["src/cart.ts"], permission: null },
    { type: "tool_call", time: time(9), toolCallId: "c2", kind: "execute", title: "npm test", status: "failed", paths: [], permission: null },
    { type: "message", time: time(10), text: "The quantity was ignored in the reducer;\nfixing the test next." },
    { type: "usage", time: time(10), scope: "attempt", usage: { source: "scripted", inputTokens: 3_100, outputTokens: 800, totalTokens: null, cachedInputTokens: null, cost: null } },
    { type: "limit", time: time(10), tool: "mock", kind: "plan_limit", status: "allowed", window: "five_hour" },
    { type: "limit", time: time(11), tool: "mock", kind: "context_window", used: 13_300, size: 200_000 },
  ];
  const diff = (): DiffFile[] => [
    { ...parseUnifiedDiff("diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -12 +12 @@\n-const total = items.reduce((s, i) => s + i.price, 0)\n+const total = items.reduce((s, i) => s + i.price * i.qty, 0)\n")[0]!, changedAt: Date.parse(time(5)) },
    { ...untrackedFile("notes.md", Buffer.from("one\ntwo\n"), Date.parse(time(1))) },
    { ...untrackedFile("logo.png", Buffer.from([0x89, 0x50, 0, 1]), Date.parse(time(4))) },
  ];

  it("shows what it reads, runs and says, and the code changing, in the order it happened; the newest file expanded", () => {
    const model = modelOf({ ...running, activity: { [attemptId]: activity() }, diff: { attemptId, files: diff() } });
    const block = blockOf(model, "implement");

    expect(block).toMatchObject({ mark: "running", expanded: true, tokens: "3.1k in · 800 out" });
    expect(texts(block.lines)).toEqual([
      "✎ notes.md  +2 −0  added",
      "● reading src/cart.ts",
      "✎ logo.png  binary, not shown  added",
      "✎ src/cart.ts  +1 −1",
      "  ⋯",
      "    12 − const total = items.reduce((s, i) => s + i.price, 0)",
      "    12 + const total = items.reduce((s, i) => s + i.price * i.qty, 0)",
      "$ npm test  ✗ failed",
      '"The quantity was ignored in the reducer; fixing the test next."',
    ]);
    expect(model.runningAttempt).toBe(attemptId);
    expect(model.notice).toBeNull();
  });

  it("leaves out a cd into the attempt's own worktree, and says a backslashed path once (ticket 10)", () => {
    const calls: ActivityEntry[] = [
      { type: "tool_call", time: time(2), toolCallId: "c1", kind: "execute", title: `cd "C:\\Users\\me\\ahp\\worktrees\\run_abc\\${attemptId}" && npm test`, status: "completed", paths: [], permission: null },
      { type: "tool_call", time: time(3), toolCallId: "c2", kind: "execute", title: "cd ../elsewhere && rm -rf build", status: "completed", paths: [], permission: null },
      { type: "tool_call", time: time(4), toolCallId: "c3", kind: "read", title: "src\\cart.mjs", status: "completed", paths: ["src/cart.mjs"], permission: null },
    ];
    const lines = texts(blockOf(modelOf({ ...running, activity: { [attemptId]: calls } }), "implement").lines);
    expect(lines).toContain("$ npm test");
    // A cd anywhere else is part of what the agent did, and stays.
    expect(lines).toContain("$ cd ../elsewhere && rm -rf build");
    expect(lines).toContain("● src\\cart.mjs");
  });

  it("leaves out a message that is only a review's verdict as JSON, and keeps any other (ticket 10)", () => {
    const said: ActivityEntry[] = [
      { type: "message", time: time(2), text: '{"verdict":"approved","findings":["src/cart.mjs:3 now multiplies' },
      { type: "message", time: time(3), text: "I'll review the change." },
    ];
    expect(texts(blockOf(modelOf({ ...running, activity: { [attemptId]: said } }), "implement").lines)).toEqual(['"I\'ll review the change."']);
  });

  it("says what a reported cost is, from the tool's own source note (ticket 10)", () => {
    expect(costBasisOf(["claude stream-json result event (usage, total_cost_usd); cost is a list-price figure from the tool, not a charge; apiKeySource none"])).toBe("list price, not a charge");
    expect(costBasisOf(["opencode acp session/prompt result (usage); cost is the last usage_update's"])).toBe("as the tool figured it");
    expect(costBasisOf(["a; cost is a list-price figure from the tool, not a charge", "b; cost is the tool's own figure, its basis not stated"])).toBe("as the tool figured it");
    expect(costBasisOf(["codex turn.completed usage"])).toBeNull();
  });

  it("keeps the newest activity lines and counts the older ones", () => {
    const many: ActivityEntry[] = Array.from({ length: 500 }, (_, i) => ({ type: "message", time: time(i), text: `step ${i}` }));
    const block = blockOf(runModel({ ...running, activity: { [attemptId]: many } }, { now: NOW, pid: PID, maxActivity: 20 }), "implement");

    expect(texts(block.lines)[0]).toBe("… 480 earlier lines: l shows the raw log");
    expect(texts(block.lines).at(-1)).toBe('"step 499"');
  });

  it("puts usage and limits in the sidebar as the tool reported them, with not reported where it said nothing", () => {
    const model = modelOf({ ...running, activity: { [attemptId]: activity() }, lastOutput: { [attemptId]: Date.parse(time(69)) } });
    const [usage, limits] = model.sidebar;

    expect(usage!.heading).toBe("mock (scripted, not evidence)");
    expect(texts(usage!.lines)).toEqual(["in 3.1k · out 800", "cached not reported", "cost not reported", "source: scripted", "plan limit: allowed, 5-hour window", "context 13.3k / 200k"]);
    expect(usage!.lines[1]!.segments.find((segment) => segment.text === "not reported")!.tone).toBe("muted");
    expect(limits!.heading).toBe("Limits (AHP) · implement");
    expect(texts(limits!.lines)).toEqual(["attempt 1m12s/20m", "idle 3s/10m", "retries 0/2"]);
  });

  it("says a tool reports its tokens at the end when it reported none so far, and not reported once it ended with none", async () => {
    expect(texts(modelOf(running).sidebar[0]!.lines)).toEqual(["reported at the end of its turn"]);
    const { runId } = await runWorkflow(retryWorkflow([hello]), { repo });
    expect(texts(modelOf(await filesOf(runId)).sidebar[0]!.lines)).toEqual(["not reported"]);
  });

  it("says when another process is writing the run, and when no process is", () => {
    const elsewhere = modelOf({ ...running, lock: { state: "held", owner: { host: "here", pid: 4120, startedAt: time(0) } } });
    expect(text(elsewhere.notice!)).toBe(`run ${running.state.runId} is running in another terminal (PID 4120); this screen only watches it`);
    expect(elsewhere.live).toBe(true);

    const stopped = modelOf({ ...running, lock: { state: "stale", owner: { host: "here", pid: 4120, startedAt: time(0) } } });
    expect(text(stopped.notice!)).toBe(`! its process stopped partway: ahp recover ${running.state.runId} resumes it`);
    expect(blockOf(stopped, "implement").mark).toBe("wait");
    expect(stopped.runningAttempt).toBeNull();
  });

  it("stays fast with 500 activity entries and a 2,000-line diff (the model, not the terminal)", () => {
    const entries: ActivityEntry[] = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0 ? { type: "tool_call", time: time(i), toolCallId: `c${i}`, kind: "edit", title: `edit ${i}`, status: "completed", paths: [`src/f${i}.ts`], permission: null } : { type: "message", time: time(i), text: `message ${i}` },
    );
    const patch = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts", "@@ -1,1000 +1,1000 @@", ...Array.from({ length: 1000 }, (_, i) => `-old ${i}`), ...Array.from({ length: 1000 }, (_, i) => `+new ${i}`)].join("\n");
    const started = performance.now();
    for (let i = 0; i < 10; i++) {
      const files = parseUnifiedDiff(patch);
      runModel({ ...running, activity: { [attemptId]: entries }, diff: { attemptId, files } }, { now: NOW, pid: PID });
    }
    // Ten frames' worth: well under a 100 ms redraw each.
    expect((performance.now() - started) / 10).toBeLessThan(50);
  });
});

describe("home's row for a run that failed before its check", () => {
  it("says what the tool said, not a class name: a usage limit is not a login problem (ticket 10)", async () => {
    const limited: MockAttemptScript = { exitCode: 1, error: { kind: "config_auth", message: "You've hit your usage limit. Upgrade to Plus to continue." } };
    const { runId, state } = await runWorkflow(retryWorkflow([limited]), { repo });
    const [row] = homeModel([{ runId, state, lock: { state: "free" }, problem: null }], NOW).recent;
    expect(row!.detail).toBe("implement: You've hit your usage limit. Upgrade to Plus to continue. · mock");
    const receipt = texts(modelOf(await filesOf(runId)).receipt!);
    expect(receipt[0]).toBe("✗ implement: not verified: the step ended before `node verify.mjs` ran: You've hit your usage limit. Upgrade to Plus to continue.");
    // /model lasts one run: the receipt names the command that makes another tool stick.
    expect(receipt).toContain("or /model implement <tool> for the next run, /settings for every run");
  });
});

describe("the receipt as data", () => {
  it("holds the facts today's ahp inspect prints, unchanged", async () => {
    const { state } = await runWorkflow(reviewedWorkflow(implementStep([{ ...goodbye, outputFields: { summary: "x" } }, implemented(1), implemented(2)]), reviewStep([changesRequested("rename the greeting"), approved()])), { repo });
    const receipt = receiptOf(state);
    const implement = receipt.steps[0]!;

    expect(implement).toMatchObject({ stepId: "implement", command: "node verify.mjs", verdict: "verified", passedAfter: true, reportedDone: [{ attempt: 1, why: "greeting missing or wrong", refused: false }] });
    expect(implement.sendBacks).toEqual([{ kind: "review", attempt: 2, by: "review", findings: ["rename the greeting"], after: "the next review approved the revision", approvedAfter: true }]);
    // The old receipt renders the same data.
    expect(formatReceipt(state)).toContain("  implement: the agent reported done once before its check passed:\n    attempt 1: greeting missing or wrong");
    expect(formatReceipt(state)).toContain("  implement: sent back by review (attempt 2):\n    | rename the greeting\n    the next review approved the revision");
    expect(formatBriefReceipt(state)[0]).toBe("✓ implement: `node verify.mjs` passed · after one failed attempt · sent back once, approved after");
    expect(receipt).toMatchObject({ mock: true, checked: true, next: null });
  });
});

describe("pieces of the run model", () => {
  it.each([
    [0, "0s"],
    [14_000, "14s"],
    [72_000, "1m12s"],
    [20 * 60_000, "20m"],
    [63 * 60_000, "1h3m"],
  ])("duration(%i) is %s", (ms, words) => expect(duration(ms)).toBe(words));

  it("writes a limit as its tool reported it, naming what it did not say", () => {
    expect(limitText({ type: "limit", time: "", tool: "claude-code", kind: "plan_limit", status: "allowed", window: "five_hour" })).toBe("plan limit: allowed, 5-hour window");
    expect(limitText({ type: "limit", time: "", tool: "claude-code", kind: "plan_limit", window: "seven_day" })).toBe("plan limit: status not reported, 7-day window");
    expect(limitText({ type: "limit", time: "", tool: "opencode", kind: "context_window", used: 13_300, size: 200_000 })).toBe("context 13.3k / 200k");
  });

  it.each([
    // total, height, selected from..to → first row shown
    [10, 20, 2, 4, 0],
    [100, 20, 0, 3, 0],
    [100, 20, 90, 95, 80],
    [100, 20, 40, 45, 40],
    [100, 20, 40, 79, 60],
  ])("windowStart(%i rows, %i high, block %i..%i) starts at %i", (total, height, from, to, start) => expect(windowStart(total, height, from, to)).toBe(start));

  it("reads a diff: line numbers, new, deleted and binary files, and a huge one counted but not kept", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,2 +3,2 @@ function f() {",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/new file.txt b/new file.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new file.txt",
      "@@ -0,0 +1 @@",
      "+hi",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,0 +1,4 @@",
      "+1",
      "+2",
      "+3",
      "+4",
    ].join("\n");

    // Four lines kept per file, the hunk's start included.
    const files = parseUnifiedDiff(diff, 4);

    expect(files.map(({ path, change, added, removed, binary, huge }) => ({ path, change, added, removed, binary, huge }))).toEqual([
      { path: "a.ts", change: "modified", added: 1, removed: 1, binary: false, huge: false },
      { path: "new file.txt", change: "added", added: 1, removed: 0, binary: false, huge: false },
      { path: "gone.txt", change: "deleted", added: 0, removed: 1, binary: false, huge: false },
      { path: "img.png", change: "modified", added: null, removed: null, binary: true, huge: false },
      { path: "big.txt", change: "modified", added: 4, removed: 0, binary: false, huge: true },
    ]);
    expect(files[0]!.lines).toEqual([
      { sign: "@", number: null, text: "function f() {" },
      { sign: " ", number: 3, text: "keep" },
      { sign: "-", number: 4, text: "old" },
      { sign: "+", number: 4, text: "new" },
    ]);
    expect(files[4]!.lines).toEqual([]);
  });
});
