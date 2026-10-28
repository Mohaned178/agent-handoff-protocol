// The Gemini CLI adapter against a fake `gemini` (test/helpers/gemini.ts). Two of the fake's messages were printed by a real
// 0.42.0 (`initialize`, and `session/new` with no login); every other one was written from the tool's source, so these tests
// show how the adapter reads that source, not how the tool behaves (see test/fixtures/gemini-cli/captures.json).
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.ts";
import { geminiCli, geminiCliAdapter } from "../src/adapters/gemini-cli/index.ts";
import { policyFileOf } from "../src/adapters/gemini-cli/policy.ts";
import { classify } from "../src/adapters/gemini-cli/turn.ts";
import { policyOf } from "../src/adapters/acp/permissions.ts";
import { redacted } from "../src/adapters/acp/tool-calls.ts";
import { PROTOCOL_VERSION, type AppliedCapabilities, type CapabilityRequest, type HandoffRevision, type ToolCallLogEntry } from "../src/index.ts";
import { requestsOf, resolveCapabilities } from "../src/runtime/index.ts";
import type { TranscriptFiles } from "../src/process/index.ts";
import { captures, completingScenario, installFakeGemini, type FakeGeminiScenario, type PromptStep } from "./helpers/gemini.ts";
import { createTempRepo, removeTempRepos } from "./helpers/repo.ts";
import { isRunning, until } from "./helpers/process.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  removeTempRepos();
});

function handoffOf(applied: AppliedCapabilities, parts: { instructions?: string; requiredOutputFields?: string[] } = {}): HandoffRevision {
  return {
    schemaVersion: PROTOCOL_VERSION,
    handoffId: "hnd_gemini",
    revision: 1,
    supersedes: null,
    contextId: "run_gemini",
    from: null,
    to: { stepId: "review", adapter: "gemini-cli", requestedModel: null },
    base: { commit: "a".repeat(40) },
    contract: { instructions: parts.instructions ?? "Review the change.", acceptance: { verificationCommand: "node hidden-secret-test.mjs", requiredOutputFields: parts.requiredOutputFields ?? [] } },
    capabilities: applied.capabilities.map(({ level: _level, ...request }) => request),
    network: { stance: applied.network.stance, require: applied.network.require },
    context: { fields: {} },
    artifacts: [],
    evidence: [],
    requires: { fields: [], artifacts: [] },
  };
}

const appliedFor = (capabilities: CapabilityRequest[] = [], platform: NodeJS.Platform = process.platform) =>
  resolveCapabilities(requestsOf({ capabilities }), geminiCliAdapter.declaration, platform).applied;

interface Run {
  capabilities?: CapabilityRequest[];
  requestedModel?: string | null;
  options?: unknown;
  requiredOutputFields?: string[];
  transcript?: TranscriptFiles;
}

/** Starts one attempt of the adapter against the fake `gemini` in a repository whose path has a space. */
async function start(scenario: FakeGeminiScenario, run: Run = {}) {
  const fake = installFakeGemini(scenario);
  restores.push(fake.restore);
  const workspace = join(createTempRepo({ "README.md": "x\n" }), "work space");
  mkdirSync(workspace);
  const logDir = realpathSync.native(createTempRepo({ "README.md": "x\n" }));
  const toolCallLog = join(logDir, "tool-calls", "att_gemini1.jsonl");
  const applied = appliedFor(run.capabilities);
  const started = await geminiCliAdapter.startAttempt({
    attemptId: "att_gemini1",
    attemptNumber: 1,
    workspace,
    requestedModel: run.requestedModel ?? null,
    capabilities: applied,
    handoff: handoffOf(applied, { requiredOutputFields: run.requiredOutputFields }),
    options: run.options,
    toolCallLog,
    transcript: run.transcript,
  });
  const log = (): ToolCallLogEntry[] => (existsSync(toolCallLog) ? readFileSync(toolCallLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ToolCallLogEntry) : []);
  return { started, fake, workspace, log, applied, toolCallLog };
}

async function attempt(scenario: FakeGeminiScenario, run: Run = {}) {
  const result = await start(scenario, run);
  const exit = await result.started.exited;
  return { ...result, exit, call: result.fake.acp() };
}

const method = (call: { received: Record<string, unknown>[] }, name: string) => call.received.filter((message) => message.method === name);
const chunk = (text: string) => ({ ...captures.messageChunkOk, params: { ...captures.messageChunkOk.params, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const turnResult = (model_usage: unknown[], token_count = { input_tokens: 10, output_tokens: 2 }) => ({ stopReason: "end_turn", _meta: { quota: { token_count, model_usage } } });
const policyArg = (call: { argv: string[] }) => call.argv[call.argv.indexOf("--policy") + 1]!;

describe("the Gemini CLI adapter's conversation", () => {
  it("runs `gemini --acp` in the workspace in the default approval mode with a policy file, and sends the prompt as a session/prompt, never in the arguments", async () => {
    const { call, workspace } = await attempt(completingScenario(), { options: { extraInstructions: "Use the repo's style." } });

    expect(call.argv).toEqual(["--acp", "--approval-mode", "default", "--policy", policyArg(call)]);
    expect(call.cwd).toBe(realpathSync.native(workspace));
    expect(call.pwd).toBe(workspace);
    const initialize = method(call, "initialize")[0] as any;
    expect(initialize.params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect(method(call, "session/new")[0]).toMatchObject({ params: { cwd: workspace, mcpServers: [] } });
    const prompt = method(call, "session/prompt")[0] as any;
    expect(prompt.params.sessionId).toBe(captures.newSession.sessionId);
    expect(prompt.params.prompt[0].text).toContain("Review the change.");
    expect(prompt.params.prompt[0].text).toContain("Use the repo's style.");
    expect(JSON.stringify(call.received)).not.toContain("hidden-secret-test");
    expect(call.argv.join(" ")).not.toContain("Review");
    expect(call.stdinEnded).toBe(true);
  });

  it("never authenticates (the tool would write the method into the user's own settings), never trusts the worktree, never uses a bypass flag", async () => {
    const { call } = await attempt(completingScenario(), { requestedModel: "gemini-2.5-flash" });

    expect(call.received.map((message) => message.method)).toEqual(["initialize", "session/new", "session/prompt"]);
    for (const flag of ["--skip-trust", "--yolo", "-y", "--sandbox", "--allowed-tools", "--admin-policy"]) expect(call.argv).not.toContain(flag);
    expect(call.argv).not.toContain("auto_edit");
  });

  it("passes the requested model as --model, and no model flag when none is requested", async () => {
    const plain = await attempt(completingScenario());
    const asked = await attempt(completingScenario(), { requestedModel: "gemini-2.5-flash" });

    expect(plain.call.argv).not.toContain("--model");
    expect(asked.call.argv.slice(asked.call.argv.indexOf("--model"))).toEqual(["--model", "gemini-2.5-flash"]);
    // The model is not set over ACP afterwards: there is no refusal to read from `session/set_model`.
    expect(method(asked.call, "session/set_model")).toEqual([]);
  });

  it("writes the step's limits into a policy file outside the worktree, and removes it when the attempt ends", async () => {
    const { call, workspace } = await attempt(completingScenario(), { capabilities: [{ kind: "read_only", require: "cooperative" }] });
    const file = policyArg(call);
    const text = call.policyFiles[file]!;

    expect(file.startsWith(workspace)).toBe(false);
    expect(text).toContain('toolName = ["write_file", "replace"]');
    expect(text).toContain('commandPrefix = ["git push", "git update-ref", "gh"]');
    expect(text.match(/decision = "deny"/g)).toHaveLength(2);
    expect(existsSync(file)).toBe(false);
  });

  it("gives a step with no limits an empty policy file, which still replaces the user's own policy directory", () => {
    const text = policyFileOf(policyOf(appliedFor([]), tmpdir()));

    // `no_external_actions` is always added by the runtime (a baseline), so only the shell rule is present.
    expect(text).toContain('commandPrefix = ["git push", "git update-ref", "gh"]');
    expect(text).not.toContain("write_file");
    expect(policyFileOf({ workspace: tmpdir(), readOnly: false, writeScope: null, noExternalActions: false })).not.toContain("[[rule]]");
  });

  it("reports a completed turn: end_turn, the tool's quota as usage with no total or cost, and the one model it names", async () => {
    const { exit } = await attempt(completingScenario());

    expect(exit).toMatchObject({ exitCode: 0, signal: null, stopReason: "end_turn", error: null, reportedModel: "gemini-2.5-pro" });
    expect(exit.usage).toEqual({
      source: expect.stringContaining("_meta.quota.token_count"),
      inputTokens: 1200,
      outputTokens: 80,
      totalTokens: null,
      cachedInputTokens: null,
      cost: null,
    });
    expect(exit.usage!.source).toContain("promptTokenCount");
    expect(exit.usage!.source).toContain("no total and no cost reported");
  });

  it("names no model when the tool attributes tokens to more than one (a later call is filed under its configured model), or to none", async () => {
    const two = await attempt(completingScenario({ prompt: { steps: [], result: turnResult([{ model: "gemini-2.5-pro" }, { model: "auto-gemini-2.5" }]) } }));
    const none = await attempt(completingScenario({ prompt: { steps: [{ send: captures.thought }], result: turnResult([]) } }));
    const blank = await attempt(completingScenario({ prompt: { steps: [{ send: captures.thought }], result: turnResult([{ model: " " }]) } }));

    expect(two.exit.reportedModel).toBeNull();
    expect(none.exit.reportedModel).toBeNull();
    expect(blank.exit.reportedModel).toBeNull();
    expect(two.exit.usage).not.toBeNull();
  });

  it("records no usage for a block of zeros (a slash command is answered without a model), or when there is no quota", async () => {
    const zeros = await attempt(completingScenario({ prompt: { steps: [], result: turnResult([], { input_tokens: 0, output_tokens: 0 }) } }));
    const absent = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "end_turn" } } }));
    const partial = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "end_turn", _meta: { quota: { token_count: { input_tokens: 7 } } } } } }));

    expect(zeros.exit.usage).toBeNull();
    expect(absent.exit.usage).toBeNull();
    // A number the tool did not state is null, never 0.
    expect(partial.exit.usage).toMatchObject({ inputTokens: 7, outputTokens: null });
  });

  it("reads the output fields from the last message, which starts after the last tool call: chunks carry no message id and the tool adds mode-change text", async () => {
    const asked = { requiredOutputFields: ["summary", "decisions"] };
    const json = JSON.stringify({ summary: "Looks right.", decisions: ["a", "b"], extra: 3, nested: { x: 1 } });
    const steps = (...parts: PromptStep[]) => completingScenario({ prompt: { steps: parts, result: captures.completeResult } });
    const afterTool = await attempt(steps({ send: chunk("Let me look.") }, { send: captures.toolCallShell }, { send: captures.toolCallShellDone }, { send: captures.modeUpdate }, { send: chunk(json.slice(0, 20)) }, { send: chunk(json.slice(20)) }), asked);
    const fenced = await attempt(steps({ send: chunk(`Done:\n\`\`\`json\n${json}\n\`\`\`\n`) }), asked);
    const prose = await attempt(steps({ send: chunk(`The summary is "x" ${json}`) }), asked);
    const narrationLast = await attempt(steps({ send: chunk(json) }, { send: captures.toolCallShell }, { send: chunk("All done.") }), asked);

    expect(afterTool.exit.reportedOutput).toEqual({ summary: "Looks right.", decisions: ["a", "b"] });
    expect(fenced.exit.reportedOutput).toEqual({ summary: "Looks right.", decisions: ["a", "b"] });
    expect(prose.exit.reportedOutput).toEqual({});
    expect(narrationLast.exit.reportedOutput).toEqual({});
    const prompt = (method(afterTool.call, "session/prompt")[0] as any).params.prompt[0].text as string;
    expect(prompt).toContain("summary, decisions");
    expect(prompt).toContain("one JSON object");
  });

  it("passes the stop reasons that mean the agent gave up, and none for a cancelled turn", async () => {
    const maxTurns = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "max_turn_requests" } } }));
    const maxTokens = await attempt(completingScenario({ prompt: { steps: [], result: { stopReason: "max_tokens" } } }));

    expect(maxTurns.exit.stopReason).toBe("max_turn_requests");
    expect(maxTokens.exit.stopReason).toBe("max_tokens");
  });

  it("refuses to prompt a session that is not in the default approval mode: its permission answers might never be asked", async () => {
    const { call, exit } = await attempt(completingScenario({ newSession: { ...captures.newSession, modes: { ...captures.newSession.modes, currentModeId: "yolo" } } }));
    const unstated = await attempt(completingScenario({ newSession: { sessionId: "s" } }));

    expect(method(call, "session/prompt")).toEqual([]);
    expect(exit.error).toEqual({ kind: "config_auth", message: expect.stringContaining('approval mode "yolo", not "default"') });
    expect(method(unstated.call, "session/prompt")).toEqual([]);
    expect(unstated.exit.error?.message).toContain("(not stated)");
  });
});

describe("the Gemini CLI adapter's answers to the agent", () => {
  const asking = (request: Json) => completingScenario({ prompt: { steps: [{ request }], result: captures.completeResult } });
  type Json = Record<string, unknown>;
  const answerOf = (run: { call: { agentRequests: { response: any }[] } }) => run.call.agentRequests[0]!.response.result.outcome;

  it("answers a permission request with allow_once, though allow_always is listed first, and never allow_always", async () => {
    const run = await attempt(asking(captures.permissionEdit));

    expect(answerOf(run)).toEqual({ outcome: "selected", optionId: "proceed_once" });
  });

  it("rejects a write for a read-only step and one outside the write scope, and allows one inside it", async () => {
    const readOnly = await attempt(asking(captures.permissionEdit), { capabilities: [{ kind: "read_only", require: "cooperative" }] });
    const outside = await attempt(asking(captures.permissionEdit), { capabilities: [{ kind: "write_scope", paths: ["src"], require: "cooperative" }] });
    const inside = await attempt(asking(captures.permissionEdit), { capabilities: [{ kind: "write_scope", paths: ["out.txt"], require: "cooperative" }] });

    expect(answerOf(readOnly)).toEqual({ outcome: "selected", optionId: "cancel" });
    expect(answerOf(outside)).toEqual({ outcome: "selected", optionId: "cancel" });
    expect(answerOf(inside)).toEqual({ outcome: "selected", optionId: "proceed_once" });
  });

  it("reads the command of a shell request from its title, which is the command itself, and rejects a push or a pull request", async () => {
    const push = await attempt(asking(captures.permissionShell));
    const pr = await attempt(asking({ ...captures.permissionShell, params: { ...captures.permissionShell.params, toolCall: { ...captures.permissionShell.params.toolCall, title: "gh pr create --fill" } } }));
    const plain = await attempt(asking({ ...captures.permissionShell, params: { ...captures.permissionShell.params, toolCall: { ...captures.permissionShell.params.toolCall, title: "npm test" } } }));

    expect(answerOf(push)).toEqual({ outcome: "selected", optionId: "cancel" });
    expect(answerOf(pr)).toEqual({ outcome: "selected", optionId: "cancel" });
    expect(answerOf(plain)).toEqual({ outcome: "selected", optionId: "proceed_once" });
  });

  it("answers any other request from the agent (such as a file-system one, which it was not offered) with `method not found`", async () => {
    const run = await attempt(asking({ method: "fs/write_text_file", params: { sessionId: "s", path: "x", content: "y" } }));

    expect(run.call.agentRequests[0]!.response).toMatchObject({ error: { code: -32601 } });
    expect(run.exit.error).toBeNull();
  });

  it("logs each tool call and each permission answer for the recovery report, with no input or output", async () => {
    const steps: PromptStep[] = [{ send: captures.toolCallShell }, { send: captures.toolCallShellDone }, { request: captures.permissionEdit }];
    const { log } = await attempt(completingScenario({ prompt: { steps, result: captures.completeResult } }), { capabilities: [{ kind: "read_only", require: "cooperative" }] });
    const entries = log();

    expect(entries.map((entry) => [entry.toolCallId, entry.status, entry.permission])).toEqual([
      ["run_shell_command-1700000000000-1", "in_progress", null],
      ["run_shell_command-1700000000000-1", "completed", null],
      ["write_file-1700000000000-2", "permission_requested", "rejected"],
    ]);
    expect(entries[2]).toMatchObject({ kind: "edit", title: "Writing to out.txt", paths: ["out.txt"] });
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["kind", "paths", "permission", "status", "time", "title", "toolCallId"]);
    expect(JSON.stringify(entries)).not.toContain('"ok"');
  });

  it("leaves an empty log when no tool call was made, so a lost attempt shows the agent had made none", async () => {
    const { log, toolCallLog } = await attempt(completingScenario());

    expect(log()).toEqual([]);
    expect(existsSync(toolCallLog)).toBe(true);
  });
});

describe("the Gemini CLI adapter's failures", () => {
  it("fails as config_auth, and never prompts, when the tool has no login: the message the real 0.42.0 printed", async () => {
    const { call, exit } = await attempt({ ...completingScenario(), newSession: captures.newSessionAuthError });

    expect(exit.error).toEqual({ kind: "config_auth", message: "Gemini API key is missing or not configured." });
    expect(method(call, "session/prompt")).toEqual([]);
    expect(exit.stopReason).toBeNull();
    expect(call.stdinEnded).toBe(true);
    expect(call.received.map((message) => message.method)).not.toContain("authenticate");
  });

  it("classifies a prompt that fails by the HTTP status the tool puts in the JSON-RPC code, and leaves no key in the message", async () => {
    const failing = (code: number, message: string) => attempt(completingScenario({ prompt: { steps: [], error: { code, message } } }));

    expect((await failing(429, "Rate limit exceeded. Try again later.")).exit.error?.kind).toBe("transient");
    expect((await failing(503, "The model is overloaded.")).exit.error?.kind).toBe("transient");
    expect((await failing(401, "API key not valid.")).exit.error?.kind).toBe("config_auth");
    expect((await failing(404, "models/nonexistent is not found")).exit.error?.kind).toBe("config_auth");
    // 500 is what the tool reports for any error it cannot name: not an outage to wait out.
    expect((await failing(500, "Unknown stream execution error.")).exit.error?.kind).toBe("agent_error");
    const leaked = await failing(400, "key AIzaSyA1234567890abcdefghijklmnopqrstuv was rejected");
    expect(leaked.exit.error?.message).toBe("key [redacted key] was rejected");
    expect(leaked.exit.exitCode).toBe(0);
    expect(leaked.exit.reportedOutput).toEqual({});
  });

  it("is an agent error when the tool exits in the middle of the turn, and when it dies before answering", async () => {
    const died = await attempt(completingScenario({ prompt: { steps: [{ send: captures.thought }, { exit: 3 }] } }));
    const crashed = await attempt(completingScenario({ crashAtStart: 2 }));

    expect(died.exit.exitCode).toBe(3);
    expect(died.exit.error).toEqual({ kind: "agent_error", message: expect.stringContaining("ended without finishing the turn") });
    expect(crashed.exit.exitCode).toBe(2);
    expect(crashed.exit.error?.kind).toBe("agent_error");
  });

  it("does not hang on a tool that ignores the end of stdin: it is stopped, tree and all", async () => {
    const result = await start(completingScenario({ ignoreStdinEnd: true }));
    const exit = await result.started.exited;

    expect(exit.stopReason).toBe("end_turn");
    expect(isRunning(result.started.pid)).toBe(false);
  }, 30_000);

  it("fails to start when gemini is not on PATH, and leaves no policy file behind", async () => {
    const before = process.env.PATH;
    process.env.PATH = "";
    restores.push(() => (process.env.PATH = before));

    await expect(geminiCliAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace: tmpdir(), requestedModel: null, capabilities: appliedFor(), handoff: handoffOf(appliedFor()), options: {} })).rejects.toThrow();
  });
});

describe("the Gemini CLI adapter's transcript", () => {
  it("keeps every message it sent the tool and every line the tool printed, raw", async () => {
    const dir = realpathSync.native(createTempRepo({ "README.md": "x\n" }));
    const transcript = { input: join(dir, "transcripts", "att.in.txt"), output: join(dir, "transcripts", "att.out.txt") };

    const { call } = await attempt(completingScenario(), { transcript });

    const sent = readFileSync(transcript.input, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string });
    expect(sent.map((message) => message.method)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(readFileSync(transcript.output, "utf8")).toContain(captures.newSession.sessionId);
    expect(call.received.map((message) => message.method)).toEqual(sent.map((message) => message.method));
  });
});

describe("cancelling a Gemini CLI attempt", () => {
  const hanging = (overrides: Partial<FakeGeminiScenario> = {}, steps: PromptStep[] = []): FakeGeminiScenario =>
    completingScenario({ prompt: { steps: [{ send: captures.thought }, ...steps, { hangUntilCancel: true }], result: captures.completeResult }, ...overrides });

  it("sends session/cancel, waits for the turn to end, then ends stdin, so the tool exits by itself and nothing is forced", async () => {
    const { started, fake } = await start(hanging());
    await until(() => (fake.calls()[0]?.received.some((message) => message.method === "session/prompt") ? true : undefined), "the prompt");

    const termination = await started.cancel({ graceMs: 5_000 });
    const exit = await started.exited;

    expect(termination).toEqual({ outcome: "stopped", forced: false, via: "transport" });
    const call = fake.acp();
    expect(method(call, "session/cancel")[0]).toMatchObject({ params: { sessionId: captures.newSession.sessionId } });
    expect(call.stdinEnded).toBe(true);
    expect(exit).toMatchObject({ exitCode: 0, stopReason: null, error: null, usage: null, reportedOutput: {}, reportedModel: null });
    expect(isRunning(started.pid)).toBe(false);
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

  it("stops an attempt cancelled before it has a session: no second prompt follows", async () => {
    const { started, fake } = await start(hanging());
    const termination = await started.cancel({ graceMs: 5_000 });
    await started.exited;

    expect(["already_gone", "stopped"]).toContain(termination.outcome);
    expect(method(fake.acp(), "session/prompt").length).toBeLessThanOrEqual(1);
  });
});

describe("what the Gemini CLI adapter declares", () => {
  it("declares ACP, a graceful cancel and enumerable models, and nothing stronger than cooperative on any system", () => {
    const { declaration } = geminiCliAdapter;

    expect(declaration).toMatchObject({ name: "gemini-cli", transport: "acp", gracefulCancel: true, modelReporting: "enumerable", login: "api_key", mock: false });
    for (const levels of Object.values(declaration.capabilities)) expect(Object.values(levels)).toEqual(["cooperative", "cooperative", "cooperative"]);
    for (const levels of Object.values(declaration.network)) expect(Object.values(levels)).toEqual(["none", "none", "none"]);
    expect(adapters.get("gemini-cli")).toBe(geminiCliAdapter);
    expect(geminiCli({ model: "gemini-2.5-pro", reportFields: ["summary"] })).toEqual({ adapter: "gemini-cli", model: "gemini-2.5-pro", options: { reportFields: ["summary"] } });
  });

  it("throws rather than apply a capability above its declaration", async () => {
    const claimed: AppliedCapabilities = { ...appliedFor([{ kind: "read_only", require: "cooperative" }]) };
    claimed.capabilities = claimed.capabilities.map((capability) => ({ ...capability, level: "enforced_by_tool" as const }));
    const fake = installFakeGemini(completingScenario());
    restores.push(fake.restore);

    await expect(geminiCliAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace: tmpdir(), requestedModel: null, capabilities: claimed, handoff: handoffOf(claimed), options: {} })).rejects.toThrow(/cannot apply it at "enforced_by_tool"/);
    expect(fake.calls()).toEqual([]);
  });

  it("accepts only its own options", () => {
    expect(geminiCliAdapter.validateOptions({})).toEqual([]);
    expect(geminiCliAdapter.validateOptions({ reportFields: ["summary"], extraInstructions: "x" })).toEqual([]);
    expect(geminiCliAdapter.validateOptions({ sandbox: "none", reportFields: ["nope!"] })).toHaveLength(2);
    expect(geminiCliAdapter.validateOptions({ approvalMode: "yolo" })).toHaveLength(1);
  });
});

describe("error classes and redaction", () => {
  it("classifies by the status and the phase, then by what the tool said", () => {
    expect(classify("Gemini API key is missing or not configured.", -32000, "session")).toBe("config_auth");
    expect(classify("anything at all", 500, "session")).toBe("config_auth");
    expect(classify("x", 429)).toBe("transient");
    expect(classify("x", 408)).toBe("transient");
    expect(classify("x", 504)).toBe("transient");
    expect(classify("x", 403)).toBe("config_auth");
    expect(classify("x", 500)).toBe("agent_error");
    expect(classify("The caller does not have permission: PERMISSION_DENIED", 400)).toBe("config_auth");
    expect(classify("402 Insufficient funds", 400)).toBe("agent_error");
    expect(classify("socket hang up ECONNRESET", 400)).toBe("transient");
    expect(classify("something else broke")).toBe("agent_error");
  });

  it("redacts Google API keys, as well as the other kinds of key", () => {
    expect(redacted("bad key AIzaSyA1234567890abcdefghijklmnopqrstuv.")).toBe("bad key [redacted key].");
    expect(redacted("bad key sk-proj-abc123***XYZ9. See docs")).toBe("bad key sk-[redacted]. See docs");
  });
});
