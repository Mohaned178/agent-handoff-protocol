import { extname, isAbsolute } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { launch } from "../../process/index.ts";
import { ADAPTER_ERROR_KINDS, isUsageReport, sameOnEveryOs, STOP_REASONS } from "../../protocol/index.ts";
import type { AgentRef, AttemptError, OutputFieldValue, StopReason, UsageReport } from "../../protocol/index.ts";
import type { Adapter, AttemptExit } from "../contract.ts";

/** The usage a mock attempt reports, as a tool would: only the numbers it gives; the rest are not reported. */
export type MockUsage = Partial<Omit<UsageReport, "source">>;

import { MOCK_USAGE_SOURCE } from "./source.ts";

export { MOCK_USAGE_SOURCE };

/** Every number a usage report may hold, not reported. */
const NO_USAGE = { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null };

export interface MockEdit {
  /** Relative to the attempt's workspace. */
  path: string;
  content: string;
}

/** What the mock coding agent does in one attempt. */
export interface MockAttemptScript {
  /** Files or directories to remove, relative to the workspace; removed before `edits` are written. */
  deletes?: string[];
  edits?: MockEdit[];
  /** Commit the changes in the workspace, as a coding agent that commits its own work does. */
  commit?: boolean;
  /**
   * Git commands the agent runs in its workspace, each as its arguments, after its edits and commit: a push, a new
   * branch or tag, which only AHP may do. A command that fails makes the agent exit 2.
   */
  git?: string[][];
  /** The output fields the agent reports, by name. Defaults to none. */
  outputFields?: Record<string, OutputFieldValue>;
  /** Defaults to 0. */
  exitCode?: number;
  /** The model the agent reports having run. Defaults to none: the attempt's model is then `unknown`. */
  reportedModel?: string;
  /** The usage the agent reports, labelled as scripted. Defaults to none: nothing is reported, and nothing is estimated. */
  usage?: MockUsage;
  /** Why the agent's turn ended, as an adapter would report it. Defaults to none. */
  stopReason?: StopReason;
  /** An error the adapter saw, as it would report it: a rate limit is `transient`, a missing login `config_auth`. Defaults to none. */
  error?: AttemptError;
  /**
   * The adapter loses contact with the agent once it has run: it cannot say how the attempt ended, as when a
   * transport's connection drops, so the attempt's outcome is unknown.
   */
  loseContact?: boolean;
  /** The agent makes its edits and commit, then never exits: it hangs until something kills it. */
  hang?: boolean;
  /**
   * The adapter never spawns the agent: starting the attempt never settles, so the runtime waits after recording
   * that it is dispatching it, until something kills the runtime.
   */
  hangBeforeSpawn?: boolean;
  /**
   * The agent starts a grandchild process, which ignores every termination signal and runs until it is killed (ten
   * minutes at most), before it makes its edits: so a test can check that a cancel leaves no process of the tree behind.
   */
  spawnGrandchild?: boolean;
  /** The agent ignores SIGTERM, SIGINT and SIGHUP: only a kill stops it. */
  ignoreSignals?: boolean;
  /** An absolute path the agent writes its own PID and its grandchild's to, one per line, once it has started both. */
  pidFile?: string;
}

export interface MockOptions {
  /** One script per attempt, in attempt order. */
  attempts: MockAttemptScript[];
}

/** Names the mock adapter for a step, scripted per attempt. */
export function mock(options: MockOptions): AgentRef {
  return { adapter: "mock", options };
}

// Runs as `.ts` from source and as `.js` once built.
const agentScript = fileURLToPath(new URL(`./agent${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

export const mockAdapter: Adapter = {
  // The mock agent is told what is asked of it and does nothing about it, so it declares no more than `cooperative`: a
  // script may do what it was asked not to, which is how the tests exercise verification. Its network use is not
  // controlled at all.
  declaration: {
    name: "mock",
    mock: true,
    gracefulCancel: false,
    transport: "mock",
    modelReporting: "pass_through",
    login: "none",
    capabilities: {
      read_only: sameOnEveryOs("cooperative"),
      write_scope: sameOnEveryOs("cooperative"),
      no_external_actions: sameOnEveryOs("cooperative"),
    },
    network: { deny: sameOnEveryOs("none"), package_registries: sameOnEveryOs("none") },
  },

  validateOptions(options) {
    const attempts = (options as Partial<MockOptions> | undefined)?.attempts;
    if (!Array.isArray(attempts) || attempts.length === 0) {
      return ["mock adapter options need a non-empty `attempts` array of attempt scripts"];
    }
    const problems: string[] = [];
    attempts.forEach((script: MockAttemptScript, index) => {
      if (script?.deletes !== undefined && !(Array.isArray(script.deletes) && script.deletes.every((p) => typeof p === "string"))) {
        problems.push(`mock attempt ${index + 1}: \`deletes\` must be an array of paths`);
      }
      for (const flag of ["commit", "loseContact", "hang", "hangBeforeSpawn", "spawnGrandchild", "ignoreSignals"] as const) {
        if (script?.[flag] !== undefined && typeof script[flag] !== "boolean") {
          problems.push(`mock attempt ${index + 1}: \`${flag}\` must be a boolean`);
        }
      }
      const commands = script?.git;
      if (commands !== undefined && !(Array.isArray(commands) && commands.every((args) => Array.isArray(args) && args.every((arg) => typeof arg === "string")))) {
        problems.push(`mock attempt ${index + 1}: \`git\` must be an array of commands, each an array of arguments`);
      }
      if (script?.pidFile !== undefined && !(typeof script.pidFile === "string" && isAbsolute(script.pidFile))) {
        problems.push(`mock attempt ${index + 1}: \`pidFile\` must be an absolute path`);
      }
      for (const edit of script?.edits ?? []) {
        if (typeof edit?.path !== "string" || typeof edit.content !== "string") {
          problems.push(`mock attempt ${index + 1}: each edit needs a string \`path\` and \`content\``);
        }
      }
      for (const [name, value] of Object.entries(script?.outputFields ?? {})) {
        const isText = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
        if (!isText) problems.push(`mock attempt ${index + 1}: output field "${name}" must be a string or an array of strings`);
      }
      if (script?.exitCode !== undefined && !Number.isInteger(script.exitCode)) {
        problems.push(`mock attempt ${index + 1}: \`exitCode\` must be an integer`);
      }
      if (script?.reportedModel !== undefined && !(typeof script.reportedModel === "string" && script.reportedModel.trim() !== "")) {
        problems.push(`mock attempt ${index + 1}: \`reportedModel\` must be a non-empty string`);
      }
      if (script?.usage !== undefined) {
        const reported = { source: MOCK_USAGE_SOURCE, ...NO_USAGE, ...script.usage };
        const unknownKeys = Object.keys(script.usage).filter((key) => !(key in NO_USAGE));
        if (unknownKeys.length > 0 || !isUsageReport(reported)) {
          problems.push(
            `mock attempt ${index + 1}: \`usage\` needs at least one of ${Object.keys(NO_USAGE).join(", ")} (non-negative numbers; a cost has an amount and a currency)`,
          );
        }
      }
      if (script?.stopReason !== undefined && !STOP_REASONS.includes(script.stopReason)) {
        problems.push(`mock attempt ${index + 1}: \`stopReason\` must be one of ${STOP_REASONS.join(", ")}`);
      }
      if (script?.error !== undefined) {
        const { kind, message } = script.error as Partial<AttemptError>;
        if (!ADAPTER_ERROR_KINDS.includes(kind as AttemptError["kind"]) || typeof message !== "string") {
          problems.push(`mock attempt ${index + 1}: \`error\` needs a \`kind\` (${ADAPTER_ERROR_KINDS.join(", ")}) and a string \`message\``);
        }
      }
    });
    return problems;
  },

  async startAttempt({ attemptNumber, workspace, options, capabilities }) {
    const script = (options as MockOptions).attempts[attemptNumber - 1];
    if (!script) throw new Error(`mock adapter has no script for attempt ${attemptNumber}`);
    // A promise alone would not keep the process alive; the timer does.
    if (script.hangBeforeSpawn) await new Promise(() => setInterval(() => undefined, 60_000));

    const agent = await launch({
      executable: { file: process.execPath, prefixArgs: [], via: "executable", path: process.execPath },
      args: [agentScript],
      cwd: workspace,
      // The agent is told what is asked of it, which is all `cooperative` means; it does nothing more about it.
      input: JSON.stringify({ ...script, asked: capabilities }),
    });
    const report = text(agent.stdout);
    const exited = agent.exited.then(async ({ exitCode, signal }): Promise<AttemptExit> => {
      if (script.loseContact) throw new Error("mock adapter lost contact with the agent (scripted)");
      // A crashed or killed agent may have printed nothing: it reported no output.
      const printed = await report;
      let parsed: (Pick<AttemptExit, "stopReason" | "error" | "reportedModel" | "usage"> & { outputFields: AttemptExit["reportedOutput"] }) | undefined;
      try {
        parsed = printed === "" ? undefined : JSON.parse(printed);
      } catch (error) {
        throw new Error(`mock agent printed an unreadable report: ${printed.slice(0, 200)}`, { cause: error });
      }
      return {
        exitCode,
        signal,
        reportedOutput: parsed?.outputFields ?? {},
        stopReason: parsed?.stopReason ?? null,
        error: parsed?.error ?? null,
        reportedModel: parsed?.reportedModel ?? null,
        usage: parsed?.usage ?? null,
      };
    });
    return { pid: agent.pid, exited, cancel: ({ graceMs }) => agent.terminate({ graceMs }) };
  },
};
