import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { fakeToolsDir, installFakeTool } from "./fake-tools.ts";

/** A stream captured from `claude -p --output-format stream-json --verbose` 2.1.311, scrubbed of paths and ids. */
export const fixture = (name: "complete" | "not-logged-in" | "budget-exhausted"): string =>
  readFileSync(new URL(`../fixtures/claude-code/${name}.jsonl`, import.meta.url), "utf8");

/** What the fake `claude` saw, written for the test to read once the attempt has ended. */
export interface FakeClaudeCall {
  argv: string[];
  stdin: string;
  cwd: string;
  pwd: string | undefined;
  env: Record<string, string | undefined>;
  /** The content of the file `--settings` named, read while the process ran (the adapter removes it afterwards). */
  settings: unknown;
  settingsPath: string | null;
  policy: unknown;
  policyPath: string | null;
}

export interface FakeClaudeOptions {
  /** What it prints on stdout, as is. */
  stream: string;
  exitCode?: number;
  /** After printing, wait until killed. */
  hang?: boolean;
  /** Printed after a short wait, as a process killed in mid-line leaves it. */
  tornTail?: string;
}

/**
 * Installs a fake `claude` that records how it was called and prints a captured stream, and puts it first on this
 * process's PATH until `restore()`. The real `claude` is never run by a test.
 */
export function installFakeClaude(options: FakeClaudeOptions) {
  const { dir, log } = fakeToolsDir();
  const callFile = `${log}.call.json`;
  const body = `
    const argvText = argv;
    const at = (flag) => { const i = argvText.indexOf(flag); return i === -1 ? null : argvText[i + 1]; };
    const settingsPath = at("--settings");
    const readJson = (p) => { try { return p ? JSON.parse(fs.readFileSync(p, "utf8")) : null; } catch { return null; } };
    const settings = readJson(settingsPath);
    const hook = settings && settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0].hooks[0].command;
    const policyPath = hook ? /"([^"]+)"$/.exec(hook)[1] : null;
    fs.writeFileSync(${JSON.stringify(callFile)}, JSON.stringify({
      argv: argvText, stdin: Buffer.concat(chunks).toString(), cwd: process.cwd(), pwd: process.env.PWD,
      env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, settings, settingsPath, policy: readJson(policyPath), policyPath,
    }));
    process.stdout.write(${JSON.stringify(options.stream)});
    ${options.tornTail ? `process.stdout.write(${JSON.stringify(options.tornTail)});` : ""}
    ${options.hang ? "setInterval(() => {}, 60000);" : `process.exitCode = ${options.exitCode ?? 0};`}
  `;
  installFakeTool(dir, log, "claude", body);
  const before = process.env.PATH;
  process.env.PATH = [dir, before].join(delimiter);
  return {
    call: (): FakeClaudeCall => JSON.parse(readFileSync(callFile, "utf8")) as FakeClaudeCall,
    restore: () => {
      process.env.PATH = before;
    },
  };
}
