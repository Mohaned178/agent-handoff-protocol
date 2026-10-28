// The Gemini CLI adapter (ADR 0001, ticket 19): the unmodified `gemini` binary driven through its own `gemini --acp` over
// stdio, one process per attempt, started through the shared process layer in duplex mode, under whatever login the user's
// own `gemini` has (a saved Google login, or an API key in its settings or environment). No third-party ACP bridge.
//
// What is known of this adapter's counterpart came from a real 0.42.0 only as far as `initialize` and a `session/new`
// with no login: the maintainer has no paid Gemini access, so no turn was ever run. The rest of the conversation is read
// from the tool's own source and is unconfirmed until a run with access exists (docs/adapters/gemini-cli.md says which).
//
// The attempt is one conversation: `initialize`, `session/new`, one `session/prompt`. AHP never calls `authenticate`
// (the tool writes the method it is given into the user's own settings): `session/new` uses the login the tool already
// has. AHP answers the tool's own requests (`session/request_permission` by the capabilities, everything else "not found")
// and logs each tool call to the file the runtime gave it. Cancelling is the transport's: `session/cancel`, then the end of
// stdin, which is what makes an ACP agent exit; the process layer kills the tree only if that does not end it in time.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, resolveExecutable, type LaunchedProcess } from "../../process/index.ts";
import { isOutputFieldName, levelOn, meetsLevel, sameOnEveryOs } from "../../protocol/index.ts";
import type { AgentRef } from "../../protocol/index.ts";
import type { Adapter, AttemptExit, AttemptInput } from "../contract.ts";
import { AcpConnection, AcpError, ConnectionClosedError } from "../acp/connection.ts";
import { answerPermission, policyOf } from "../acp/permissions.ts";
import { redacted, toolCallLogger } from "../acp/tool-calls.ts";
import { promptFor, REPORT_AS_JSON_MESSAGE } from "../prompt.ts";
import { policyFileOf } from "./policy.ts";
import { classify, GeminiTurn } from "./turn.ts";

export interface GeminiCliOptions {
  /** Output fields to report on top of the ones the step requires. */
  reportFields?: string[];
  /** Text added to the prompt after the handoff's instructions. */
  extraInstructions?: string;
}

/** Names the Gemini CLI adapter for a step. `model` is passed to the tool as `--model`, unvalidated: the tool's own refusal ends the attempt. */
export function geminiCli(options: GeminiCliOptions & { model?: string } = {}): AgentRef {
  const { model, ...rest } = options;
  return { adapter: "gemini-cli", ...(model === undefined ? {} : { model }), options: rest };
}

/** How long Gemini CLI is given to exit once its stdin has ended, before its tree is killed. */
const EXIT_AFTER_INPUT_MS = 10_000;

export const geminiCliAdapter: Adapter = {
  // `cooperative` at most on every system: the policy file and the answers AHP gives the tool's permission requests guard
  // its own tool calls, and an agent with a shell can reach files and refs around them. The network stance is not applied
  // at all (ticket 14 decision 7). Nothing here was measured by a conformance probe: no run was possible (no paid access).
  declaration: {
    name: "gemini-cli",
    mock: false,
    gracefulCancel: true,
    transport: "acp",
    // `session/new` lists the models that can be selected; which one answered is the tool's own `model_usage`, if it names one.
    modelReporting: "enumerable",
    // A key in the tool's own settings or environment (the default of `session/new`), or a Google login the tool keeps itself.
    login: "api_key",
    capabilities: {
      read_only: sameOnEveryOs("cooperative"),
      write_scope: sameOnEveryOs("cooperative"),
      no_external_actions: sameOnEveryOs("cooperative"),
    },
    network: { deny: sameOnEveryOs("none"), package_registries: sameOnEveryOs("none") },
  },

  validateOptions(options) {
    if (options === undefined) return [];
    if (typeof options !== "object" || options === null || Array.isArray(options)) return ["gemini-cli options must be an object"];
    const known = ["reportFields", "extraInstructions"];
    const o = options as Record<string, unknown>;
    const problems = Object.keys(o).filter((key) => !known.includes(key)).map((key) => `gemini-cli option "${key}" is not one of ${known.join(", ")}`);
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
      if (!meetsLevel(declared, level)) throw new Error(`gemini-cli adapter declares ${kind} "${declared}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }
    const { stance, level } = capabilities.network;
    const declaredNetwork = levelOn(declaration.network[stance], capabilities.platform);
    if (!meetsLevel(declaredNetwork, level)) {
      throw new Error(`gemini-cli adapter declares the "${stance}" stance "${declaredNetwork}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }
    return start(input);
  },
};

async function start({ workspace, requestedModel, capabilities, handoff, options, toolCallLog, transcript }: AttemptInput) {
  const chosen = (options ?? {}) as GeminiCliOptions;
  const reportFields = chosen.reportFields ?? [];
  const policy = policyOf(capabilities, workspace);
  // The policy file lives outside the worktree, where the agent's own file tools are not pointed, and goes when the attempt ends.
  const scratch = mkdtempSync(join(tmpdir(), "ahp-gemini-"));
  const policyFile = join(scratch, "policy.toml");
  const forget = () => {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a file the exiting tool still holds (Windows): it is in the temp directory, which the system empties
    }
  };
  let agent: LaunchedProcess;
  try {
    writeFileSync(policyFile, policyFileOf(policy));
    const executable = await resolveExecutable("gemini");
    // `--approval-mode default` whatever the user's settings say (an `auto_edit` there would approve edits with no request to AHP);
    // `--policy` in place of the user's own policy directory, so no saved "always allow" skips the request either; and no
    // `--skip-trust`: a worktree is not trusted, so a hook or an agent file in it is not loaded.
    const args = ["--acp", "--approval-mode", "default", "--policy", policyFile, ...(requestedModel ? ["--model", requestedModel] : [])];
    agent = await launch({ executable, args, cwd: workspace, duplex: true, transcript });
  } catch (error) {
    forget();
    throw error;
  }

  const turn = new GeminiTurn();
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
      return answerPermission(params, policy, (id) => turn.toolCall(id), log, { commandIsTitle: true });
    },
  });

  const prompt = promptFor(handoff, reportFields, chosen.extraInstructions, REPORT_AS_JSON_MESSAGE);
  const conversation = converse();
  conversation.catch(() => undefined);

  async function converse(): Promise<void> {
    let phase: "session" | "prompt" = "session";
    try {
      await connection.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (cancelling) return;
      const session = await connection.request<{ sessionId?: unknown; modes?: { currentModeId?: unknown } }>("session/new", { cwd: workspace, mcpServers: [] });
      if (typeof session?.sessionId !== "string") throw new Error("Gemini CLI did not name the session it created");
      sessionId = session.sessionId;
      // AHP's answers to permission requests are all it has to apply a step's limits through the tool's own prompts: a mode that
      // approves without asking would run the whole step unchecked, so no prompt is sent.
      const mode = session.modes?.currentModeId;
      if (mode !== "default") {
        turn.fail({ kind: "config_auth", message: `Gemini CLI started in approval mode ${typeof mode === "string" ? `"${mode}"` : "(not stated)"}, not "default": AHP does not run a step where its permission answers may never be asked` });
        return;
      }
      if (cancelling) return;
      phase = "prompt";
      prompting = connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      turn.finish(await prompting);
    } catch (error) {
      if (cancelling || error instanceof ConnectionClosedError) return;
      if (error instanceof AcpError) turn.fail({ kind: classify(error.message, error.code, phase), message: redacted(error.message) });
      else turn.fail({ kind: "agent_error", message: redacted((error as Error).message) });
    } finally {
      turnEnded = true;
      // An ACP agent finishes when its stdin ends.
      connection.endInput();
    }
  }

  const exited = (async (): Promise<AttemptExit> => {
    try {
      await conversation;
      const { exitCode, signal } = await exitOf(agent);
      await connection.closed;
      const { reportedModel, ...rest } = turn.exit(cancelling, exitCode);
      return { exitCode, signal, ...rest, reportedModel: turn.answered ? reportedModel : null };
    } finally {
      forget();
    }
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
    if (termination.outcome === "unconfirmed") throw new Error(`Gemini CLI (PID ${agent.pid}) did not exit after its stdin ended, and could not be stopped: ${termination.detail}`);
  }
  return agent.exited;
}
