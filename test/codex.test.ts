import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { TranscriptFiles } from "../src/process/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxFor } from "../src/adapters/codex/args.ts";
import { codexAdapter } from "../src/adapters/codex/index.ts";
import { codexHomeOf, sessionModel } from "../src/adapters/codex/session.ts";
import { CodexStream } from "../src/adapters/codex/stream.ts";
import { adapters } from "../src/adapters/index.ts";
import {
  PROTOCOL_VERSION,
  type AppliedCapabilities,
  type CapabilityRequest,
  type HandoffEvidence,
  type HandoffRevision,
} from "../src/index.ts";
import { executeRun, requestsOf, resolveCapabilities } from "../src/runtime/index.ts";
import { codex, defineWorkflow, readRunEvents } from "../src/index.ts";
import { fixture, installFakeCodex } from "./helpers/codex.ts";
import { createTempRepo, removeTempRepos, trackForRemoval } from "./helpers/repo.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  removeTempRepos();
});

const fake = (options: Parameters<typeof installFakeCodex>[0]) => {
  const installed = installFakeCodex(options);
  restores.push(installed.restore);
  return installed;
};

/** A Codex home of this test's own: nothing reads the real one. */
const codexHome = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-codex-home-")));
  trackForRemoval(dir);
  return dir;
};

/** What Codex's session log holds on the lines the adapter may read: only `turn_context` carries the model. */
const sessionOf = (model: string) => [
  { type: "session_meta", payload: { id: "x", base_instructions: { text: `a long text that names turn_context only in passing` } } },
  { type: "response_item", payload: { type: "message", role: "user" } },
  { type: "turn_context", payload: { turn_id: "t", model } },
  { type: "event_msg", payload: { type: "task_complete" } },
];

/** A revision-1 handoff for the Codex adapter, with the capability requests the runtime would add to the step's. */
function handoffOf(
  applied: AppliedCapabilities,
  parts: { instructions?: string; fields?: Record<string, string | string[]>; requiredOutputFields?: string[]; evidence?: HandoffEvidence[]; artifacts?: string[] } = {},
): HandoffRevision {
  return {
    schemaVersion: PROTOCOL_VERSION,
    handoffId: "hnd_codex",
    revision: parts.evidence?.length ? 2 : 1,
    supersedes: parts.evidence?.length ? 1 : null,
    contextId: "run_codex",
    from: null,
    to: { stepId: "implement", adapter: "codex", requestedModel: null },
    base: { commit: "a".repeat(40) },
    contract: { instructions: parts.instructions ?? "Add the endpoint.", acceptance: { verificationCommand: "node hidden-secret-test.mjs", requiredOutputFields: parts.requiredOutputFields ?? [] } },
    capabilities: applied.capabilities.map(({ level: _level, ...request }) => request),
    network: { stance: applied.network.stance, require: applied.network.require },
    context: { fields: parts.fields ?? {} },
    artifacts: (parts.artifacts ?? []).map((path) => ({ path, sha256: "b".repeat(64) })),
    evidence: parts.evidence ?? [],
    requires: { fields: [], artifacts: [] },
  };
}

const appliedFor = (capabilities: CapabilityRequest[] = [], platform: NodeJS.Platform = process.platform) =>
  resolveCapabilities(requestsOf({ capabilities }), codexAdapter.declaration, platform).applied;

/** Runs one attempt of the adapter against the fake `codex` in a repository whose path has a space, and waits for it to end. */
async function attempt(
  stream: string,
  parts: Parameters<typeof handoffOf>[1] = {},
  run: {
    capabilities?: CapabilityRequest[];
    requestedModel?: string | null;
    options?: unknown;
    exitCode?: number;
    tornTail?: string;
    platform?: NodeJS.Platform;
    session?: string;
    transcript?: TranscriptFiles;
  } = {},
) {
  const home = codexHome();
  const codexFake = fake({ stream, exitCode: run.exitCode, tornTail: run.tornTail, sessionLines: run.session ? sessionOf(run.session) : undefined });
  const workspace = join(createTempRepo({ "README.md": "x\n" }), "work space");
  mkdirSync(workspace);
  const applied = appliedFor(run.capabilities, run.platform);
  const started = await codexAdapter.startAttempt({
    attemptId: "att_codex1",
    attemptNumber: 1,
    workspace,
    requestedModel: run.requestedModel ?? null,
    capabilities: applied,
    handoff: handoffOf(applied, parts),
    options: { codexHome: home, ...(run.options as object | undefined) },
    transcript: run.transcript,
  });
  const exit = await started.exited;
  return { exit, call: codexFake.call(), workspace, home };
}

const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const configsOf = (argv: string[]) => argv.flatMap((arg, i) => (argv[i - 1] === "--config" ? [arg] : []));

describe("the Codex adapter's command line", () => {
  it("runs `codex exec --json` with the prompt on stdin, in the workspace, and never the SDK, app-server or a bypass", async () => {
    const { call, workspace } = await attempt(fixture("complete"), { instructions: "Add the password-reset endpoint & its test." });

    expect(call.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(call.argv.at(-1)).toBe("-");
    // The prompt is on stdin and nowhere in the arguments, so no shell or command line ever reads it.
    expect(call.stdin).toContain("Add the password-reset endpoint & its test.");
    expect(call.argv.join(" ")).not.toContain("password-reset");
    expect(call.argv).not.toContain("app-server");
    for (const flag of ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--full-auto", "--ephemeral", "--oss"]) expect(call.argv).not.toContain(flag);
    expect(call.argv).not.toContain("danger-full-access");
    expect(valueOf(call.argv, "--cd")).toBe(workspace);
    expect(call.cwd).toBe(realpathSync.native(workspace));
    expect(call.pwd).toBe(workspace);
  });

  it("keeps the prompt it sent and the stream the tool printed, raw, when the runtime gives it transcript files", async () => {
    const dir = createTempRepo({ "README.md": "x\n" });
    const transcript = { input: join(dir, "transcripts", "att.in.txt"), output: join(dir, "transcripts", "att.out.txt") };

    const { call } = await attempt(fixture("complete"), { instructions: "Add the password-reset endpoint & its test." }, { transcript });

    expect(readFileSync(transcript.input, "utf8")).toBe(call.stdin);
    expect(readFileSync(transcript.input, "utf8")).toContain("Add the password-reset endpoint & its test.");
    expect(readFileSync(transcript.output, "utf8")).toBe(fixture("complete"));
  });

  it("states the sandbox and the approval policy for every attempt, and leaves the user's config and rules out", async () => {
    const { call } = await attempt(fixture("complete"));

    expect(valueOf(call.argv, "--sandbox")).toBe("workspace-write");
    expect(configsOf(call.argv)).toContain('approval_policy="never"');
    expect(call.argv).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules"]));
    // The session log is kept: it is where the model is read from.
    expect(call.argv).not.toContain("--ephemeral");
  });

  it("names Windows' sandbox on Windows and nowhere else", async () => {
    const onWindows = await attempt(fixture("complete"), {}, { platform: "win32" });
    const onLinux = await attempt(fixture("complete"), {}, { platform: "linux" });

    expect(configsOf(onWindows.call.argv)).toContain('windows.sandbox="unelevated"');
    expect(configsOf(onLinux.call.argv).some((config) => config.startsWith("windows."))).toBe(false);
  });

  it("passes the requested model, effort and Codex home only when given", async () => {
    const plain = await attempt(fixture("complete"));
    const given = await attempt(fixture("complete"), {}, { requestedModel: "gpt-5.6-luna", options: { effort: "low" } });

    expect(plain.call.argv).not.toContain("--model");
    expect(configsOf(plain.call.argv).some((config) => config.startsWith("model_reasoning_effort"))).toBe(false);
    expect(valueOf(given.call.argv, "--model")).toBe("gpt-5.6-luna");
    expect(configsOf(given.call.argv)).toContain('model_reasoning_effort="low"');
    expect(given.call.codexHome).toBe(given.home);
  });

  it("gives the agent a JSON Schema for the fields the step requires and the options add, in a file outside the workspace that is removed afterwards", async () => {
    const { call, workspace } = await attempt(fixture("structured"), { requiredOutputFields: ["summary", "decisions"] }, { options: { reportFields: ["constraints"] } });

    expect(call.schemaPath).not.toBeNull();
    expect(call.schemaPath!.startsWith(realpathSync.native(workspace))).toBe(false);
    expect(existsSync(call.schemaPath!)).toBe(false);
    const schema = call.schema as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["summary", "decisions", "constraints"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("asks for no structured output when no field is to be reported", async () => {
    const { call } = await attempt(fixture("complete"));

    expect(call.argv).not.toContain("--output-schema");
    expect(call.stdin).not.toContain("## Report");
  });
});

describe("the sandbox is chosen from the level recorded, not from the request", () => {
  const applied = (kind: "read_only" | "write_scope" | "no_external_actions", level: "none" | "cooperative" | "enforced_by_tool"): AppliedCapabilities => {
    const base = appliedFor();
    const request: CapabilityRequest = kind === "write_scope" ? { kind, paths: ["src"], require: "none" } : { kind, require: "none" };
    return { ...base, capabilities: [{ ...request, level } as AppliedCapabilities["capabilities"][number]] };
  };

  it.each([
    ["read_only", "enforced_by_tool", "read-only"],
    ["read_only", "cooperative", "read-only"],
    // The conformance suite's control run: the request stands, the level is none, and the agent must be able to write.
    ["read_only", "none", "workspace-write"],
    ["write_scope", "cooperative", "workspace-write"],
    ["no_external_actions", "cooperative", "workspace-write"],
  ] as const)("%s recorded at %s is %s", (kind, level, sandbox) => {
    expect(sandboxFor(applied(kind, level))).toBe(sandbox);
  });

  it("is workspace-write when no capability is asked for", () => {
    expect(sandboxFor({ ...appliedFor(), capabilities: [] })).toBe("workspace-write");
  });

  it("passes `read-only` to codex for a read_only step", async () => {
    const { call } = await attempt(fixture("complete"), {}, { capabilities: [{ kind: "read_only", require: "cooperative" }] });

    expect(valueOf(call.argv, "--sandbox")).toBe("read-only");
    expect(call.stdin).toContain("Change no file in this workspace");
  });
});

describe("what the stream says about the attempt", () => {
  it("reports the output fields, the stop reason, the model Codex logged and the usage the tool printed, labelled with its source", async () => {
    const { exit } = await attempt(fixture("complete"), { requiredOutputFields: ["summary"] }, { requestedModel: "gpt-5.6-luna", session: "gpt-5.6-luna" });

    expect(exit.exitCode).toBe(0);
    expect(exit.error).toBeNull();
    expect(exit.reportedOutput).toEqual({ summary: "ok" });
    expect(exit.stopReason).toBe("end_turn");
    expect(exit.reportedModel).toBe("gpt-5.6-luna");
    // Numbers as printed; the total and a cost are not made up, and the label says what the tool's numbers include.
    expect(exit.usage).toEqual({
      source: expect.stringContaining("input_tokens includes cached_input_tokens"),
      inputTokens: 13159,
      outputTokens: 63,
      totalTokens: null,
      cachedInputTokens: 0,
      cost: null,
    });
    expect(exit.usage!.source).not.toContain("cache writes");
    expect(exit.usage!.source).toContain("46 reasoning_output_tokens were reported, not added");
  });

  it("reports a field that is a list, as the schema allows", async () => {
    const { exit } = await attempt(fixture("structured"), { requiredOutputFields: ["summary", "decisions"] });

    expect(exit.reportedOutput).toEqual({ summary: "hello", decisions: ["Proceed", "Review"] });
  });

  it("reports no model when there is no session log to read, and never the requested one", async () => {
    const { exit } = await attempt(fixture("complete"), {}, { requestedModel: "gpt-5.6-luna" });

    expect(exit.reportedModel).toBeNull();
  });

  it("reports the model Codex chose when none was requested", async () => {
    const { exit, call } = await attempt(fixture("complete"), {}, { session: "gpt-default" });

    expect(call.argv).not.toContain("--model");
    expect(exit.reportedModel).toBe("gpt-default");
  });

  it("classifies a missing login as config_auth, and reports no model that never answered, though Codex logged one", async () => {
    const { exit } = await attempt(fixture("not-logged-in"), {}, { exitCode: 1, session: "gpt-5.6-luna", requestedModel: "gpt-5.6-luna" });

    expect(exit.exitCode).toBe(1);
    expect(exit.error).toMatchObject({ kind: "config_auth", message: expect.stringContaining("401 Unauthorized") });
    expect(exit.reportedModel).toBeNull();
    expect(exit.usage).toBeNull();
    expect(exit.stopReason).toBeNull();
  });

  it("classifies a model the login cannot use as config_auth, from the error code, and reports no model", async () => {
    const { exit } = await attempt(fixture("model-not-found"), {}, { exitCode: 1, session: "gpt-5.4-mini", requestedModel: "gpt-5.4-mini" });

    expect(exit.error).toMatchObject({ kind: "config_auth", message: expect.stringContaining("model_not_found") });
    expect(exit.reportedModel).toBeNull();
  });

  it("reports an effort the model refuses as an agent error, with the tool's words", async () => {
    const { exit } = await attempt(fixture("effort-refused"), {}, { exitCode: 1 });

    expect(exit.error).toMatchObject({ kind: "agent_error", message: expect.stringContaining("'minimal' is not supported") });
  });

  it("does not take a command the sandbox declined for an error: the agent was told no and the turn went on", async () => {
    const { exit } = await attempt(fixture("declined-commands"), {}, { session: "gpt-5.6-luna" });

    expect(exit.error).toBeNull();
    expect(exit.exitCode).toBe(0);
    expect(exit.reportedModel).toBe("gpt-5.6-luna");
    expect(exit.usage).toMatchObject({ inputTokens: 87865, cachedInputTokens: 58624, outputTokens: 836 });
    // The last message is narration, not the structured fields.
    expect(exit.reportedOutput).toEqual({});
  });

  it("keeps what it read when the process was killed in the middle of a line, and reads a retry notice as no error", async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"00000000-0000-4000-8000-0000000000aa"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: x)"}',
      "",
    ].join("\n");

    const { exit } = await attempt(stream, {}, { exitCode: 1, tornTail: '{"type":"item.completed","item":{"id":"item_0","type":"agent_mess' });

    expect(exit.error).toBeNull();
    expect(exit.usage).toBeNull();
    expect(exit.reportedOutput).toEqual({});
    expect(exit.reportedModel).toBeNull();
  });

  it("stops a hanging process with the process layer, which on Windows is a forced tree kill", async () => {
    fake({ stream: fixture("complete").split("\n")[0] + "\n", hang: true });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = appliedFor();
    const started = await codexAdapter.startAttempt({
      attemptId: "att_codex2",
      attemptNumber: 1,
      workspace,
      requestedModel: null,
      capabilities: applied,
      handoff: handoffOf(applied),
      options: { codexHome: codexHome() },
    });

    const termination = await started.cancel({ graceMs: 200 });
    const exit = await started.exited;

    expect(termination).toMatchObject({ outcome: "stopped", forced: process.platform === "win32", via: process.platform === "win32" ? "tree_kill" : "signal" });
    expect(exit.reportedOutput).toEqual({});
    expect(exit.usage).toBeNull();
  });
});

describe("CodexStream", () => {
  const feed = (...chunks: string[]) => {
    const stream = new CodexStream();
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
    return stream;
  };
  const line = (event: object) => JSON.stringify(event) + "\n";
  const failed = (message: string) => feed(line({ type: "turn.started" }), line({ type: "turn.failed", error: { message } })).exit(1).error;

  it("ignores event types it does not know, lines that are not JSON, and items it does not read", () => {
    const stream = feed(
      line({ type: "something.new", data: 1 }),
      "this is not json\n",
      line({ type: "item.completed", item: { id: "i", type: "reasoning", text: "thinking" } }),
      line({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }),
    );

    expect(stream.exit(0)).toMatchObject({ error: null, stopReason: "end_turn", reportedOutput: {} });
    expect(stream.answered).toBe(true);
  });

  it("reads lines however the chunks are cut, a last line with no newline included", () => {
    const text =
      line({ type: "thread.started", thread_id: "t-1" }) +
      line({ type: "item.completed", item: { id: "i", type: "agent_message", text: '{"summary":"s"}' } }) +
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } });

    const stream = feed(text.slice(0, 20), text.slice(20, 120), text.slice(120));

    expect(stream.threadId).toBe("t-1");
    expect(stream.exit(0)).toMatchObject({ reportedOutput: { summary: "s" }, stopReason: "end_turn" });
  });

  it.each([
    ["a JSON body with status 401", JSON.stringify({ type: "error", status: 401, error: { message: "no" } }), "config_auth"],
    ["the text Codex prints for a 401", "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "config_auth"],
    ["a model_not_found code", JSON.stringify({ type: "error", status: 400, error: { code: "model_not_found", message: "no" } }), "config_auth"],
    ["a 429", JSON.stringify({ type: "error", status: 429, error: { message: "slow down" } }), "transient"],
    ["the text for a 503", "unexpected status 503 Service Unavailable: overloaded", "transient"],
    ["a 429 that is a usage limit, which waiting does not clear", JSON.stringify({ type: "error", status: 429, error: { code: "usage_limit_reached", message: "limit" } }), "config_auth"],
    ["Codex's usage limit as the plain text it prints", "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 26th, 2026 8:32 PM.", "config_auth"],
    ["a 408", JSON.stringify({ type: "error", status: 408, error: { message: "timeout" } }), "transient"],
    ["a 400 with another code", JSON.stringify({ type: "error", status: 400, error: { code: "unsupported_value", message: "no" } }), "agent_error"],
    ["a message with no status at all", "something went wrong", "agent_error"],
  ])("classifies a failed turn with %s", (_name, message, kind) => {
    expect(failed(message)).toEqual({ kind, message });
  });

  it("reports a failure only from `turn.failed`, or from the last real error of a process that exited non-zero", () => {
    const retry = line({ type: "error", message: "Reconnecting... 3/5 (unexpected status 401 Unauthorized)" });

    expect(feed(retry).exit(1).error).toBeNull();
    // A killed process has no exit code: what it printed before is not its error.
    expect(feed(line({ type: "error", message: "unexpected status 429 Too Many Requests" })).exit(null).error).toBeNull();
    expect(feed(line({ type: "error", message: "unexpected status 429 Too Many Requests" })).exit(0).error).toBeNull();
    expect(feed(retry, line({ type: "error", message: "unexpected status 429 Too Many Requests" })).exit(1).error?.kind).toBe("transient");
  });

  it("reads no output from a message that is not a JSON object, or from a turn that did not complete", () => {
    const message = (text: string, completed: boolean) =>
      feed(line({ type: "item.completed", item: { id: "i", type: "agent_message", text } }), completed ? line({ type: "turn.completed", usage: {} }) : "").exit(0).reportedOutput;

    expect(message("done, I created the file", true)).toEqual({});
    expect(message('["summary"]', true)).toEqual({});
    expect(message('{"summary":"s"}', false)).toEqual({});
  });

  it("drops output fields that are not text, and takes the last message as the report", () => {
    const stream = feed(
      line({ type: "item.completed", item: { id: "a", type: "agent_message", text: '{"summary":"first"}' } }),
      line({ type: "item.completed", item: { id: "b", type: "agent_message", text: JSON.stringify({ summary: "s", n: 3, items: ["a", 4], ok: ["a", "b"] }) } }),
      line({ type: "turn.completed", usage: {} }),
    );

    expect(stream.exit(0).reportedOutput).toEqual({ summary: "s", ok: ["a", "b"] });
  });

  it("reports no usage when the event carries no number or only zeros, and null for a number that is missing, never 0", () => {
    const usage = (block: object) => feed(line({ type: "turn.completed", usage: block })).exit(0).usage;

    expect(usage({})).toBeNull();
    expect(usage({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0 })).toBeNull();
    expect(usage({ output_tokens: 7 })).toMatchObject({ inputTokens: null, outputTokens: 7, totalTokens: null, cachedInputTokens: null, cost: null });
    expect(usage({ output_tokens: 7, cache_write_input_tokens: 3 })!.source).toContain("3 cache writes were reported, not added");
  });

  it("counts a turn as answered only once the model said or ran something", () => {
    expect(feed(line({ type: "thread.started", thread_id: "t" }), line({ type: "turn.started" }), line({ type: "turn.failed", error: { message: "x" } })).answered).toBe(false);
    expect(feed(line({ type: "item.completed", item: { id: "i", type: "command_execution", status: "declined" } })).answered).toBe(true);
    expect(feed(line({ type: "item.completed", item: { id: "i", type: "error", message: "Model metadata not found" } })).answered).toBe(false);
  });
});

describe("the session log", () => {
  const THREAD = "00000000-0000-4000-8000-0000000000bb";
  const logIn = (home: string, day: string, thread: string, lines: object[]) => {
    const dir = join(home, "sessions", day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-28T01-19-16-${thread}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };

  it("reads `turn_context.model` of the thread's own log, whichever recent day it is in", async () => {
    const home = codexHome();
    logIn(home, "2026/10/27", "00000000-0000-4000-8000-0000000000cc", sessionOf("another-thread"));
    logIn(home, "2026/10/27", THREAD, sessionOf("gpt-x"));
    logIn(home, "2026/10/28", "00000000-0000-4000-8000-0000000000dd", sessionOf("a-third"));

    expect(await sessionModel(home, THREAD)).toBe("gpt-x");
  });

  it("finds nothing for a thread with no log, an id that is not a thread id, or a log with no model", async () => {
    const home = codexHome();
    logIn(home, "2026/10/28", THREAD, [{ type: "session_meta", payload: {} }, { type: "turn_context", payload: { model: "  " } }]);

    expect(await sessionModel(home, "00000000-0000-4000-8000-0000000000ee")).toBeNull();
    expect(await sessionModel(home, "../../../etc/passwd")).toBeNull();
    expect(await sessionModel(home, "*")).toBeNull();
    expect(await sessionModel(home, THREAD)).toBeNull();
    expect(await sessionModel(join(home, "missing"), THREAD)).toBeNull();
  });

  it("looks only at the newest three days, and at the first lines of a log", async () => {
    const home = codexHome();
    logIn(home, "2026/10/01", THREAD, sessionOf("too-old"));
    for (const day of ["2026/10/25", "2026/10/26", "2026/10/27"]) logIn(home, day, "00000000-0000-4000-8000-0000000000ff", sessionOf("x"));
    const late = codexHome();
    logIn(late, "2026/10/28", THREAD, [...Array.from({ length: 300 }, () => ({ type: "response_item", payload: {} })), ...sessionOf("too-late")]);

    expect(await sessionModel(home, THREAD)).toBeNull();
    expect(await sessionModel(late, THREAD)).toBeNull();
  });

  it("uses CODEX_HOME when it is set, and the home directory's .codex otherwise", () => {
    expect(codexHomeOf({ CODEX_HOME: "/somewhere" })).toBe("/somewhere");
    expect(codexHomeOf({})).toMatch(/\.codex$/);
  });
});

describe("the adapter's declaration and options", () => {
  it("is registered under the name `ahp doctor` and `ahp init` use, and declares what was measured, per system", () => {
    const { declaration } = codexAdapter;

    expect(adapters.get("codex")).toBe(codexAdapter);
    expect(declaration).toMatchObject({ name: "codex", transport: "headless", login: "tool_login", gracefulCancel: false, mock: false });
    // `enforced_by_tool` for read_only on native Windows only, where it was measured; nothing is copied to the other systems.
    expect(declaration.capabilities.read_only).toEqual({ win32: "enforced_by_tool", darwin: "cooperative", linux: "cooperative" });
    for (const kind of ["write_scope", "no_external_actions"] as const) expect(declaration.capabilities[kind]).toEqual({ win32: "cooperative", darwin: "cooperative", linux: "cooperative" });
    for (const stance of ["deny", "package_registries"] as const) expect(declaration.network[stance]).toEqual({ win32: "none", darwin: "none", linux: "none" });
  });

  it("throws rather than apply a capability above the level it declares on that system, and starts nothing", async () => {
    const codexFake = fake({ stream: fixture("complete") });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const start = (capabilities: AppliedCapabilities) =>
      codexAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities, handoff: handoffOf(capabilities), options: undefined });
    const claimed = (platform: NodeJS.Platform, kind: "read_only" | "write_scope"): AppliedCapabilities => {
      const base = appliedFor([kind === "read_only" ? { kind, require: "cooperative" } : { kind, paths: ["src"], require: "cooperative" }], platform);
      return { ...base, capabilities: base.capabilities.map((c) => (c.kind === kind ? { ...c, level: "enforced_by_tool" } : c)) };
    };
    const claimedNetwork: AppliedCapabilities = { ...appliedFor(), network: { ...appliedFor().network, level: "cooperative" } };

    await expect(start(claimed("linux", "read_only"))).rejects.toThrow(/declares read_only "cooperative" on linux and cannot apply it at "enforced_by_tool"/);
    await expect(start(claimed("win32", "write_scope"))).rejects.toThrow(/declares write_scope "cooperative" on win32 and cannot apply it at "enforced_by_tool"/);
    await expect(start(claimedNetwork)).rejects.toThrow(/declares the "deny" stance "none" on \w+ and cannot apply it at "cooperative"/);
    expect(() => codexFake.call()).toThrow();
  });

  it("starts an attempt for read_only at `enforced_by_tool` on Windows, where that is declared", async () => {
    fake({ stream: fixture("complete") });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = appliedFor([{ kind: "read_only", require: "enforced_by_tool" }], "win32");

    const started = await codexAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities: applied, handoff: handoffOf(applied), options: { codexHome: codexHome() } });

    expect(applied.capabilities[0]).toMatchObject({ kind: "read_only", level: "enforced_by_tool" });
    expect((await started.exited).exitCode).toBe(0);
  });

  it("is held to its own declaration when another one is spread over it", async () => {
    const stronger = { ...codexAdapter, declaration: { ...codexAdapter.declaration, network: { ...codexAdapter.declaration.network, deny: { win32: "cooperative", darwin: "cooperative", linux: "cooperative" } as const } } };
    fake({ stream: fixture("complete") });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = resolveCapabilities(requestsOf({}), stronger.declaration, process.platform).applied;

    const started = await stronger.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities: applied, handoff: handoffOf(applied), options: { codexHome: codexHome() } });

    expect((await started.exited).exitCode).toBe(0);
  });

  it("validates its options", () => {
    const problems = (options: unknown) => codexAdapter.validateOptions(options);

    expect(problems(undefined)).toEqual([]);
    expect(problems({ reportFields: ["summary"], extraInstructions: "x", effort: "low", codexHome: "/c" })).toEqual([]);
    expect(problems({ sandbox: "danger-full-access" })).toEqual([expect.stringContaining('option "sandbox" is not one of')]);
    expect(problems({ reportFields: ["not a name"] })).toHaveLength(1);
    expect(problems({ effort: "huge", codexHome: "" })).toHaveLength(2);
    expect(problems([])).toEqual(["codex options must be an object"]);
  });

  it("reports a `codex` that is not on PATH as a failure to start, which the runtime records as unknown", async () => {
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = appliedFor();
    const original = process.env.PATH;
    process.env.PATH = "";
    restores.push(() => (process.env.PATH = original));

    await expect(
      codexAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities: applied, handoff: handoffOf(applied), options: undefined }),
    ).rejects.toThrow(/"codex" is not on PATH/);
  });
});

describe("a workflow step run by Codex", () => {
  const stepOf = (capabilities: CapabilityRequest[]) =>
    defineWorkflow({
      name: "codex",
      steps: [
        {
          id: "implement",
          agent: codex({ model: "gpt-5.6-luna", codexHome: codexHome() }),
          instructions: "Do the work.",
          capabilities,
          verification: { requiredOutputFields: ["summary"] },
        },
      ],
    });

  it("is verified on the fields the agent reported, and the ledger records the declared levels, the requested and reported model, and the usage the tool printed", async () => {
    const codexFake = fake({ stream: fixture("complete"), sessionLines: sessionOf("gpt-5.6-luna") });
    const repo = createTempRepo({ "README.md": "x\n" });

    const { state, runId } = await executeRun(stepOf([{ kind: "read_only", require: "enforced_by_tool" }]), { repo, adapters, platform: "win32" });

    expect(state.state).toBe("succeeded");
    const [attempt] = state.steps[0]!.attempts;
    expect(attempt).toMatchObject({ outcome: "ok", requestedModel: "gpt-5.6-luna", reportedModel: "gpt-5.6-luna", reportedOutput: { summary: "ok" } });
    expect(attempt!.usage).toMatchObject({ inputTokens: 13159, outputTokens: 63, cachedInputTokens: 0, cost: null });
    expect(attempt!.capabilities).toMatchObject({
      platform: "win32",
      capabilities: [
        { kind: "read_only", require: "enforced_by_tool", level: "enforced_by_tool" },
        { kind: "no_external_actions", require: "none", level: "cooperative" },
      ],
      network: { stance: "deny", require: "none", level: "none" },
    });
    const { stdin, argv } = codexFake.call();
    expect(stdin).toContain("Do the work.");
    expect(valueOf(argv, "--sandbox")).toBe("read-only");
    expect(valueOf(argv, "--model")).toBe("gpt-5.6-luna");
    expect((await readRunEvents({ repo, runId })).some((event) => event.type === "attempt_exited" && event.reportedModel === "gpt-5.6-luna")).toBe(true);
  });

  it("rejects a handoff that needs read_only enforced on a system where Codex only declares `cooperative`", async () => {
    fake({ stream: fixture("complete") });
    const repo = createTempRepo({ "README.md": "x\n" });

    const { state } = await executeRun(stepOf([{ kind: "read_only", require: "enforced_by_tool" }]), { repo, adapters, platform: "linux" });

    expect(state.steps[0]!.attempts).toHaveLength(0);
    expect(state.steps[0]!.handoffs[0]!.rejection).toEqual([
      expect.objectContaining({ code: "capability_unsatisfiable", pointer: "/capabilities/0", message: expect.stringContaining('adapter "codex" applies read_only at most at "cooperative" on linux') }),
    ]);
  });

  it("rejects a path scope that needs enforcement on every system: a sandbox mode cannot hold a path", async () => {
    fake({ stream: fixture("complete") });
    const repo = createTempRepo({ "README.md": "x\n" });

    const { state } = await executeRun(stepOf([{ kind: "write_scope", paths: ["src"], require: "enforced_by_tool" }]), { repo, adapters, platform: "win32" });

    expect(state.steps[0]!.handoffs[0]!.rejection).toEqual([expect.objectContaining({ code: "capability_unsatisfiable", pointer: "/capabilities/0" })]);
  });
});
