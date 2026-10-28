import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.ts";
import { openCodeAdapter } from "../src/adapters/opencode/index.ts";
import { configContentOf, decide, isExternalAction, policyOf } from "../src/adapters/opencode/policy.ts";
import { classify, redacted } from "../src/adapters/opencode/turn.ts";
import { PROTOCOL_VERSION, type AppliedCapabilities, type CapabilityRequest, type HandoffEvidence, type HandoffRevision, type ToolCallLogEntry } from "../src/index.ts";
import { requestsOf, resolveCapabilities } from "../src/runtime/index.ts";
import { captures, completingScenario, installFakeOpencode, type FakeOpencodeScenario, type PromptStep } from "./helpers/opencode.ts";
import { createTempRepo, removeTempRepos, trackForRemoval } from "./helpers/repo.ts";
import { isRunning, until } from "./helpers/process.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  removeTempRepos();
});

/** A handoff revision for the OpenCode adapter, with the capability requests the runtime would add to the step's. */
function handoffOf(applied: AppliedCapabilities, parts: { instructions?: string; requiredOutputFields?: string[]; evidence?: HandoffEvidence[] } = {}): HandoffRevision {
  return {
    schemaVersion: PROTOCOL_VERSION,
    handoffId: "hnd_opencode",
    revision: 1,
    supersedes: null,
    contextId: "run_opencode",
    from: null,
    to: { stepId: "review", adapter: "opencode", requestedModel: null },
    base: { commit: "a".repeat(40) },
    contract: { instructions: parts.instructions ?? "Review the change.", acceptance: { verificationCommand: "node hidden-secret-test.mjs", requiredOutputFields: parts.requiredOutputFields ?? [] } },
    capabilities: applied.capabilities.map(({ level: _level, ...request }) => request),
    network: { stance: applied.network.stance, require: applied.network.require },
    context: { fields: {} },
    artifacts: [],
    evidence: parts.evidence ?? [],
    requires: { fields: [], artifacts: [] },
  };
}

const appliedFor = (capabilities: CapabilityRequest[] = [], platform: NodeJS.Platform = process.platform) =>
  resolveCapabilities(requestsOf({ capabilities }), openCodeAdapter.declaration, platform).applied;

interface Run {
  capabilities?: CapabilityRequest[];
  requestedModel?: string | null;
  options?: unknown;
  requiredOutputFields?: string[];
  adapter?: typeof openCodeAdapter;
  transcript?: { input: string; output: string };
}

/** Starts one attempt of the adapter against the fake `opencode` in a repository whose path has a space. */
async function start(scenario: FakeOpencodeScenario, run: Run = {}) {
  const fake = installFakeOpencode(scenario);
  restores.push(fake.restore);
  const workspace = join(createTempRepo({ "README.md": "x\n" }), "work space");
  mkdirSync(workspace);
  const logDir = realpathSync.native(createTempRepo({ "README.md": "x\n" }));
  const toolCallLog = join(logDir, "tool-calls", "att_opencode1.jsonl");
  const applied = appliedFor(run.capabilities);
  const started = await (run.adapter ?? openCodeAdapter).startAttempt({
    attemptId: "att_opencode1",
    attemptNumber: 1,
    workspace,
    requestedModel: run.requestedModel ?? null,
    capabilities: applied,
    handoff: handoffOf(applied, { requiredOutputFields: run.requiredOutputFields }),
    options: run.options,
    toolCallLog,
    transcript: run.transcript,
  });
  const log =(): ToolCallLogEntry[] => (existsSync(toolCallLog) ? readFileSync(toolCallLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ToolCallLogEntry) : []);
  return { started, fake, workspace, log, applied, toolCallLog };
}

/** Runs one attempt and waits for it to end. */
async function attempt(scenario: FakeOpencodeScenario, run: Run = {}) {
  const result = await start(scenario, run);
  const exit = await result.started.exited;
  return { ...result, exit, call: result.fake.acp() };
}

const method = (call: { received: Record<string, unknown>[] }, name: string) => call.received.filter((message) => message.method === name);
const chunk = (text: string, messageId = "msg_1") => ({ ...captures.messageChunkOk, params: { sessionId: "ses_fixture", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } } });

describe("the OpenCode adapter's transcript", () => {
  it("keeps every message it sent the agent and every line the agent printed, raw, when the runtime gives it transcript files", async () => {
    const dir = realpathSync.native(createTempRepo({ "README.md": "x\n" }));
    const transcript = { input: join(dir, "transcripts", "att.in.txt"), output: join(dir, "transcripts", "att.out.txt") };

    const { call } = await attempt(completingScenario(), { transcript, options: { extraInstructions: "Use the repo's style." } });

    const sent = readFileSync(transcript.input, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string });
    expect(sent.map((message) => message.method)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(readFileSync(transcript.input, "utf8")).toContain("Use the repo's style.");
    // What the agent printed, as the fake received and answered it: the new session's id is in it.
    expect(readFileSync(transcript.output, "utf8")).toContain("ses_fixture");
    expect(call.received.map((message) => message.method)).toEqual(sent.map((message) => message.method));
  });
});

describe("the OpenCode adapter's conversation", () => {
  it("runs `opencode acp` in the workspace, sends the prompt as a session/prompt and never in the arguments, and declares no client capabilities", async () => {
    const { call, workspace } = await attempt(completingScenario(), { options: { extraInstructions: "Use the repo's style." } });

    expect(call.argv).toEqual(["acp", "--pure", "--cwd", workspace]);
    expect(call.cwd).toBe(realpathSync.native(workspace));
    expect(call.pwd).toBe(workspace);
    const initialize = method(call, "initialize")[0] as any;
    expect(initialize.params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect(method(call, "session/new")[0]).toMatchObject({ params: { cwd: workspace, mcpServers: [] } });
    const prompt = method(call, "session/prompt")[0] as any;
    expect(prompt.params.sessionId).toBe("ses_fixture");
    expect(prompt.params.prompt[0].text).toContain("Review the change.");
    expect(prompt.params.prompt[0].text).toContain("Use the repo's style.");
    // The verification command is never given to the agent.
    expect(JSON.stringify(call.received)).not.toContain("hidden-secret-test");
    expect(call.argv.join(" ")).not.toContain("Review");
    // Stdin was ended once the turn was over: that is how the process was told to finish.
    expect(call.stdinEnded).toBe(true);
  });

  it("selects the requested model before it prompts, and selects none when none is requested", async () => {
    const plain = await attempt(completingScenario());
    const asked = await attempt(completingScenario(), { requestedModel: "opencode/deepseek-v4.1-flash-free" });

    expect(method(plain.call, "session/set_config_option")).toEqual([]);
    const order = asked.call.received.map((message) => message.method).filter(Boolean);
    expect(order).toEqual(["initialize", "session/new", "session/set_config_option", "session/prompt"]);
    expect(method(asked.call, "session/set_config_option")[0]).toMatchObject({ params: { sessionId: "ses_fixture", configId: "model", value: "opencode/deepseek-v4.1-flash-free" } });
  });

  it("starts OpenCode with the step's permission rules as inline config, and without the user's Claude Code skills", async () => {
    const { call } = await attempt(completingScenario(), { capabilities: [{ kind: "read_only", require: "cooperative" }] });

    expect(JSON.parse(call.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { edit: "deny", bash: { "git push*": "deny", "git update-ref*": "deny", "gh *": "deny" } } });
    expect(call.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(call.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
  });

  it("reports a completed turn: end_turn, the usage the tool gave with its arithmetic in the source, and the model OpenCode records", async () => {
    const { exit } = await attempt(completingScenario());

    expect(exit).toMatchObject({ exitCode: 0, signal: null, stopReason: "end_turn", error: null, reportedModel: "opencode/big-pickle" });
    expect(exit.usage).toEqual({
      source: expect.stringContaining("inputTokens excludes cachedReadTokens, and totalTokens is input + output + thought + cached read"),
      inputTokens: 34,
      outputTokens: 3,
      totalTokens: 13349,
      cachedInputTokens: 13312,
      cost: null,
    });
    expect(exit.usage!.source).toContain("no cost reported");
  });

  it("reads the model from OpenCode's own export of the session, and asks for the export of that session only", async () => {
    const { fake } = await attempt(completingScenario(), { requestedModel: "opencode/deepseek-v4.1-flash-free" });

    const exports = fake.calls().filter((call) => call.argv[0] === "export");
    expect(exports.map((call) => call.argv)).toEqual([["export", "ses_fixture"]]);
  });

  it("reports no model when the export fails, and runs no export when the model did nothing", async () => {
    const failing = await attempt(completingScenario({ export: { json: {}, exitCode: 1 } }));
    const silent = await attempt({ ...completingScenario(), prompt: { steps: [], result: captures.completeResult } });

    expect(failing.exit.reportedModel).toBeNull();
    expect(silent.exit.reportedModel).toBeNull();
    expect(silent.fake.calls().filter((call) => call.argv[0] === "export")).toEqual([]);
  });

  it("takes the output fields from the last message when it is a JSON object, bare or in a fence, and ignores narration", async () => {
    const asked = { requiredOutputFields: ["summary", "decisions"] };
    const json = JSON.stringify({ summary: "Looks right.", decisions: ["a", "b"], extra: 3, nested: { x: 1 } });
    const bare = await attempt(completingScenario({ prompt: { steps: [{ send: chunk("Let me look.", "msg_a") }, { send: chunk(json, "msg_b") }], result: captures.completeResult } }), asked);
    const fenced = await attempt(completingScenario({ prompt: { steps: [{ send: chunk(`Done:\n\`\`\`json\n${json}\n\`\`\`\n`) }], result: captures.completeResult } }), asked);
    const prose = await attempt(completingScenario({ prompt: { steps: [{ send: chunk(`The summary is "x" ${json}`) }], result: captures.completeResult } }), asked);

    expect(bare.exit.reportedOutput).toEqual({ summary: "Looks right.", decisions: ["a", "b"] });
    expect(fenced.exit.reportedOutput).toEqual({ summary: "Looks right.", decisions: ["a", "b"] });
    expect(prose.exit.reportedOutput).toEqual({});
    const prompt = (method(bare.call, "session/prompt")[0] as any).params.prompt[0].text as string;
    expect(prompt).toContain("summary, decisions");
    expect(prompt).toContain("one JSON object");
    expect(prompt).not.toContain("structured output");
  });

  it("does not record usage for a block of zeros, and records a cost only when it is above zero", async () => {
    const zeros = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } } }));
    const priced = await attempt(
      completingScenario({
        prompt: { steps: [{ send: { ...captures.usageUpdate, params: { sessionId: "ses_fixture", update: { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0.0123, currency: "USD" } } } } }], result: captures.thoughtResult },
      }),
    );

    expect(zeros.exit.usage).toBeNull();
    expect(priced.exit.usage).toMatchObject({ inputTokens: 11707, outputTokens: 8, totalTokens: 11812, cachedInputTokens: 70, cost: { amount: 0.0123, currency: "USD" } });
    expect(priced.exit.usage!.source).toContain("27 thoughtTokens were reported");
  });

  it("passes the stop reasons that mean the agent gave up, and no stop reason for a cancelled turn", async () => {
    const refusal = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "refusal" } } }));
    const maxTokens = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "max_tokens" } } }));

    expect(refusal.exit.stopReason).toBe("refusal");
    expect(maxTokens.exit.stopReason).toBe("max_tokens");
  });
});

describe("the OpenCode adapter's answers to the agent", () => {
  const edit = (steps: PromptStep[] = [{ send: captures.writeToolCall }, { send: captures.writeToolCallRunning }, { request: captures.writePermissionRequest }, { send: captures.writeToolCallDone }]) =>
    completingScenario({ prompt: { steps, result: captures.completeResult } });

  it("answers a permission request with allow_once when nothing forbids it, never allow_always", async () => {
    const { call } = await attempt(edit());

    expect(call.agentRequests).toHaveLength(1);
    expect(call.agentRequests[0]!.response).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "once" } } });
  });

  it("rejects a write for a read-only step, and a write outside the write scope, and allows one inside it", async () => {
    const readOnly = await attempt(edit(), { capabilities: [{ kind: "read_only", require: "cooperative" }] });
    const outside = await attempt(edit(), { capabilities: [{ kind: "write_scope", paths: ["src"], require: "cooperative" }] });
    const inside = await attempt(edit(), { capabilities: [{ kind: "write_scope", paths: ["out.txt"], require: "cooperative" }] });

    expect(readOnly.call.agentRequests[0]!.response).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(outside.call.agentRequests[0]!.response).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(inside.call.agentRequests[0]!.response).toMatchObject({ result: { outcome: { optionId: "once" } } });
  });

  it("rejects a shell command that pushes or opens a pull request", async () => {
    const steps: PromptStep[] = [{ send: captures.bashToolCallRunning }, { request: captures.bashPermissionRequest }, { send: captures.bashToolCallFailed }];
    const { call } = await attempt(edit(steps));

    expect(call.agentRequests[0]!.response).toMatchObject({ result: { outcome: { optionId: "reject" } } });
  });

  it("answers the agent's file-system request with `method not found`: AHP offers none, and the tool wrote the file itself", async () => {
    const steps: PromptStep[] = [{ request: captures.writePermissionRequest }, { request: captures.writeFileRequest }];
    const { call, exit } = await attempt(edit(steps));

    expect(call.agentRequests[1]!.response).toMatchObject({ error: { code: -32601 } });
    expect(exit.error).toBeNull();
  });

  it("leaves an empty log when no tool call was made, so a lost attempt shows the agent had made none", async () => {
    const { log, toolCallLog } = await attempt(completingScenario());

    expect(log()).toEqual([]);
    expect(existsSync(toolCallLog)).toBe(true);
  });

  it("logs each tool call, once per change of status, and each permission answer, with no input or output", async () => {
    const { log } = await attempt(edit(), { capabilities: [{ kind: "read_only", require: "cooperative" }] });
    const entries = log();

    expect(entries.map((entry) => [entry.toolCallId, entry.status, entry.permission])).toEqual([
      ["call_write", "pending", null],
      ["call_write", "in_progress", null],
      ["call_write", "permission_requested", "rejected"],
      ["call_write", "completed", null],
    ]);
    expect(entries[1]).toMatchObject({ kind: "edit", title: "write", paths: ["out.txt"] });
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["kind", "paths", "permission", "status", "time", "title", "toolCallId"]);
    expect(JSON.stringify(entries)).not.toContain("hello.");
  });
});

describe("the OpenCode adapter's failures", () => {
  it("fails the attempt as config_auth, and never prompts, when OpenCode does not list the requested model", async () => {
    const { call, exit } = await attempt(completingScenario({ setModel: { error: captures.modelNotFound } }), { requestedModel: "nonexistent/model" });

    expect(exit.error).toEqual({ kind: "config_auth", message: expect.stringContaining('would not select the model "nonexistent/model"') });
    expect(method(call, "session/prompt")).toEqual([]);
    expect(exit.stopReason).toBeNull();
    expect(call.stdinEnded).toBe(true);
  });

  it("classifies a rejected API key as config_auth, though the process exits 0, and leaves no key in the message", async () => {
    const { exit } = await attempt(completingScenario({ prompt: { steps: [], error: captures.badKey } }));

    expect(exit.exitCode).toBe(0);
    expect(exit.error?.kind).toBe("config_auth");
    expect(exit.error?.message).toContain("Incorrect API key provided");
    expect(exit.error?.message).not.toMatch(/sk-proj/);
    expect(exit.reportedOutput).toEqual({});
  });

  it("is an agent error when OpenCode exits in the middle of the turn, and when it ends the turn without a result", async () => {
    const died = await attempt(completingScenario({ prompt: { steps: [{ send: captures.thought }, { exit: 3 }] } }));
    const crashed = await attempt(completingScenario({ crashAtStart: 2 }));

    expect(died.exit.exitCode).toBe(3);
    expect(died.exit.error).toEqual({ kind: "agent_error", message: expect.stringContaining("ended without finishing the turn") });
    expect(crashed.exit.exitCode).toBe(2);
    expect(crashed.exit.error?.kind).toBe("agent_error");
  });

  it("does not hang on an OpenCode that ignores the end of stdin: it is stopped, tree and all", async () => {
    const result = await start(completingScenario({ ignoreStdinEnd: true }));
    const exit = await result.started.exited;

    expect(exit.stopReason).toBe("end_turn");
    expect(isRunning(result.started.pid)).toBe(false);
  }, 30_000);

  it("fails to start when opencode is not on PATH", async () => {
    const before = process.env.PATH;
    process.env.PATH = "";
    restores.push(() => (process.env.PATH = before));

    await expect(openCodeAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace: tmpdir(), requestedModel: null, capabilities: appliedFor(), handoff: handoffOf(appliedFor()), options: {} })).rejects.toThrow();
  });
});

describe("cancelling an OpenCode attempt", () => {
  const hanging = (overrides: Partial<FakeOpencodeScenario> = {}, steps: PromptStep[] = []): FakeOpencodeScenario =>
    completingScenario({ prompt: { steps: [{ send: captures.thought }, ...steps, { hangUntilCancel: true }], result: captures.completeResult, cancelledResult: captures.cancelledResult }, ...overrides });

  it("sends session/cancel, waits for the turn to end, then ends stdin, so the tool exits by itself and nothing is forced", async () => {
    const { started, fake } = await start(hanging());
    await until(() => (fake.calls()[0]?.received.some((message) => message.method === "session/prompt") ? true : undefined), "the prompt");

    const termination = await started.cancel({ graceMs: 5_000 });
    const exit = await started.exited;

    expect(termination).toEqual({ outcome: "stopped", forced: false, via: "transport" });
    const call = fake.acp();
    expect(method(call, "session/cancel")[0]).toMatchObject({ params: { sessionId: "ses_fixture" } });
    expect(call.stdinEnded).toBe(true);
    // The cancelled turn is not a result: no stop reason, no error, and its zero usage is not recorded.
    expect(exit).toMatchObject({ exitCode: 0, stopReason: null, error: null, usage: null, reportedOutput: {} });
    expect(isRunning(started.pid)).toBe(false);
    // The model is not looked up for a cancelled attempt: that is a process outside the tree the cancel stopped.
    expect(fake.calls().filter((run) => run.argv[0] === "export")).toEqual([]);
  });

  it("kills the tree when the tool ignores the cancel and a process of its tree outlives it", async () => {
    const pidFile = join(realpathSync.native(createTempRepo({ "README.md": "x\n" })), "pids");
    const { started, fake } = await start(hanging({ ignoreCancel: true, ignoreStdinEnd: true }, [{ spawnStubborn: pidFile }]));
    await until(() => (existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n") ? true : undefined), "the stubborn child");
    const child = Number(readFileSync(pidFile, "utf8").trim());

    const termination = await started.cancel({ graceMs: 500 });
    await started.exited.catch(() => undefined);

    expect(termination).toEqual({ outcome: "stopped", forced: true, via: "tree_kill" });
    expect(isRunning(child)).toBe(false);
    expect(isRunning(started.pid)).toBe(false);
    expect(fake.acp().stdinEnded).toBe(true);
  }, 30_000);

  it("is the tool's own stop when its cancel takes the shell child with it", async () => {
    const pidFile = join(realpathSync.native(createTempRepo({ "README.md": "x\n" })), "pids");
    const { started } = await start(hanging({ killChildOnCancel: true }, [{ spawnStubborn: pidFile }]));
    await until(() => (existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n") ? true : undefined), "the child");
    const child = Number(readFileSync(pidFile, "utf8").trim());

    const termination = await started.cancel({ graceMs: 5_000 });

    expect(termination).toEqual({ outcome: "stopped", forced: false, via: "transport" });
    expect(isRunning(child)).toBe(false);
  }, 30_000);

  it("stops an attempt cancelled before it has a session: no prompt is sent", async () => {
    const { started, fake } = await start(hanging({ ignoreStdinEnd: false }));
    const termination = await started.cancel({ graceMs: 5_000 });
    await started.exited;

    expect(["already_gone", "stopped"]).toContain(termination.outcome);
    // Whatever was in flight, no second prompt followed.
    expect(method(fake.acp(), "session/prompt").length).toBeLessThanOrEqual(1);
  });
});

describe("what the OpenCode adapter declares", () => {
  it("declares ACP, a graceful cancel and enumerable models, and nothing stronger than cooperative on any system", () => {
    const { declaration } = openCodeAdapter;

    expect(declaration).toMatchObject({ name: "opencode", transport: "acp", gracefulCancel: true, modelReporting: "enumerable", login: "tool_login", mock: false });
    for (const levels of Object.values(declaration.capabilities)) expect(Object.values(levels)).toEqual(["cooperative", "cooperative", "cooperative"]);
    for (const levels of Object.values(declaration.network)) expect(Object.values(levels)).toEqual(["none", "none", "none"]);
    expect(adapters.get("opencode")).toBe(openCodeAdapter);
  });

  it("throws rather than apply a capability above its declaration", async () => {
    const claimed: AppliedCapabilities = { ...appliedFor([{ kind: "read_only", require: "cooperative" }]) };
    claimed.capabilities = claimed.capabilities.map((capability) => ({ ...capability, level: "enforced_by_tool" as const }));
    installAndRestore();

    await expect(openCodeAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace: tmpdir(), requestedModel: null, capabilities: claimed, handoff: handoffOf(claimed), options: {} })).rejects.toThrow(/cannot apply it at "enforced_by_tool"/);
  });

  it("accepts only its own options", () => {
    expect(openCodeAdapter.validateOptions({})).toEqual([]);
    expect(openCodeAdapter.validateOptions({ reportFields: ["summary"], extraInstructions: "x" })).toEqual([]);
    expect(openCodeAdapter.validateOptions({ sandbox: "none", reportFields: ["nope!"] })).toHaveLength(2);
  });
});

function installAndRestore() {
  const fake = installFakeOpencode(completingScenario());
  restores.push(fake.restore);
}

describe("the permission policy", () => {
  const workspace = join(tmpdir(), "ahp-policy-ws");
  const policy = (capabilities: CapabilityRequest[]) => policyOf(appliedFor(capabilities), workspace);
  const write = (path: string) => ({ kind: "edit", title: "write", paths: [join(workspace, path)], command: null });

  it("rejects any path outside the workspace and any write into .git, whatever the step asks", () => {
    expect(decide(policy([]), { kind: "read", title: null, paths: [join(tmpdir(), "elsewhere", "secret")], command: null })).toMatchObject({ allow: false });
    expect(decide(policy([]), write(".git/config"))).toMatchObject({ allow: false });
    expect(decide(policy([]), write("src/a.ts"))).toEqual({ allow: true });
  });

  it("keeps a write scope to its paths, by whole path segments", () => {
    const scoped = policy([{ kind: "write_scope", paths: ["src/", "docs/api.md"], require: "cooperative" }]);

    expect(decide(scoped, write("src/a/b.ts"))).toEqual({ allow: true });
    expect(decide(scoped, write("docs/api.md"))).toEqual({ allow: true });
    expect(decide(scoped, write("srcs/a.ts"))).toMatchObject({ allow: false });
    expect(decide(scoped, write("docs/other.md"))).toMatchObject({ allow: false });
  });

  it("reads external actions from the start of a shell command", () => {
    expect(["git push origin main", "  git   push", "gh pr create", "git update-ref -d refs/x", "gh"].map(isExternalAction)).toEqual([true, true, true, true, true]);
    expect(["git status", "ghostwriter", "echo git push", "git pushd"].map(isExternalAction)).toEqual([false, false, false, false]);
  });

  it("hands every write to AHP unless the step is read-only, which OpenCode denies itself", () => {
    expect(JSON.parse(configContentOf(policy([])))).toEqual({ permission: { edit: "ask", bash: { "git push*": "deny", "git update-ref*": "deny", "gh *": "deny" } } });
    expect(JSON.parse(configContentOf(policy([{ kind: "write_scope", paths: ["src"], require: "cooperative" }]))).permission.edit).toBe("ask");
    expect(JSON.parse(configContentOf(policy([{ kind: "read_only", require: "cooperative" }]))).permission.edit).toBe("deny");
  });
});

describe("error classes and redaction", () => {
  it("classifies by what the tool said", () => {
    expect(classify("Invalid params: model not found: x/y", -32602)).toBe("config_auth");
    expect(classify("Incorrect API key provided")).toBe("config_auth");
    expect(classify("Rate limit reached for requests")).toBe("transient");
    expect(classify("503 Service Unavailable")).toBe("transient");
    expect(classify("402 Insufficient account funds")).toBe("agent_error");
    expect(classify("something else broke")).toBe("agent_error");
  });

  it("redacts API keys and bearer tokens, masked or not, and cuts a long message", () => {
    expect(redacted("bad key sk-proj-abc123***XYZ9. See docs")).toBe("bad key sk-[redacted]. See docs");
    expect(redacted("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(redacted("x".repeat(900))).toHaveLength(501);
  });
});
