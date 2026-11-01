import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activityLogger, parseActivity, type ActivityItem } from "../src/adapters/activity.ts";
import { mockAdapter } from "../src/adapters/mock/index.ts";
import { countToolCalls, toolCallsOf } from "../src/evaluation/tool-calls.ts";
import { claudeCode, codex, defineWorkflow, mock, opencode, readRunEvents, resumeRun, runWorkflow, type ActivityEntry, type AgentRef } from "../src/index.ts";
import { activityLogPath, locateRepo, runsDir, toolCallLogPath } from "../src/runtime/paths.ts";
import { fixture as claudeFixture, installFakeClaude } from "./helpers/claude.ts";
import { ahp } from "./helpers/cli.ts";
import { fixture as codexFixture, installFakeCodex } from "./helpers/codex.ts";
import { truncateLedgerAfter } from "./helpers/ledger.ts";
import { captures, completingScenario, installFakeOpencode } from "./helpers/opencode.ts";
import { createTempRepo, removeTempRepos, VERIFY_OK, writeTree } from "./helpers/repo.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  removeTempRepos();
});

const workflowOf = (agent: AgentRef) => defineWorkflow({ name: "activity", steps: [{ id: "work", agent, verification: { command: "node verify.mjs" } }] });

/** Runs one step by `agent` in a fresh repository, and reads its first attempt's activity log. */
async function activityOf(agent: AgentRef) {
  const repo = createTempRepo({ "verify.mjs": VERIFY_OK });
  const { runId, state } = await runWorkflow(workflowOf(agent), { repo });
  const attempt = state.steps[0]!.attempts[0]!;
  const file = activityLogPath(await locateRepo(repo), runId, attempt.id);
  return { repo, runId, state, attempt, file, entries: parseActivity(readFileSync(file, "utf8")) };
}

/** What the tests compare: an entry without its time. */
const untimed = (entries: ActivityEntry[]) => entries.map(({ time: _time, ...rest }) => rest);

describe("the activity log of each adapter", () => {
  it("Claude Code: tool calls from tool_use and tool_result, messages, each message's own usage, the plan limit, then the attempt's usage", async () => {
    const fake = installFakeClaude({ stream: claudeFixture("complete") });
    restores.push(fake.restore);

    const { state, entries } = await activityOf(claudeCode());

    expect(state.state).toBe("succeeded");
    expect(untimed(entries)).toEqual([
      { type: "tool_call", toolCallId: "toolu_01NYEQkBrxpNx9M9v8c1WUbs", kind: "Write", title: null, status: "in_progress", paths: ["/work/repo\\hello.txt"], permission: null },
      { type: "usage", scope: "message", usage: expect.objectContaining({ inputTokens: 2, outputTokens: 16, totalTokens: null, cost: null }) },
      // Sent on healthy runs: a limit, never an error; the same report again later is not repeated.
      { type: "limit", tool: "claude-code", kind: "plan_limit", status: "allowed", window: "five_hour" },
      { type: "tool_call", toolCallId: "toolu_01NYEQkBrxpNx9M9v8c1WUbs", kind: "Write", title: null, status: "completed", paths: ["/work/repo\\hello.txt"], permission: null },
      { type: "message", text: expect.stringMatching(/^I created `hello\.txt` in the repo root/) },
      { type: "usage", scope: "message", usage: expect.objectContaining({ inputTokens: 2, outputTokens: 5 }) },
      { type: "tool_call", toolCallId: "toolu_01PXdbRFuVNMhnjY4iXbcvxV", kind: "StructuredOutput", title: null, status: "in_progress", paths: [], permission: null },
      { type: "usage", scope: "message", usage: expect.objectContaining({ inputTokens: 4, outputTokens: 24 }) },
      { type: "tool_call", toolCallId: "toolu_01PXdbRFuVNMhnjY4iXbcvxV", kind: "StructuredOutput", title: null, status: "completed", paths: [], permission: null },
      { type: "usage", scope: "attempt", usage: expect.objectContaining({ inputTokens: 8, outputTokens: 534, cachedInputTokens: 19027, cost: { amount: 0.053686700000000004, currency: "USD" } }) },
    ]);
    const usages = entries.filter((entry) => entry.type === "usage");
    expect(usages[0]!.usage.source).toContain("this message alone, not the attempt so far");
    // The message is the first 300 characters, cut.
    const message = entries.find((entry) => entry.type === "message")!;
    expect(message.text).toHaveLength(301);
    expect(message.text.endsWith("…")).toBe(true);
  });

  it("Claude Code: the ledger's usage is the result event's, unchanged by the log", async () => {
    const fake = installFakeClaude({ stream: claudeFixture("complete") });
    restores.push(fake.restore);

    const { attempt, entries } = await activityOf(claudeCode());

    const last = entries.at(-1)!;
    expect(last).toMatchObject({ type: "usage", scope: "attempt" });
    expect(attempt.usage).toEqual((last as Extract<ActivityEntry, { type: "usage" }>).usage);
  });

  it("Codex: tool calls from command_execution items with Codex's own status, messages, and usage only at turn.completed", async () => {
    const home = writeTree({ "sessions/.keep": "" });
    const fake = installFakeCodex({ stream: codexFixture("declined-commands") });
    restores.push(fake.restore);

    const { entries } = await activityOf(codex({ codexHome: home }));

    const kinds = entries.map((entry) => (entry.type === "tool_call" ? `${entry.toolCallId} ${entry.status}` : entry.type));
    expect(kinds).toEqual([
      "message",
      "item_1 in_progress",
      "item_1 completed",
      "item_2 in_progress",
      "item_2 completed",
      "message",
      "item_4 in_progress",
      "item_4 declined",
      "item_5 in_progress",
      "item_5 declined",
      "item_6 in_progress",
      "item_6 declined",
      "message",
      // No usage before the turn ends: Codex states none, and none is estimated.
      "usage",
    ]);
    const call = entries.find((entry) => entry.type === "tool_call")!;
    expect(call).toMatchObject({ kind: "command_execution", paths: [], permission: null });
    expect(call.type === "tool_call" && call.title).toMatch(/^"C:\\\\Program Files\\\\PowerShell/);
    // The command's output is never kept.
    expect(JSON.stringify(entries)).not.toContain("the text of a skill file");
    expect(entries.at(-1)).toMatchObject({ type: "usage", scope: "attempt", usage: { inputTokens: 87865, outputTokens: 836, cachedInputTokens: 58624, cost: null } });
  });

  it("Codex: a file_change item is a tool call on its paths, relative to the workspace", async () => {
    const home = writeTree({ "sessions/.keep": "" });
    // Codex's documented `file_change` item shape (not in a captured stream: the captures have no file change).
    const stream = [
      { type: "thread.started", thread_id: "00000000-0000-4000-8000-000000000009" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "file_change", changes: [{ path: "src/cart.ts", kind: "update" }], status: "completed" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: '{"summary":"ok"}' } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const fake = installFakeCodex({ stream: `${stream}\n` });
    restores.push(fake.restore);

    const { entries } = await activityOf(codex({ codexHome: home }));

    expect(untimed(entries)[0]).toEqual({ type: "tool_call", toolCallId: "item_0", kind: "file_change", title: null, status: "completed", paths: ["src/cart.ts"], permission: null });
  });

  it("OpenCode: its message once whole, the context window as a limit, no usage for a zero cost, then the turn's usage", async () => {
    const fake = installFakeOpencode(completingScenario());
    restores.push(fake.restore);

    const { entries } = await activityOf(opencode());

    expect(untimed(entries)).toEqual([
      { type: "message", text: "ok" },
      { type: "limit", tool: "opencode", kind: "context_window", used: 13346, size: 200000 },
      { type: "usage", scope: "attempt", usage: expect.objectContaining({ inputTokens: 34, outputTokens: 3, totalTokens: 13349, cachedInputTokens: 13312, cost: null }) },
    ]);
  });

  it("OpenCode: chunks of one message are joined, and a cost above zero in usage_update is usage so far", async () => {
    const chunk = (text: string, messageId: string) => ({ ...captures.messageChunkOk, params: { sessionId: "ses_fixture", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } } });
    const priced = { ...captures.usageUpdate, params: { sessionId: "ses_fixture", update: { sessionUpdate: "usage_update", used: 500, size: 1000, cost: { amount: 0.0123, currency: "USD" } } } };
    const fake = installFakeOpencode(
      completingScenario({
        prompt: { steps: [{ send: chunk("Looking ", "msg_1") }, { send: chunk("at it.", "msg_1") }, { send: chunk("Done.", "msg_2") }, { send: priced }], result: captures.completeResult },
      }),
    );
    restores.push(fake.restore);

    const { entries } = await activityOf(opencode());

    expect(untimed(entries).slice(0, 4)).toEqual([
      { type: "message", text: "Looking at it." },
      { type: "message", text: "Done." },
      { type: "limit", tool: "opencode", kind: "context_window", used: 500, size: 1000 },
      { type: "usage", scope: "attempt", usage: expect.objectContaining({ inputTokens: null, outputTokens: null, cost: { amount: 0.0123, currency: "USD" } }) },
    ]);
  });

  it("OpenCode on a local engine: the same entries, and no cost, since a local engine reports none", async () => {
    const fake = installFakeOpencode(completingScenario());
    restores.push(fake.restore);

    const { state, entries } = await activityOf(opencode({ localEndpoint: { engine: "vllm", baseURL: "http://localhost:8001/v1", models: ["fake-model"] } }));

    expect(state.state).toBe("succeeded");
    expect(entries.map((entry) => entry.type)).toEqual(["message", "limit", "usage"]);
    for (const entry of entries) if (entry.type === "usage") expect(entry.usage.cost).toBeNull();
  });

  it("the mock: a script's entries, stamped with the time, and its old `toolCallLog` lines as tool calls", async () => {
    const activity: ActivityItem[] = [
      { type: "tool_call", toolCallId: "t1", kind: "edit", title: null, status: "completed", paths: ["src/a.ts"], permission: null },
      { type: "message", text: "Fixing the total." },
      { type: "usage", scope: "attempt", usage: { source: "mock (scripted)", inputTokens: 10, outputTokens: 2, totalTokens: null, cachedInputTokens: null, cost: null } },
      { type: "limit", tool: "mock", kind: "context_window", used: 10, size: 100 },
    ];

    const { entries } = await activityOf(mock({ attempts: [{ toolCallLog: [{ toolCallId: "t0", status: "completed", permission: null }], activity }] }));

    expect(untimed(entries)).toEqual([{ type: "tool_call", toolCallId: "t0", kind: null, title: null, status: "completed", paths: [], permission: null }, ...activity]);
    for (const entry of entries) expect(entry.time).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("the mock keeps no log when its script has no entries", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK });
    const { runId, state } = await runWorkflow(workflowOf(mock({ attempts: [{}] })), { repo });

    const file = activityLogPath(await locateRepo(repo), runId, state.steps[0]!.attempts[0]!.id);
    expect(() => readFileSync(file)).toThrow();
  });

  it("the mock refuses entries that are not activity entries", () => {
    const problems = (activity: unknown) => mockAdapter.validateOptions({ attempts: [{ activity }] });

    expect(problems([{ type: "message", text: "ok" }])).toEqual([]);
    expect(problems([{ type: "thought", text: "x" }])).toEqual([expect.stringContaining("`activity` must be an array of activity entries")]);
    expect(problems("x")).toHaveLength(1);
  });
});

describe("the activity logger", () => {
  const logIn = () => {
    const dir = writeTree({ "work/.keep": "" });
    const file = join(dir, "activity", "att_1.jsonl");
    return { log: activityLogger(file, join(dir, "work"), "mock"), read: () => parseActivity(readFileSync(file, "utf8")), dir };
  };

  it("redacts a key in a message before it cuts it to 300 characters", () => {
    const { log, read } = logIn();

    log.message(`Calling with sk-proj-${"a".repeat(40)} now. ${"x".repeat(400)}`);

    const [entry] = read();
    expect(entry).toMatchObject({ type: "message" });
    const text = entry!.type === "message" ? entry!.text : "";
    expect(text).toMatch(/^Calling with sk-\[redacted\] now\./);
    expect(text).not.toContain("sk-proj");
    expect(text).toHaveLength(301);
  });

  it("makes paths inside the workspace relative, keeps others as they are, and writes a call again only when it changed", () => {
    const { log, read, dir } = logIn();

    const call = { toolCallId: "c1", kind: "edit", title: "write", status: "in_progress", paths: [join(dir, "work", "src", "a.ts"), join(dir, "elsewhere.txt"), "already/relative.ts"] };
    log.call(call);
    log.call(call);
    log.call({ ...call, status: "completed" });

    const entries = read();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ paths: ["src/a.ts", join(dir, "elsewhere.txt"), "already/relative.ts"] });
  });

  it("does not write usage that is no report, nor the same limit twice in a row", () => {
    const { log, read } = logIn();

    log.usage("attempt", { source: "x", inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null });
    log.limit({ kind: "plan_limit", status: "allowed", window: "five_hour" });
    log.limit({ kind: "plan_limit", status: "allowed", window: "five_hour" });
    log.limit({ kind: "plan_limit", status: "allowed_warning", window: "five_hour" });

    expect(read().map((entry) => (entry.type === "limit" ? entry.status : entry.type))).toEqual(["allowed", "allowed_warning"]);
  });

  it("never throws when it cannot write", () => {
    const dir = writeTree({ "a-file": "x" });
    const log = activityLogger(join(dir, "a-file", "activity", "att_1.jsonl"), dir, "mock");

    expect(() => log.message("hello")).not.toThrow();
  });

  it("skips a line a crash tore, and a line that is not an entry", () => {
    const line = JSON.stringify({ type: "message", time: "2026-11-02T00:00:00.000Z", text: "ok" });

    expect(parseActivity(`${line}\n{"type":"bogus","time":"x"}\n\n${line}\n{"type":"message","ti`)).toHaveLength(2);
  });
});

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
  const { runId, state } = await runWorkflow(workflowOf(opencode()), { repo });
  expect(state.state).toBe("succeeded");
  truncateLedgerAfter(repo, runId, "attempt_running");
  const attemptId = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_created")!.attemptId;
  return { repo, runId, attemptId };
}

const BASH_CALLS = [
  { type: "tool_call", time: expect.any(String), toolCallId: "call_bash", kind: "execute", title: "git push origin main", status: "in_progress", paths: ["."], permission: null },
  { type: "tool_call", time: expect.any(String), toolCallId: "call_bash", kind: "execute", title: "git push origin main", status: "permission_requested", paths: ["."], permission: "rejected" },
  { type: "tool_call", time: expect.any(String), toolCallId: "call_bash", kind: "execute", title: "git push origin main", status: "failed", paths: ["."], permission: null },
  { type: "tool_call", time: expect.any(String), toolCallId: "call_write", kind: "edit", title: "write", status: "in_progress", paths: ["out.txt"], permission: null },
];

describe("the activity log in a recovery report", () => {
  it("shows what the agent was doing when its attempt was found unknown", async () => {
    const { repo, runId } = await stoppedWhileRunning();

    const { state } = await resumeRun({ repo, runId });

    expect(state.state).toBe("needs_recovery");
    const report = state.steps[0]!.attempts[0]!.recovery!.report!;
    expect(report.activity).toEqual({
      truncated: false,
      entries: [...BASH_CALLS, { type: "usage", time: expect.any(String), scope: "attempt", usage: expect.objectContaining({ inputTokens: 34 }) }],
    });
  });

  it("is kept in the repository's AHP directory, outside the attempt's workspace, so it never shows in the attempt's diff", async () => {
    const { repo, runId } = await stoppedWhileRunning();
    const { state } = await resumeRun({ repo, runId });
    const attempt = state.steps[0]!.attempts[0]!;

    const file = join(runsDir(await locateRepo(repo)), runId, "activity", `${attempt.id}.jsonl`);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(5);
    expect(attempt.recovery!.report!.workspace.changed).toEqual([]);
  });

  it("lists the last hundred entries of a longer log and says the earlier ones were left out, and skips a line a crash tore", async () => {
    const { repo, runId, attemptId } = await stoppedWhileRunning();
    const file = activityLogPath(await locateRepo(repo), runId, attemptId);
    for (let n = 0; n < 150; n++) appendFileSync(file, `${JSON.stringify({ type: "message", time: "2026-11-02T00:00:00.000Z", text: `step ${n}` })}\n`);
    appendFileSync(file, '{"type": "message", "time": "2026-11-02T00:00:00.000Z", "te');

    const { state } = await resumeRun({ repo, runId });

    const log = state.steps[0]!.attempts[0]!.recovery!.report!.activity!;
    expect(log.truncated).toBe(true);
    expect(log.entries).toHaveLength(100);
    expect(log.entries.at(-1)).toMatchObject({ type: "message", text: "step 149" });
  });

  it("reads an old run's tool-calls/ log as its tool calls when the attempt has no activity log", async () => {
    const { repo, runId, attemptId } = await stoppedWhileRunning();
    const location = await locateRepo(repo);
    rmSync(activityLogPath(location, runId, attemptId));
    const legacy = toolCallLogPath(location, runId, attemptId);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, `${JSON.stringify({ time: "2026-10-28T00:00:00.000Z", toolCallId: "call_old", kind: "read", title: "read", status: "completed", paths: [], permission: null })}\n`);

    const { state } = await resumeRun({ repo, runId });

    expect(state.steps[0]!.attempts[0]!.recovery!.report!.activity).toEqual({
      truncated: false,
      entries: [{ type: "tool_call", time: "2026-10-28T00:00:00.000Z", toolCallId: "call_old", kind: "read", title: "read", status: "completed", paths: [], permission: null }],
    });
  });

  it("is null for an attempt that wrote none", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK });
    const { state } = await runWorkflow(workflowOf(mock({ attempts: [{ loseContact: true }] })), { repo });

    expect(state.state).toBe("needs_recovery");
    expect(state.steps[0]!.attempts[0]!.recovery!.report!.activity).toBeNull();
  });

  it("reads the mock's entries, as written for a lost attempt", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK });
    const activity: ActivityItem[] = [{ type: "message", text: "Halfway there." }];

    const { state } = await runWorkflow(workflowOf(mock({ attempts: [{ activity, loseContact: true }] })), { repo });

    expect(state.steps[0]!.attempts[0]!.recovery!.report!.activity!.entries).toEqual([{ type: "message", time: expect.any(String), text: "Halfway there." }]);
  });
});

describe("ahp recover, for an attempt that has an activity log", () => {
  it("prints each entry, the last one last, with AHP's answer to a permission request and the usage's source", async () => {
    const { repo, runId } = await stoppedWhileRunning();

    const recover = ahp(["recover", runId], repo);

    expect(recover.stderr).toBe("");
    expect(recover.stdout).toContain("activity log: 5 entries");
    expect(recover.stdout).toMatch(/in_progress: execute "git push origin main" on \./);
    expect(recover.stdout).toMatch(/permission_requested, rejected by AHP: execute "git push origin main"/);
    expect(recover.stdout).toMatch(/in_progress: edit "write" on out\.txt\n.*usage reported \(the attempt so far\): 34 input tokens.*source: opencode acp session\/prompt result.*\n.*Host and external effects are undetermined/s);
  });
});

describe("tool calls counted for an evaluation", () => {
  it("counts only the activity log's tool calls", () => {
    const lines = [
      { type: "tool_call", time: "t", toolCallId: "a", kind: null, title: null, status: "completed", paths: [], permission: null },
      { type: "message", time: "t", text: "a" },
      { type: "tool_call", time: "t", toolCallId: "b", kind: null, title: null, status: "failed", paths: [], permission: "rejected" },
    ];

    expect(countToolCalls(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual({ total: 2, completed: 1, failed: 1, refused: 1 });
  });

  it("still counts an older run's attempt from its tool-calls/ log", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_OK });
    const calls = [{ toolCallId: "a", status: "completed", permission: null }, { toolCallId: "b", status: "failed", permission: "rejected" as const }];
    const { runId, state } = await runWorkflow(workflowOf(mock({ attempts: [{ toolCallLog: calls }] })), { repo });
    const attempts = state.steps[0]!.attempts;
    const location = await locateRepo(repo);
    const now = await toolCallsOf(repo, runId, attempts);
    // The same attempt as an older run kept it: lines without a type, under tool-calls/.
    const legacy = toolCallLogPath(location, runId, attempts[0]!.id);
    mkdirSync(dirname(legacy), { recursive: true });
    const lines = readFileSync(activityLogPath(location, runId, attempts[0]!.id), "utf8").split("\n").filter(Boolean).map((line) => {
      const { type: _type, ...entry } = JSON.parse(line) as { type: string };
      return JSON.stringify(entry);
    });
    writeFileSync(legacy, `${lines.join("\n")}\n`);
    renameSync(activityLogPath(location, runId, attempts[0]!.id), `${legacy}.moved`);

    const then = await toolCallsOf(repo, runId, attempts);

    expect(now).toMatchObject({ total: 2, completed: 1, failed: 1, refused: 1 });
    expect(then).toEqual(now);
  });
});
