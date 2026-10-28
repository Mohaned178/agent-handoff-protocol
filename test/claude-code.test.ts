import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { TranscriptFiles } from "../src/process/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code/index.ts";
import { decide, type HookPolicy } from "../src/adapters/claude-code/hook.ts";
import { ClaudeStream } from "../src/adapters/claude-code/stream.ts";
import { adapters } from "../src/adapters/index.ts";
import {
  PROTOCOL_VERSION,
  type AppliedCapabilities,
  type CapabilityRequest,
  type HandoffEvidence,
  type HandoffRevision,
} from "../src/index.ts";
import { requestsOf, resolveCapabilities } from "../src/runtime/index.ts";
import { claudeCode, defineWorkflow, readRunEvents, runWorkflow } from "../src/index.ts";
import { fixture, installFakeClaude } from "./helpers/claude.ts";
import { createTempRepo, removeTempRepos } from "./helpers/repo.ts";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  removeTempRepos();
});

const fake = (options: Parameters<typeof installFakeClaude>[0]) => {
  const installed = installFakeClaude(options);
  restores.push(installed.restore);
  return installed;
};

/** A revision-1 handoff for the Claude Code adapter, with the capability requests the runtime would add to the step's. */
function handoffOf(
  applied: AppliedCapabilities,
  parts: { instructions?: string; fields?: Record<string, string | string[]>; requiredOutputFields?: string[]; evidence?: HandoffEvidence[]; artifacts?: string[] } = {},
): HandoffRevision {
  return {
    schemaVersion: PROTOCOL_VERSION,
    handoffId: "hnd_claude",
    revision: parts.evidence?.length ? 2 : 1,
    supersedes: parts.evidence?.length ? 1 : null,
    contextId: "run_claude",
    from: null,
    to: { stepId: "implement", adapter: "claude-code", requestedModel: null },
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

const appliedFor = (capabilities: CapabilityRequest[] = [], platform = process.platform) =>
  resolveCapabilities(requestsOf({ capabilities }), claudeCodeAdapter.declaration, platform).applied;

/** Runs one attempt of the adapter against the fake `claude` in a repository whose path has a space, and waits for it to end. */
async function attempt(
  stream: string,
  parts: Parameters<typeof handoffOf>[1] = {},
  run: { capabilities?: CapabilityRequest[]; requestedModel?: string | null; options?: unknown; exitCode?: number; tornTail?: string; transcript?: TranscriptFiles } = {},
) {
  const claude = fake({ stream, exitCode: run.exitCode, tornTail: run.tornTail });
  const workspace = join(createTempRepo({ "README.md": "x\n" }), "work space");
  mkdirSync(workspace);
  const applied = appliedFor(run.capabilities);
  const started = await claudeCodeAdapter.startAttempt({
    attemptId: "att_claude1",
    attemptNumber: 1,
    workspace,
    requestedModel: run.requestedModel ?? null,
    capabilities: applied,
    handoff: handoffOf(applied, parts),
    options: run.options,
    transcript: run.transcript,
  });
  const exit = await started.exited;
  return { exit, call: claude.call(), workspace };
}

describe("the Claude Code adapter's command line", () => {
  it("runs `claude -p` with stream-json, the prompt on stdin, in the workspace, and never adds or removes --bare", async () => {
    const { call, workspace } = await attempt(fixture("complete"), { instructions: "Add the password-reset endpoint & its test." });

    expect(call.argv.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode"]);
    expect(call.argv).not.toContain("--bare");
    expect(call.argv).not.toContain("--dangerously-skip-permissions");
    expect(call.argv).toContain("--no-session-persistence");
    // The prompt is on stdin and nowhere in the arguments, so no shell or command line ever reads it.
    expect(call.stdin).toContain("Add the password-reset endpoint & its test.");
    expect(call.argv.join(" ")).not.toContain("password-reset");
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

  it("passes the requested model only when one was requested, and the effort, budget and config directory only when given", async () => {
    const plain = await attempt(fixture("complete"));
    const given = await attempt(fixture("complete"), {}, {
      requestedModel: "sonnet",
      options: { effort: "low", maxBudgetUsd: 0.5, configDir: "C:/some/where else" },
    });

    for (const flag of ["--model", "--effort", "--max-budget-usd"]) expect(plain.call.argv).not.toContain(flag);
    expect(plain.call.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const flagValue = (flag: string) => given.call.argv[given.call.argv.indexOf(flag) + 1];
    expect(flagValue("--model")).toBe("sonnet");
    expect(flagValue("--effort")).toBe("low");
    expect(flagValue("--max-budget-usd")).toBe("0.5");
    expect(given.call.env.CLAUDE_CONFIG_DIR).toBe("C:/some/where else");
  });

  it("gives the agent a named tool set, and a JSON Schema for the fields the step requires and the options add", async () => {
    const { call } = await attempt(fixture("complete"), { requiredOutputFields: ["summary", "decisions"] }, { options: { reportFields: ["constraints"] } });

    const tools = call.argv[call.argv.indexOf("--tools") + 1]!.split(",");
    expect(tools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "Edit"]));
    // Claude Code's default set also schedules jobs, notifies and starts subagents; the PowerShell tool would bypass Bash's rules.
    for (const left of ["PowerShell", "Task", "RemoteTrigger", "CronCreate", "PushNotification"]) expect(tools).not.toContain(left);
    const schema = JSON.parse(call.argv[call.argv.indexOf("--json-schema") + 1]!);
    expect(schema.required).toEqual(["summary", "decisions", "constraints"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("asks for no structured output when no field is to be reported", async () => {
    const { call } = await attempt(fixture("complete"));

    expect(call.argv).not.toContain("--json-schema");
    expect(call.stdin).not.toContain("## Report");
  });
});

describe("the settings and hook files", () => {
  it("writes them outside the workspace, removes them once the attempt ends, and registers the hook with quoted forward-slash paths", async () => {
    const { call, workspace } = await attempt(fixture("complete"));

    expect(call.settingsPath).not.toBeNull();
    expect(call.settingsPath!.startsWith(realpathSync.native(workspace))).toBe(false);
    expect(existsSync(call.settingsPath!)).toBe(false);
    expect(call.policyPath && existsSync(call.policyPath)).toBeFalsy();
    const settings = call.settings as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
    const [entry] = settings.hooks.PreToolUse;
    expect(entry!.matcher.split("|")).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    const { command } = entry!.hooks[0]!;
    expect(command).not.toContain("\\");
    expect(command).toMatch(/^"[^"]+" "[^"]+hook\.(ts|js)" "[^"]+hook-policy\.json"$/);
    // A step that lists no capability changes no file tool: it is only kept inside the workspace.
    expect(call.policy).toEqual({ workspace, readOnly: false, writeScope: null });
    expect((call.settings as { permissions: { deny: string[] } }).permissions.deny).toEqual(expect.arrayContaining(["Bash(git push:*)", "Bash(gh:*)"]));
  });

  it("applies read_only and write_scope as the tools it removes, the deny rules and the hook's policy", async () => {
    const readOnly = await attempt(fixture("complete"), {}, { capabilities: [{ kind: "read_only", require: "cooperative" }] });
    const scoped = await attempt(fixture("complete"), {}, { capabilities: [{ kind: "write_scope", paths: ["src", "test/new.txt"], require: "cooperative" }] });

    const toolsOf = (call: { argv: string[] }) => call.argv[call.argv.indexOf("--tools") + 1]!.split(",");
    expect(toolsOf(readOnly.call)).not.toEqual(expect.arrayContaining(["Write"]));
    for (const tool of ["Write", "Edit", "NotebookEdit"]) expect(toolsOf(readOnly.call)).not.toContain(tool);
    expect((readOnly.call.settings as { permissions: { deny: string[] } }).permissions.deny).toEqual(expect.arrayContaining(["Write", "Edit", "MultiEdit", "NotebookEdit"]));
    expect(readOnly.call.policy).toMatchObject({ readOnly: true });
    expect(readOnly.call.stdin).toContain("Change no file in this workspace");
    expect(scoped.call.policy).toMatchObject({ readOnly: false, writeScope: ["src", "test/new.txt"] });
    expect(toolsOf(scoped.call)).toContain("Write");
    expect(scoped.call.stdin).toContain("Change files only under: src, test/new.txt.");
  });
});

describe("the prompt", () => {
  it("holds the instructions, what earlier steps handed on, and what the last attempt did wrong, and never the verification command", async () => {
    const { call } = await attempt(fixture("complete"), {
      instructions: "Implement the reset endpoint.",
      fields: { summary: "The plan is two steps.", decisions: ["Tokens expire", "Use bcrypt"] },
      artifacts: ["docs/plan.md"],
      requiredOutputFields: ["summary"],
      evidence: [
        { kind: "test_output", command: "node hidden-secret-test.mjs", exitCode: 1, signal: null, output: "expected 200 got 500", truncated: false },
        { kind: "review_findings", reviewStepId: "review", findings: ["The token is never invalidated"] },
      ],
    });

    expect(call.stdin).toContain("Implement the reset endpoint.");
    expect(call.stdin).toContain("The plan is two steps.");
    expect(call.stdin).toContain("- Tokens expire\n- Use bcrypt");
    expect(call.stdin).toContain("- docs/plan.md");
    expect(call.stdin).toContain("expected 200 got 500");
    expect(call.stdin).toContain("The token is never invalidated");
    expect(call.stdin).toContain("report these fields through the structured output: summary");
    expect(call.stdin).toContain("Do not push, open or merge a pull request");
  });

  it("does not show the output of hidden tests, which the handoff withholds", async () => {
    const { call } = await attempt(fixture("complete"), {
      evidence: [{ kind: "test_output", command: "node hidden-secret-test.mjs", exitCode: 1, signal: null, output: null, truncated: false }],
    });

    expect(call.stdin).toContain("its output is withheld");
  });
});

describe("what the stream says about the attempt", () => {
  it("reports the output fields, the model the answers named, the stop reason and the usage the tool printed, labelled with their source", async () => {
    const { exit } = await attempt(fixture("complete"), { requiredOutputFields: ["summary", "decisions"] }, { requestedModel: "sonnet" });

    expect(exit.exitCode).toBe(0);
    expect(exit.error).toBeNull();
    expect(exit.reportedOutput).toMatchObject({ summary: expect.stringContaining("Created hello.txt"), decisions: [expect.stringContaining("trailing newline")] });
    // The alias was requested; the tool named the model it ran.
    expect(exit.reportedModel).toBe("claude-sonnet-5-5");
    expect(exit.stopReason).toBe("end_turn");
    // Numbers as printed; the cache writes and the total are not folded in or made up.
    expect(exit.usage).toEqual({
      source: expect.stringContaining("list-price figure from the tool, not a charge"),
      inputTokens: 8,
      outputTokens: 534,
      totalTokens: null,
      cachedInputTokens: 19027,
      cost: { amount: 0.053686700000000004, currency: "USD" },
    });
    expect(exit.usage!.source).toContain("input_tokens excludes cache reads (cachedInputTokens) and cache writes (11607 reported, not included)");
    expect(exit.usage!.source).toContain("apiKeySource none");
  });

  it("classifies a missing login as config_auth, from the error on the assistant message, and reports no model that never ran", async () => {
    const { exit } = await attempt(fixture("not-logged-in"), {}, { exitCode: 1 });

    expect(exit.error).toEqual({ kind: "config_auth", message: "Not logged in · Please run /login" });
    expect(exit.exitCode).toBe(1);
    expect(exit.reportedModel).toBeNull();
    expect(exit.usage).toBeNull();
  });

  it("reports the tool's own budget stop as an agent error, with the tool's words", async () => {
    const { exit } = await attempt(fixture("budget-exhausted"), {}, { exitCode: 1 });

    expect(exit.error).toEqual({ kind: "agent_error", message: "Reached maximum budget ($0.001)" });
    expect(exit.reportedModel).toBe("claude-sonnet-5-5");
  });

  it("keeps what it read when the process was killed in the middle of a line", async () => {
    const complete = fixture("complete");
    const withoutResult = complete.split("\n").filter(Boolean).slice(0, -1).join("\n") + "\n";

    const { exit } = await attempt(withoutResult, {}, { exitCode: 1, tornTail: '{"type":"assistant","message":{"mod' });

    expect(exit.error).toBeNull();
    expect(exit.reportedOutput).toEqual({});
    expect(exit.usage).toBeNull();
    expect(exit.stopReason).toBeNull();
    // The model is read from the answers before the kill, not from the result that never came.
    expect(exit.reportedModel).toBe("claude-sonnet-5-5");
  });

  it("stops a hanging process with the process layer, which on Windows is a forced tree kill", async () => {
    const claude = fake({ stream: fixture("complete").split("\n")[0] + "\n", hang: true });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = appliedFor();
    const started = await claudeCodeAdapter.startAttempt({
      attemptId: "att_claude2",
      attemptNumber: 1,
      workspace,
      requestedModel: null,
      capabilities: applied,
      handoff: handoffOf(applied),
      options: undefined,
    });

    const termination = await started.cancel({ graceMs: 200 });
    const exit = await started.exited;

    expect(termination).toMatchObject({ outcome: "stopped", forced: process.platform === "win32", via: process.platform === "win32" ? "tree_kill" : "signal" });
    expect(exit.reportedOutput).toEqual({});
    expect(exit.usage).toBeNull();
  });
});

describe("ClaudeStream", () => {
  const feed = (...chunks: string[]) => {
    const stream = new ClaudeStream();
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
    return stream;
  };
  const line = (event: object) => JSON.stringify(event) + "\n";

  it("ignores event types it does not know, lines that are not JSON, and a rate limit event on a healthy run", () => {
    const stream = feed(
      line({ type: "system", subtype: "something_new", data: 1 }),
      "this is not json\n",
      line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }),
      line({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "done" }),
    );

    expect(stream.exit(0)).toMatchObject({ error: null, stopReason: "end_turn", usage: null, reportedModel: null, reportedOutput: {} });
  });

  it("reads lines however the chunks are cut, a last line with no newline included", () => {
    const text = line({ type: "assistant", message: { model: "claude-x", content: [] } }) + JSON.stringify({ type: "result", is_error: false, structured_output: { summary: "s" } });

    const stream = feed(text.slice(0, 20), text.slice(20, 90), text.slice(90));

    expect(stream.exit(0)).toMatchObject({ reportedModel: "claude-x", reportedOutput: { summary: "s" } });
  });

  it.each([
    ["authentication_failed", "config_auth"],
    ["oauth_org_not_allowed", "config_auth"],
    ["billing_error", "config_auth"],
    ["model_not_found", "config_auth"],
    ["rate_limit", "transient"],
    ["overloaded", "transient"],
    ["server_error", "transient"],
    ["invalid_request", "agent_error"],
    ["max_output_tokens", "agent_error"],
    ["unknown", "agent_error"],
  ])("classifies the API error %s as %s", (code, kind) => {
    const stream = feed(
      line({ type: "assistant", error: code, message: { model: "<synthetic>", content: [{ type: "text", text: `error ${code}` }] } }),
      line({ type: "result", is_error: true, result: `error ${code}` }),
    );

    expect(stream.exit(1).error).toEqual({ kind, message: `error ${code}` });
  });

  it("classifies by HTTP status when the tool gave no error code", () => {
    const status = (api_error_status: number) => feed(line({ type: "result", is_error: true, result: "failed", api_error_status })).exit(1).error?.kind;

    expect([status(401), status(429), status(529), status(500), status(400)]).toEqual(["config_auth", "transient", "transient", "transient", "agent_error"]);
  });

  it("reports a failure with no result event only when the tool said why", () => {
    expect(feed(line({ type: "system", subtype: "init" })).exit(1).error).toBeNull();
    expect(feed(line({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [] } })).exit(1).error?.kind).toBe("transient");
  });

  it("maps the stop reasons it can tell, and leaves the rest null", () => {
    const stop = (result: object) => feed(line({ type: "result", is_error: false, ...result })).exit(0).stopReason;

    expect([
      stop({ terminal_reason: "completed" }),
      stop({ subtype: "error_max_turns" }),
      stop({ stop_reason: "max_tokens" }),
      stop({ stop_reason: "refusal" }),
      stop({ terminal_reason: "something_new" }),
    ]).toEqual(["end_turn", "max_turn_requests", "max_tokens", "refusal", null]);
  });

  it("reports no usage when the result carries no number, and null for a number that is missing, never 0", () => {
    expect(feed(line({ type: "result", is_error: false, usage: {} })).exit(0).usage).toBeNull();
    const usage = feed(line({ type: "result", is_error: false, usage: { output_tokens: 7 } })).exit(0).usage;
    expect(usage).toMatchObject({ inputTokens: null, outputTokens: 7, totalTokens: null, cachedInputTokens: null, cost: null });
  });

  it("ignores a subagent's messages, and drops output fields that are not text", () => {
    const stream = feed(
      line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { model: "claude-sub", content: [] } }),
      line({ type: "result", is_error: false, structured_output: { summary: "s", n: 3, items: ["a", 4], ok: ["a", "b"] } }),
    );

    expect(stream.exit(0)).toMatchObject({ reportedModel: null, reportedOutput: { summary: "s", ok: ["a", "b"] } });
  });
});

describe("the file-tool hook", () => {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-hook-")));
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));
  const policy = (over: Partial<HookPolicy> = {}): HookPolicy => ({ workspace, readOnly: false, writeScope: null, ...over });
  const write = (file_path: string, tool_name = "Write") => ({ tool_name, tool_input: { file_path, content: "x" }, cwd: workspace });

  it.each([
    ["a file in the workspace", "notes.txt", true],
    ["a new file under a directory that does not exist yet", "src/deep/new/file.txt", true],
    ["a path with .. that stays inside", "src/../notes.txt", true],
    ["a file above the workspace", "../outside.txt", false],
    ["a path that climbs out and back by another name", "src/../../elsewhere/x.txt", false],
    ["the workspace itself", ".", false],
    ["a file under .git", ".git/config", false],
    ["a file under .git in another case", ".GIT/hooks/pre-commit", process.platform === "linux"],
  ])("a write to %s", (_name, path, allowed) => {
    expect(decide(write(path), policy(), process.platform).allow).toBe(allowed);
  });

  it("refuses an absolute path outside the workspace, and allows one inside it", () => {
    expect(decide(write(join(tmpdir(), "elsewhere.txt")), policy()).allow).toBe(false);
    expect(decide(write(join(workspace, "src", "a.txt")), policy()).allow).toBe(true);
  });

  it("holds a write to the scope: a file or a directory with everything under it, and nothing beside it", () => {
    const scoped = policy({ writeScope: ["src", "docs/plan.md"] });

    const allowed = ["src/a.txt", "src/deep/b.txt", "docs/plan.md"].map((path) => decide(write(path), scoped).allow);
    const refused = ["srcother/a.txt", "docs/other.md", "docs/plan.md.bak", "README.md"].map((path) => decide(write(path), scoped).allow);

    expect(allowed).toEqual([true, true, true]);
    expect(refused).toEqual([false, false, false, false]);
  });

  it("refuses every write for a read-only step, and a call whose file it cannot read", () => {
    expect(decide(write("notes.txt"), policy({ readOnly: true }))).toMatchObject({ allow: false, reason: expect.stringContaining("read-only") });
    expect(decide({ tool_name: "Write", tool_input: {}, cwd: workspace }, policy()).allow).toBe(false);
    expect(decide({ tool_name: "Write", tool_input: { file_path: 3 }, cwd: workspace }, policy()).allow).toBe(false);
  });

  it("reads a notebook's path, and lets a tool it does not guard through", () => {
    expect(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: "../n.ipynb" }, cwd: workspace }, policy()).allow).toBe(false);
    expect(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: "n.ipynb" }, cwd: workspace }, policy()).allow).toBe(true);
    expect(decide({ tool_name: "Read", tool_input: { file_path: "../x" }, cwd: workspace }, policy()).allow).toBe(true);
  });

  it("treats letter case as Claude Code's file system does, on Windows and macOS", () => {
    // A directory that does not exist yet, so the host's own file system does not settle the case.
    const scoped = policy({ writeScope: ["docs"] });

    expect(decide(write("DOCS/a.txt"), scoped, "win32").allow).toBe(true);
    expect(decide(write("DOCS/a.txt"), scoped, "darwin").allow).toBe(true);
    expect(decide(write("DOCS/a.txt"), scoped, "linux").allow).toBe(false);
  });

  it.skipIf(process.platform === "win32")("follows a symbolic link out of the workspace", async () => {
    const { symlinkSync } = await import("node:fs");
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-outside-")));
    symlinkSync(outside, join(workspace, "escape"));

    expect(decide(write("escape/x.txt"), policy()).allow).toBe(false);
  });

  it("runs as the hook claude starts: the payload on stdin, the policy file named, exit code 2 and the reason on stderr to block", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ahp hook ")), "dir with space");
    mkdirSync(dir);
    const policyFile = join(dir, "hook-policy.json");
    writeFileSync(policyFile, JSON.stringify(policy({ writeScope: ["src"] })));
    const script = fileURLToPath(new URL("../src/adapters/claude-code/hook.ts", import.meta.url));
    const run = (payload: unknown) => spawnSync(process.execPath, [script, policyFile], { input: JSON.stringify(payload), encoding: "utf8", windowsHide: true });

    const allowed = run(write("src/ok.txt"));
    const blocked = run(write("README.md"));
    const unreadable = spawnSync(process.execPath, [script, policyFile], { input: "not json", encoding: "utf8", windowsHide: true });
    const noPolicy = spawnSync(process.execPath, [script, join(dir, "missing.json")], { input: JSON.stringify(write("src/ok.txt")), encoding: "utf8", windowsHide: true });

    expect(allowed.status).toBe(0);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("outside this step's write scope (src)");
    // Claude Code lets a call through when a hook fails any other way, so a hook that cannot decide blocks.
    expect(unreadable.status).toBe(2);
    expect(noPolicy.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the adapter's declaration and options", () => {
  it("is registered under the name `ahp doctor` and `ahp init` use, and declares `cooperative` at most, and the network stance `none`, on every system", () => {
    const { declaration } = claudeCodeAdapter;

    expect(adapters.get("claude-code")).toBe(claudeCodeAdapter);
    expect(declaration).toMatchObject({ name: "claude-code", transport: "headless", login: "tool_login", gracefulCancel: false, mock: false });
    for (const os of ["win32", "darwin", "linux"] as const) {
      expect(Object.values(declaration.capabilities).map((levels) => levels[os])).toEqual(["cooperative", "cooperative", "cooperative"]);
      expect(Object.values(declaration.network).map((levels) => levels[os])).toEqual(["none", "none"]);
    }
  });

  it("throws rather than apply a capability above the level it declares, and starts nothing", async () => {
    const claude = fake({ stream: fixture("complete") });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = appliedFor([{ kind: "read_only", require: "cooperative" }]);
    const claimed: AppliedCapabilities = { ...applied, capabilities: applied.capabilities.map((c) => (c.kind === "read_only" ? { ...c, level: "enforced_by_tool" } : c)) };
    const claimedNetwork: AppliedCapabilities = { ...applied, network: { ...applied.network, level: "cooperative" } };
    const start = (capabilities: AppliedCapabilities) =>
      claudeCodeAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities, handoff: handoffOf(applied), options: undefined });

    await expect(start(claimed)).rejects.toThrow(/declares read_only "cooperative" on \w+ and cannot apply it at "enforced_by_tool"/);
    await expect(start(claimedNetwork)).rejects.toThrow(/declares the "deny" stance "none" on \w+ and cannot apply it at "cooperative"/);
    expect(() => claude.call()).toThrow();
  });

  it("is held to its own declaration when another one is spread over it", async () => {
    const stronger = { ...claudeCodeAdapter, declaration: { ...claudeCodeAdapter.declaration, network: { ...claudeCodeAdapter.declaration.network, deny: { win32: "cooperative", darwin: "cooperative", linux: "cooperative" } as const } } };
    fake({ stream: fixture("complete") });
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = resolveCapabilities(requestsOf({}), stronger.declaration, process.platform).applied;

    const started = await stronger.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities: applied, handoff: handoffOf(applied), options: undefined });

    expect((await started.exited).exitCode).toBe(0);
  });

  it("validates its options", () => {
    const problems = (options: unknown) => claudeCodeAdapter.validateOptions(options);

    expect(problems(undefined)).toEqual([]);
    expect(problems({ reportFields: ["summary"], extraInstructions: "x", effort: "low", maxBudgetUsd: 1, configDir: "/c" })).toEqual([]);
    expect(problems({ bare: true })).toEqual([expect.stringContaining('option "bare" is not one of')]);
    expect(problems({ reportFields: ["not a name"] })).toHaveLength(1);
    expect(problems({ effort: "huge", maxBudgetUsd: 0, configDir: "" })).toHaveLength(3);
    expect(problems([])).toEqual(["claude-code options must be an object"]);
  });

  it("reports a `claude` that is not on PATH as a failure to start, which the runtime records as unknown", async () => {
    const workspace = createTempRepo({ "README.md": "x\n" });
    const applied = appliedFor();
    const original = process.env.PATH;
    process.env.PATH = "";
    restores.push(() => (process.env.PATH = original));

    await expect(
      claudeCodeAdapter.startAttempt({ attemptId: "att_x", attemptNumber: 1, workspace, requestedModel: null, capabilities: applied, handoff: handoffOf(applied), options: undefined }),
    ).rejects.toThrow(/"claude" is not on PATH/);
  });
});

describe("a workflow step run by Claude Code", () => {
  it("is verified on the fields the agent reported, and the ledger records the declared levels, the requested and reported model, and the usage the tool printed", async () => {
    const claude = fake({ stream: fixture("complete") });
    const repo = createTempRepo({ "README.md": "x\n" });
    const workflow = defineWorkflow({
      name: "claude",
      steps: [
        {
          id: "plan",
          agent: claudeCode({ model: "sonnet" }),
          instructions: "Write a plan.",
          capabilities: [{ kind: "read_only" }],
          verification: { requiredOutputFields: ["summary", "decisions"] },
        },
      ],
    });

    const { state, runId } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("succeeded");
    const [attempt] = state.steps[0]!.attempts;
    expect(attempt).toMatchObject({ outcome: "ok", requestedModel: "sonnet", reportedModel: "claude-sonnet-5-5" });
    expect(attempt!.usage).toMatchObject({ inputTokens: 8, outputTokens: 534, cachedInputTokens: 19027, cost: { amount: 0.053686700000000004, currency: "USD" } });
    expect(attempt!.reportedOutput).toMatchObject({ summary: expect.any(String), decisions: expect.any(Array) });
    expect(attempt!.capabilities).toMatchObject({
      capabilities: [
        { kind: "read_only", require: "cooperative", level: "cooperative" },
        { kind: "no_external_actions", require: "none", level: "cooperative" },
      ],
      network: { stance: "deny", require: "none", level: "none" },
    });
    // What the agent was asked: the step's instructions, and the fields its step requires.
    const { stdin, argv } = claude.call();
    expect(stdin).toContain("Write a plan.");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect((await readRunEvents({ repo, runId })).some((event) => event.type === "attempt_exited" && event.reportedModel === "claude-sonnet-5-5")).toBe(true);
  });

  it("rejects a handoff that needs more than Claude Code declares", async () => {
    fake({ stream: fixture("complete") });
    const repo = createTempRepo({ "README.md": "x\n" });
    const workflow = defineWorkflow({
      name: "claude-strict",
      steps: [{ id: "plan", agent: claudeCode(), capabilities: [{ kind: "read_only", require: "enforced_by_tool" }], verification: { requiredOutputFields: ["summary"] } }],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.steps[0]!.attempts).toHaveLength(0);
    expect(state.steps[0]!.handoffs[0]!.rejection).toEqual([
      expect.objectContaining({ code: "capability_unsatisfiable", pointer: "/capabilities/0", message: expect.stringContaining('adapter "claude-code" applies read_only at most at "cooperative"') }),
    ]);
  });
});
