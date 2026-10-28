// The Codex adapter (ADR 0001, ticket 14 decision 2): the unmodified `codex` binary, `codex exec --json`, one process per
// attempt, started through the shared process layer, under whatever login the user's own `codex` has. Never the Codex
// SDK (it starts the process itself, so AHP could not own its PID or its tree) and never `codex app-server`.
//
// Cancelling is the process layer's: SIGTERM then a tree kill on Linux and macOS, a forced tree kill on Windows. Codex
// headless has no graceful stop.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, resolveExecutable } from "../../process/index.ts";
import { isOutputFieldName, levelOn, meetsLevel, sameOnEveryOs } from "../../protocol/index.ts";
import type { AgentRef } from "../../protocol/index.ts";
import type { Adapter, AttemptExit } from "../contract.ts";
import { outputSchemaFor } from "../output-schema.ts";
import { promptFor } from "../prompt.ts";
import { invocationFor } from "./args.ts";
import { codexHomeOf, sessionModel } from "./session.ts";
import { CodexStream } from "./stream.ts";

/** Codex's `model_reasoning_effort` values the adapter passes on; whether the model accepts one is the tool's answer (`minimal` is refused by `gpt-5.6-luna`, seen). */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export interface CodexOptions {
  /** Output fields to report on top of the ones the step requires. */
  reportFields?: string[];
  /** Text added to the prompt after the handoff's instructions. */
  extraInstructions?: string;
  /** Codex's `model_reasoning_effort`. Default: the tool's own. */
  effort?: (typeof CODEX_EFFORTS)[number];
  /** Where Codex keeps its login and session logs (`CODEX_HOME`). Default: the tool's own. */
  codexHome?: string;
}

/** Names the Codex adapter for a step. `model` is requested from the tool; Codex has no aliases, so it is a model name its login can use. */
export function codex(options: CodexOptions & { model?: string } = {}): AgentRef {
  const { model, ...rest } = options;
  return { adapter: "codex", ...(model === undefined ? {} : { model }), options: rest };
}

export const codexAdapter: Adapter = {
  // `read_only` is `-s read-only`, which on native Windows kept an agent that was asked to write from writing anywhere
  // (measured, ticket 16). Nothing is claimed on Linux and macOS, where it was not measured: `cooperative`. A path scope
  // cannot be given to a sandbox that is one mode for the workspace, and no_external_actions is asked in words, so both are
  // `cooperative`. The network stance is not applied: a request to a local listener got through under both modes on Windows.
  declaration: {
    name: "codex",
    mock: false,
    gracefulCancel: false,
    transport: "headless",
    modelReporting: "pass_through",
    login: "tool_login",
    capabilities: {
      read_only: { win32: "enforced_by_tool", darwin: "cooperative", linux: "cooperative" },
      write_scope: sameOnEveryOs("cooperative"),
      no_external_actions: sameOnEveryOs("cooperative"),
    },
    network: { deny: sameOnEveryOs("none"), package_registries: sameOnEveryOs("none") },
  },

  validateOptions(options) {
    if (options === undefined) return [];
    if (typeof options !== "object" || options === null || Array.isArray(options)) return ["codex options must be an object"];
    const known = ["reportFields", "extraInstructions", "effort", "codexHome"];
    const o = options as Record<string, unknown>;
    const problems = Object.keys(o).filter((key) => !known.includes(key)).map((key) => `codex option "${key}" is not one of ${known.join(", ")}`);
    if (o.reportFields !== undefined && !(Array.isArray(o.reportFields) && o.reportFields.every(isOutputFieldName))) problems.push("`reportFields` must be an array of output field names");
    if (o.extraInstructions !== undefined && typeof o.extraInstructions !== "string") problems.push("`extraInstructions` must be a string");
    if (o.effort !== undefined && !(CODEX_EFFORTS as readonly unknown[]).includes(o.effort)) problems.push(`\`effort\` must be one of ${CODEX_EFFORTS.join(", ")}`);
    if (o.codexHome !== undefined && !(typeof o.codexHome === "string" && o.codexHome !== "")) problems.push("`codexHome` must be a non-empty path");
    return problems;
  },

  // Called as a method, so an adapter built from this one under another declaration is held to its own.
  async startAttempt({ workspace, requestedModel, capabilities, handoff, options, transcript }) {
    // The contract: fail rather than apply a capability at a weaker level than the one recorded.
    const { declaration } = this;
    for (const { kind, level } of capabilities.capabilities) {
      const declared = levelOn(declaration.capabilities[kind], capabilities.platform);
      if (!meetsLevel(declared, level)) throw new Error(`codex adapter declares ${kind} "${declared}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }
    const { stance, level } = capabilities.network;
    const declaredNetwork = levelOn(declaration.network[stance], capabilities.platform);
    if (!meetsLevel(declaredNetwork, level)) {
      throw new Error(`codex adapter declares the "${stance}" stance "${declaredNetwork}" on ${capabilities.platform} and cannot apply it at "${level}"`);
    }

    const chosen = (options ?? {}) as CodexOptions;
    const reportFields = chosen.reportFields ?? [];
    const outputFields = [...new Set([...handoff.contract.acceptance.requiredOutputFields, ...reportFields])];
    // Outside the worktree, so it does not show up in the attempt's snapshot.
    const files = mkdtempSync(join(tmpdir(), "ahp-codex-"));
    const cleanUp = () => rmSync(files, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try {
      const schema = outputSchemaFor(outputFields);
      const schemaFile = join(files, "output-schema.json");
      if (schema) writeFileSync(schemaFile, JSON.stringify(schema));
      const args = invocationFor({
        applied: capabilities,
        workspace,
        requestedModel,
        outputSchemaFile: schema ? schemaFile : null,
        effort: chosen.effort,
        platform: capabilities.platform,
      });
      const executable = await resolveExecutable("codex");
      // Absolute: the agent runs in the worktree, AHP in its own directory, and both must find the same home.
      const env = chosen.codexHome ? { CODEX_HOME: resolve(chosen.codexHome) } : undefined;
      const agent = await launch({ executable, args, cwd: workspace, input: promptFor(handoff, reportFields, chosen.extraInstructions), env, transcript });

      const stream = new CodexStream();
      const reading = (async () => {
        agent.stdout.setEncoding("utf8");
        for await (const chunk of agent.stdout as AsyncIterable<string>) stream.write(chunk);
        stream.end();
      })();
      const exited = agent.exited.then(
        async ({ exitCode, signal }): Promise<AttemptExit> => {
          // A killed process ends its stdout, so this settles; a read error is the adapter losing contact.
          await reading;
          // The model is read from Codex's session log, and only for a turn in which the model answered: Codex logs the
          // model it was asked for even when the API refused it.
          const model = stream.answered && stream.threadId ? await sessionModel(codexHomeOf({ ...process.env, ...env }), stream.threadId) : null;
          return { exitCode, signal, ...stream.exit(exitCode), reportedModel: model };
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
