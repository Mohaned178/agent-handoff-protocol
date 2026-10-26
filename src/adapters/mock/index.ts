import { spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_ERROR_KINDS, STOP_REASONS } from "../../protocol/index.ts";
import type { AgentRef, AttemptError, OutputFieldValue, StopReason } from "../../protocol/index.ts";
import type { Adapter, AttemptExit } from "../contract.ts";

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
  /** The output fields the agent reports, by name. Defaults to none. */
  outputFields?: Record<string, OutputFieldValue>;
  /** Defaults to 0. */
  exitCode?: number;
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
  declaration: { name: "mock", mock: true },

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
      for (const flag of ["commit", "loseContact", "hang", "hangBeforeSpawn"] as const) {
        if (script?.[flag] !== undefined && typeof script[flag] !== "boolean") {
          problems.push(`mock attempt ${index + 1}: \`${flag}\` must be a boolean`);
        }
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

  async startAttempt({ attemptNumber, workspace, options }) {
    const script = (options as MockOptions).attempts[attemptNumber - 1];
    if (!script) throw new Error(`mock adapter has no script for attempt ${attemptNumber}`);
    // A promise alone would not keep the process alive; the timer does.
    if (script.hangBeforeSpawn) await new Promise(() => setInterval(() => undefined, 60_000));

    const child = spawn(process.execPath, [agentScript], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    const exited = new Promise<AttemptExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        if (script.loseContact) {
          reject(new Error("mock adapter lost contact with the agent (scripted)"));
          return;
        }
        // A crashed agent may have printed nothing: it reported no output.
        const report = Buffer.concat(stdout).toString("utf8");
        try {
          const parsed =
            report === ""
              ? undefined
              : (JSON.parse(report) as Pick<AttemptExit, "stopReason" | "error"> & { outputFields: AttemptExit["reportedOutput"] });
          resolve({
            exitCode,
            signal,
            reportedOutput: parsed?.outputFields ?? {},
            stopReason: parsed?.stopReason ?? null,
            error: parsed?.error ?? null,
          });
        } catch (error) {
          reject(new Error(`mock agent printed an unreadable report: ${report.slice(0, 200)}`, { cause: error }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdin.end(JSON.stringify(script));
    return { pid: child.pid!, exited };
  },
};
