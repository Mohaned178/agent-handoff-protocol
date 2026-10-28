// The OpenCode adapter (ADR 0001, ticket 14 decision 3): the unmodified `opencode` binary driven through its own `opencode
// acp` over stdio, one process per attempt, started through the shared process layer in duplex mode, under whatever login
// the user's own `opencode` has. No third-party ACP bridge, and no ACP library: `acp.ts` is the whole client.
//
// The attempt is one conversation: `initialize`, `session/new`, the model (`session/set_config_option`, only when one is
// requested), one `session/prompt`. AHP answers OpenCode's own requests (`session/request_permission` by the capabilities,
// everything else "not found") and logs each tool call to the file the runtime gave it. Cancelling is the transport's:
// `session/cancel`, then the end of stdin, which is what makes an ACP agent exit; the process layer kills the tree only
// if that does not end it within the grace period.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, resolveExecutable, type LaunchedProcess } from "../../process/index.ts";
import { isOutputFieldName, levelOn, meetsLevel, sameOnEveryOs } from "../../protocol/index.ts";
import type { AgentRef, ToolCallLogEntry } from "../../protocol/index.ts";
import type { Adapter, AttemptExit, AttemptInput } from "../contract.ts";
import { promptFor } from "../prompt.ts";
import { AcpConnection, AcpError, ConnectionClosedError } from "./acp.ts";
import { configContentOf, decide, policyOf, type PermissionPolicy, type ToolCallRequest } from "./policy.ts";
import { AcpTurn, classify, redacted, type ToolCall } from "./turn.ts";

export interface OpenCodeOptions {
  /** Output fields to report on top of the ones the step requires. */
  reportFields?: string[];
  /** Text added to the prompt after the handoff's instructions. */
  extraInstructions?: string;
}

/** Names the OpenCode adapter for a step. `model` is requested from the tool as `provider/model`, one of the models its session lists. */
export function opencode(options: OpenCodeOptions & { model?: string } = {}): AgentRef {
  const { model, ...rest } = options;
  return { adapter: "opencode", ...(model === undefined ? {} : { model }), options: rest };
}

/** OpenCode has no structured output: the fields are asked for in words and read from the last message. */
const REPORT_HOW = "as one JSON object, which is the whole of your final message and nothing else (no text around it), with these fields as its keys";

/** How long OpenCode is given to exit once its stdin has ended, before its tree is killed. */
const EXIT_AFTER_INPUT_MS = 10_000;
/** How long `opencode export` is given before it is stopped and the model is reported as unknown. */
const EXPORT_MS = 30_000;
const MAX_TITLE_CHARS = 300;

export const openCodeAdapter: Adapter = {
  // `cooperative` at most on every system: OpenCode's permission rules and the answers AHP gives its permission requests
  // guard its own tool calls, and an agent with a shell can reach files and refs around them. The network stance is not
  // applied at all (ticket 14 decision 7). Nothing here was measured by an `enforced_by_tool` probe.
  declaration: {
    name: "opencode",
    mock: false,
    gracefulCancel: true,
    transport: "acp",
    // The session lists the models that can be selected (`configOptions`); which one answered is read afterwards, if at all.
    modelReporting: "enumerable",
    login: "tool_login",
    capabilities: {
      read_only: sameOnEveryOs("cooperative"),
      write_scope: sameOnEveryOs("cooperative"),
      no_external_actions: sameOnEveryOs("cooperative"),
    },
    network: { deny: sameOnEveryOs("none"), package_registries: sameOnEveryOs("none") },
  },

  validateOptions(options) {
    if (options === undefined) return [];
    if (typeof options !== "object" || options === null || Array.isArray(options)) return ["opencode options must be an object"];
    const known = ["reportFields", "extraInstructions"];
    const o = options as Record<string, unknown>;
    const problems = Object.keys(o).filter((key) => !known.includes(key)).map((key) => `opencode option "${key}" is not one of ${known.join(", ")}`);
    if (o.reportFields !== undefined && !(Array.isArray(o.reportFields) && o.reportFields.every(isOutputFieldName))) problems.push("`reportFields` must be an array of output field names");
    if (o.extraInstructions !== undefined && typeof o.extraInstructions !== "string") problems.push("`extraInstructions` must be a string");
    return problems;
  },

  // Called as a method, so an adapter built from this one under another declaration is held to its own.
  async startAttempt(input) {
    // The contract: fail rather than apply a capability at a weaker level than the one recorded.
    const { declaration } = this;
    const { capabilities } = input;
    for (const { kind, level } of capabilities.capabilities) {
      const declared = levelOn(declaration.capabilities[kind], capabilities.platform);
      if (!meetsLevel(declared, level)) throw new Error(`opencode adapter declares ${kind} "${declared}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }
    const { stance, level } = capabilities.network;
    const declaredNetwork = levelOn(declaration.network[stance], capabilities.platform);
    if (!meetsLevel(declaredNetwork, level)) {
      throw new Error(`opencode adapter declares the "${stance}" stance "${declaredNetwork}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }
    return start(input);
  },
};

async function start({ workspace, requestedModel, capabilities, handoff, options, toolCallLog, transcript }: AttemptInput) {
  const chosen = (options ?? {}) as OpenCodeOptions;
  const reportFields = chosen.reportFields ?? [];
  const policy = policyOf(capabilities, workspace);
  const env: NodeJS.ProcessEnv = {
    // The rules for this attempt, as inline config: a file in the worktree cannot weaken them.
    OPENCODE_CONFIG_CONTENT: configContentOf(policy),
    // The user's Claude Code skills and agent files are not this attempt's instructions (observed: 52 commands without, 17 with).
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  };
  const executable = await resolveExecutable("opencode");
  // `--cwd` and the launch's own PWD: OpenCode follows the inherited PWD, not the process's working directory (spike F1).
  const agent = await launch({ executable, args: ["acp", "--pure", "--cwd", workspace], cwd: workspace, duplex: true, env, transcript });

  const turn = new AcpTurn();
  const log = toolCallLogger(toolCallLog ?? null, workspace);
  turn.onToolCall = (call) => log.call(call);
  let sessionId: string | null = null;
  let prompting: Promise<unknown> | null = null;
  let cancelling = false;
  let turnEnded = false;

  const connection = new AcpConnection(agent.stdout, agent.stdin!, {
    notification: (method, params) => {
      if (method === "session/update") turn.update(params);
    },
    request: async (method, params) => {
      if (method !== "session/request_permission") return undefined;
      return answerPermission(params, policy, turn, log);
    },
  });

  const prompt = promptFor(handoff, reportFields, chosen.extraInstructions, REPORT_HOW);
  const conversation = converse();
  conversation.catch(() => undefined);

  async function converse(): Promise<void> {
    try {
      await connection.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (cancelling) return;
      const session = await connection.request<{ sessionId?: unknown }>("session/new", { cwd: workspace, mcpServers: [] });
      if (typeof session?.sessionId !== "string") throw new Error("OpenCode did not name the session it created");
      sessionId = session.sessionId;
      if (requestedModel) {
        try {
          await connection.request("session/set_config_option", { sessionId, configId: "model", value: requestedModel });
        } catch (error) {
          // Never go on to run the default model in its place.
          if (!(error instanceof AcpError)) throw error;
          turn.fail({ kind: classify(error.message, error.code), message: `OpenCode would not select the model "${requestedModel}": ${redacted(error.message)}` });
          return;
        }
      }
      if (cancelling) return;
      prompting = connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      turn.finish(await prompting);
    } catch (error) {
      if (cancelling || error instanceof ConnectionClosedError) return;
      if (error instanceof AcpError) turn.fail({ kind: classify(error.message, error.code), message: redacted(error.message) });
      else turn.fail({ kind: "agent_error", message: redacted((error as Error).message) });
    } finally {
      turnEnded = true;
      // An ACP agent finishes when its stdin ends.
      connection.endInput();
    }
  }

  const exited = (async (): Promise<AttemptExit> => {
    await conversation;
    const { exitCode, signal } = await exitOf(agent);
    await connection.closed;
    // Which model answered is OpenCode's own record of the session, read once it has exited, and only for a turn in which the model did something.
    // Not for a cancelled attempt: the export is a process outside the cancelled tree, which the cancel would have to wait for.
    const reportedModel = turn.answered && sessionId && !cancelling ? await modelOf(sessionId, workspace, env) : null;
    return { exitCode, signal, ...turn.exit(cancelling, exitCode), reportedModel };
  })();

  return {
    pid: agent.pid,
    exited,
    cancel: ({ graceMs }: { graceMs: number }) =>
      agent.terminate({
        graceMs,
        graceful: async () => {
          // A turn that had already ended is not cancelled: its result stands.
          if (!turnEnded) cancelling = true;
          if (sessionId !== null && prompting !== null) {
            connection.notify("session/cancel", { sessionId });
            // The turn ends with `cancelled`; a tool that does not say so within a while is told to finish anyway.
            await Promise.race([prompting.catch(() => undefined), sleep(Math.min(graceMs / 2, 3_000))]);
          }
          connection.endInput();
        },
      }),
  };
}

/** The process's exit once its stdin has ended; a process that does not exit is stopped, with its tree. */
async function exitOf(agent: LaunchedProcess) {
  const timer = new AbortController();
  const stuck = sleep(EXIT_AFTER_INPUT_MS, null, { signal: timer.signal }).then(() => "stuck" as const, () => "exited" as const);
  const outcome = await Promise.race([agent.exited.then(() => "exited" as const), stuck]);
  timer.abort();
  if (outcome === "stuck") {
    const termination = await agent.terminate({ graceMs: 0 });
    // Waiting on a process that could not be stopped would never end: the runtime records the attempt as unknown.
    if (termination.outcome === "unconfirmed") throw new Error(`OpenCode (PID ${agent.pid}) did not exit after its stdin ended, and could not be stopped: ${termination.detail}`);
  }
  return agent.exited;
}

/** Answers a `session/request_permission` by the policy: one option of the kind chosen, `allow_once` or `reject_once`, never `allow_always` (it would outlive the attempt in the user's own rules). */
async function answerPermission(params: unknown, policy: PermissionPolicy, turn: AcpTurn, log: ToolCallLogger): Promise<unknown> {
  const request = (typeof params === "object" && params !== null ? params : {}) as { toolCall?: unknown; options?: { optionId?: string; kind?: string }[] };
  const tool = (typeof request.toolCall === "object" && request.toolCall !== null ? request.toolCall : {}) as Record<string, unknown>;
  const known: ToolCall | undefined = typeof tool.toolCallId === "string" ? turn.toolCall(tool.toolCallId) : undefined;
  const rawInput = typeof tool.rawInput === "object" && tool.rawInput !== null ? (tool.rawInput as Record<string, unknown>) : {};
  const locations: string[] = Array.isArray(tool.locations)
    ? tool.locations.flatMap((location: unknown) => (typeof (location as { path?: unknown } | null)?.path === "string" ? [(location as { path: string }).path] : []))
    : [];
  const call: ToolCallRequest = {
    kind: typeof tool.kind === "string" ? tool.kind : (known?.kind ?? null),
    title: typeof tool.title === "string" ? tool.title : (known?.title ?? null),
    paths: locations.length > 0 ? locations : (known?.paths ?? []),
    command: typeof rawInput.command === "string" ? rawInput.command : (known?.command ?? null),
  };
  const decision = decide(policy, call);
  const wanted = decision.allow ? "allow_once" : "reject_once";
  const option = request.options?.find((candidate) => candidate.kind === wanted);
  // What was answered, not what was meant: with no option of the kind, the answer is `cancelled`, which allows nothing.
  if (typeof tool.toolCallId === "string") log.permission(tool.toolCallId, call, decision.allow && option?.optionId ? "allowed" : "rejected");
  return { outcome: option?.optionId ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
}

/** The model OpenCode records for the session's last answer (`opencode export`), as `provider/model`; null when it cannot be read. */
async function modelOf(sessionId: string, workspace: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const exporting = await launch({ executable: await resolveExecutable("opencode"), args: ["export", sessionId], cwd: workspace, env });
    let out = "";
    exporting.stdout.setEncoding("utf8");
    exporting.stdout.on("data", (chunk: string) => (out += chunk));
    const done = await Promise.race([exporting.exited.then((exit) => exit), sleep(EXPORT_MS).then(() => null)]);
    if (done === null) {
      await exporting.terminate({ graceMs: 0 });
      return null;
    }
    if (done.exitCode !== 0) return null;
    const messages = (JSON.parse(out) as { messages?: { info?: Record<string, unknown> }[] }).messages ?? [];
    const answer = messages.findLast((message) => message.info?.role === "assistant");
    const { providerID, modelID } = answer?.info ?? {};
    return typeof providerID === "string" && typeof modelID === "string" && providerID !== "" && modelID !== "" ? `${providerID}/${modelID}` : null;
  } catch {
    return null;
  }
}

interface ToolCallLogger {
  call(call: ToolCall): void;
  permission(toolCallId: string, call: ToolCallRequest, permission: "allowed" | "rejected"): void;
}

/** Appends a line to the runtime's tool-call log when a call's status, title or paths change, and when a permission request is answered. Never fails the attempt. */
function toolCallLogger(file: string | null, workspace: string): ToolCallLogger {
  if (file !== null) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Made now, so a log with no entry reads as the agent having made no tool call, not as an adapter that keeps none.
      appendFileSync(file, "");
    } catch {
      // the log is a convenience for a person; the attempt does not depend on it
    }
  }
  const last = new Map<string, string>();
  const pathOf = (path: string) => {
    const rel = relative(workspace, path);
    return rel === "" ? "." : rel.startsWith("..") ? path : rel.replaceAll("\\", "/");
  };
  const write = (entry: ToolCallLogEntry) => {
    if (file === null) return;
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      // see above
    }
  };
  const entry = (toolCallId: string, parts: Omit<ToolCallLogEntry, "time" | "toolCallId">): ToolCallLogEntry => ({
    time: new Date().toISOString(),
    toolCallId,
    ...parts,
    title: parts.title === null ? null : parts.title.slice(0, MAX_TITLE_CHARS),
    paths: parts.paths.map(pathOf),
  });
  return {
    call(call) {
      const fingerprint = JSON.stringify([call.kind, call.title, call.status, call.paths]);
      if (last.get(call.toolCallId) === fingerprint) return;
      last.set(call.toolCallId, fingerprint);
      write(entry(call.toolCallId, { kind: call.kind, title: call.title, status: call.status, paths: call.paths, permission: null }));
    },
    permission(toolCallId, call, permission) {
      write(entry(toolCallId, { kind: call.kind, title: call.title, status: "permission_requested", paths: call.paths, permission }));
    },
  };
}
