import { spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRef } from "../../protocol/index.ts";
import type { Adapter, AttemptExit } from "../contract.ts";

export interface MockEdit {
  /** Relative to the attempt's workspace. */
  path: string;
  content: string;
}

/** What the mock coding agent does in one attempt. */
export interface MockAttemptScript {
  edits?: MockEdit[];
  /** Defaults to 0. */
  exitCode?: number;
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
      for (const edit of script?.edits ?? []) {
        if (typeof edit?.path !== "string" || typeof edit.content !== "string") {
          problems.push(`mock attempt ${index + 1}: each edit needs a string \`path\` and \`content\``);
        }
      }
      if (script?.exitCode !== undefined && !Number.isInteger(script.exitCode)) {
        problems.push(`mock attempt ${index + 1}: \`exitCode\` must be an integer`);
      }
    });
    return problems;
  },

  async startAttempt({ attemptNumber, workspace, options }) {
    const script = (options as MockOptions).attempts[attemptNumber - 1];
    if (!script) throw new Error(`mock adapter has no script for attempt ${attemptNumber}`);

    const child = spawn(process.execPath, [agentScript], {
      cwd: workspace,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const exited = new Promise<AttemptExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdin.end(JSON.stringify(script));
    return { pid: child.pid!, exited };
  },
};
