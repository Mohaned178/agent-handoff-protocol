// The Claude Code adapter (ADR 0001): the unmodified `claude` binary, headless (`claude -p`), with stream-json output,
// one process per attempt, under whatever login the user's own `claude` has. Never the Claude Agent SDK, and never
// `--bare` added or removed: AHP passes through the user's login and does not choose its mode.
//
// Cancelling is the process layer's: SIGTERM then a tree kill on Linux and macOS, a forced tree kill on Windows, where a
// headless Claude Code has no graceful stop AHP uses (its stream-json `interrupt` ends a turn, not the process).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, resolveExecutable } from "../../process/index.ts";
import { isOutputFieldName, levelOn, meetsLevel, sameOnEveryOs } from "../../protocol/index.ts";
import type { AgentRef } from "../../protocol/index.ts";
import type { Adapter, AttemptExit } from "../contract.ts";
import { outputSchemaFor } from "../output-schema.ts";
import { promptFor } from "../prompt.ts";
import { invocationFor, writeInvocationFiles } from "./settings.ts";
import { ClaudeStream } from "./stream.ts";

export const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface ClaudeCodeOptions {
  /** Output fields to report on top of the ones the step requires. */
  reportFields?: string[];
  /** Text added to the prompt after the handoff's instructions. */
  extraInstructions?: string;
  /** Claude Code's `--effort`. Default: the tool's own. */
  effort?: (typeof CLAUDE_CODE_EFFORTS)[number];
  /** Claude Code's `--max-budget-usd`: it stops the attempt (an agent error) once its own cost figure passes this. Default: none. */
  maxBudgetUsd?: number;
  /** Where Claude Code keeps its login and settings (`CLAUDE_CONFIG_DIR`). Default: the tool's own. */
  configDir?: string;
}

/** Names the Claude Code adapter for a step. `model` is requested from the tool (an alias such as `sonnet`, or a full name). */
export function claudeCode(options: ClaudeCodeOptions & { model?: string } = {}): AgentRef {
  const { model, ...rest } = options;
  return { adapter: "claude-code", ...(model === undefined ? {} : { model }), options: rest };
}

export const claudeCodeAdapter: Adapter = {
  // `cooperative` at most, on every system: the rules and the hook guard Claude Code's own tool calls, and an agent with
  // `Bash` reached files and a shared ref around them (native Windows, ticket 14). Linux and macOS have no evidence of
  // anything stronger. The network stance is not applied at all.
  declaration: {
    name: "claude-code",
    mock: false,
    gracefulCancel: false,
    transport: "headless",
    modelReporting: "pass_through",
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
    if (typeof options !== "object" || options === null || Array.isArray(options)) return ["claude-code options must be an object"];
    const known = ["reportFields", "extraInstructions", "effort", "maxBudgetUsd", "configDir"];
    const o = options as Record<string, unknown>;
    const problems = Object.keys(o).filter((key) => !known.includes(key)).map((key) => `claude-code option "${key}" is not one of ${known.join(", ")}`);
    if (o.reportFields !== undefined && !(Array.isArray(o.reportFields) && o.reportFields.every(isOutputFieldName))) problems.push("`reportFields` must be an array of output field names");
    if (o.extraInstructions !== undefined && typeof o.extraInstructions !== "string") problems.push("`extraInstructions` must be a string");
    if (o.effort !== undefined && !(CLAUDE_CODE_EFFORTS as readonly unknown[]).includes(o.effort)) problems.push(`\`effort\` must be one of ${CLAUDE_CODE_EFFORTS.join(", ")}`);
    if (o.maxBudgetUsd !== undefined && !(typeof o.maxBudgetUsd === "number" && Number.isFinite(o.maxBudgetUsd) && o.maxBudgetUsd > 0)) problems.push("`maxBudgetUsd` must be a positive number");
    if (o.configDir !== undefined && !(typeof o.configDir === "string" && o.configDir !== "")) problems.push("`configDir` must be a non-empty path");
    return problems;
  },

  // Called as a method, so an adapter built from this one under another declaration is held to its own.
  async startAttempt({ workspace, requestedModel, capabilities, handoff, options, transcript }) {
    // The contract: fail rather than apply a capability at a weaker level than the one recorded.
    const { declaration } = this;
    for (const { kind, level } of capabilities.capabilities) {
      const declared = levelOn(declaration.capabilities[kind], capabilities.platform);
      if (!meetsLevel(declared, level)) throw new Error(`claude-code adapter declares ${kind} "${declared}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }
    const { stance, level } = capabilities.network;
    const declaredNetwork = levelOn(declaration.network[stance], capabilities.platform);
    if (!meetsLevel(declaredNetwork, level)) {
      throw new Error(`claude-code adapter declares the "${stance}" stance "${declaredNetwork}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }

    const chosen = (options ?? {}) as ClaudeCodeOptions;
    const reportFields = chosen.reportFields ?? [];
    const outputFields = [...new Set([...handoff.contract.acceptance.requiredOutputFields, ...reportFields])];
    // Outside the worktree, so none of it shows up in the attempt's snapshot.
    const files = mkdtempSync(join(tmpdir(), "ahp-claude-"));
    const cleanUp = () => rmSync(files, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try {
      const settingsFile = join(files, "settings.json");
      const policyFile = join(files, "hook-policy.json");
      const invocation = invocationFor({
        applied: capabilities,
        workspace,
        requestedModel,
        outputSchema: outputSchemaFor(outputFields),
        settingsFile,
        policyFile,
        effort: chosen.effort,
        maxBudgetUsd: chosen.maxBudgetUsd,
      });
      writeInvocationFiles(invocation, settingsFile, policyFile);
      const executable = await resolveExecutable("claude");
      const agent = await launch({
        executable,
        args: invocation.args,
        cwd: workspace,
        input: promptFor(handoff, reportFields, chosen.extraInstructions),
        env: chosen.configDir ? { CLAUDE_CONFIG_DIR: chosen.configDir } : undefined,
        transcript,
      });

      const stream = new ClaudeStream();
      const reading = (async () => {
        agent.stdout.setEncoding("utf8");
        for await (const chunk of agent.stdout as AsyncIterable<string>) stream.write(chunk);
        stream.end();
      })();
      const exited = agent.exited.then(
        async ({ exitCode, signal }): Promise<AttemptExit> => {
          // A killed process ends its stdout, so this settles; a read error is the adapter losing contact.
          await reading;
          return { exitCode, signal, ...stream.exit(exitCode) };
        },
      ).finally(cleanUp);
      reading.catch(() => undefined);
      return { pid: agent.pid, exited, cancel: ({ graceMs }) => agent.terminate({ graceMs }) };
    } catch (error) {
      cleanUp();
      throw error;
    }
  },
};
