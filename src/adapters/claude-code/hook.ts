// The `PreToolUse` hook the Claude Code adapter registers for Claude Code's file-writing tools. Claude Code runs it as
// `node hook.ts <policy.json>` before each such call and reads the verdict from the exit code: 2 blocks the call and
// sends stderr back to the model as the tool's error, 0 lets it run. The payload arrives as JSON on stdin; its tool
// input names the file (`file_path`, or `notebook_path` for a notebook).
//
// The file stands alone (it imports only Node), because the adapter hands its path to a tool that runs it by itself.
// It guards the file tools only: a shell command can reach any path another way, which is why the adapter declares its
// capabilities `cooperative`.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** What the hook enforces for one attempt; the adapter writes it beside the settings, outside the workspace. */
export interface HookPolicy {
  /** The attempt's git worktree: no file tool may write outside it. */
  workspace: string;
  /** The step has `read_only`: no file tool may write at all. */
  readOnly: boolean;
  /** The step has `write_scope`: repository-relative paths (forward slashes) the file tools may write under. Null: anywhere in the workspace. */
  writeScope: string[] | null;
}

export type HookVerdict = { allow: true } | { allow: false; reason: string };

/** The tools whose calls change a file, by the name Claude Code gives them: the hook's matcher and the check below agree. */
export const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;
const PATH_INPUTS = ["file_path", "notebook_path"] as const;

/** The path with every existing part resolved (symlinks, junctions, 8.3 names, letter case), and the rest as written. */
function canonical(path: string): string {
  const missing: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // keep what was resolved
  }
  return join(real, ...missing);
}

/** Windows and macOS file systems ignore letter case by default. */
const foldsCase = (platform: string) => platform === "win32" || platform === "darwin";

/** `path` relative to `base` with forward slashes, or null when it is not inside `base` (or is `base`: ""). */
function within(base: string, path: string, platform: string): string | null {
  const fold = (value: string) => (foldsCase(platform) ? value.toLowerCase() : value);
  const from = relative(fold(base), fold(path));
  if (from === "") return "";
  if (from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)) return null;
  return from.split(sep).join("/");
}

export function decide(payload: unknown, policy: HookPolicy, platform: string = process.platform): HookVerdict {
  const call = (payload ?? {}) as { tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown };
  if (typeof call.tool_name !== "string" || !(WRITE_TOOLS as readonly string[]).includes(call.tool_name)) return { allow: true };
  const deny = (reason: string): HookVerdict => ({ allow: false, reason: `AHP: ${reason}` });
  if (policy.readOnly) return deny(`this step is read-only, so ${call.tool_name} may not change a file`);

  const given = PATH_INPUTS.map((name) => call.tool_input?.[name]).find((value) => typeof value === "string" && value !== "");
  // A write whose target cannot be read is refused, never let through.
  if (typeof given !== "string") return deny(`${call.tool_name} named no file path, so it cannot be checked`);
  const base = typeof call.cwd === "string" && call.cwd !== "" ? call.cwd : policy.workspace;
  const target = canonical(resolve(base, given));
  const workspace = canonical(policy.workspace);

  const inWorkspace = within(workspace, target, platform);
  if (inWorkspace === null) return deny(`${given} is outside this step's workspace`);
  if (inWorkspace === "") return deny(`${given} is the workspace itself`);
  // The worktree's own `.git` is how the shared repository is reached: a file tool has no business writing there.
  if (foldsCase(platform) ? /^\.git(\/|$)/i.test(inWorkspace) : /^\.git(\/|$)/.test(inWorkspace)) return deny(`${given} is under .git`);

  if (policy.writeScope) {
    const inScope = policy.writeScope.some((scope) => {
      const fold = (value: string) => (foldsCase(platform) ? value.toLowerCase() : value);
      return fold(inWorkspace) === fold(scope) || fold(inWorkspace).startsWith(`${fold(scope)}/`);
    });
    if (!inScope) return deny(`${given} is outside this step's write scope (${policy.writeScope.join(", ")})`);
  }
  return { allow: true };
}

// Runs as the entry point only: the adapter's tests import `decide`.
if (import.meta.main) {
  // Claude Code lets a call through when a hook fails with any code but 2, so anything that goes wrong here blocks.
  try {
    const policy = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as HookPolicy;
    const verdict = decide(JSON.parse(readFileSync(0, "utf8")), policy);
    if (!verdict.allow) {
      console.error(verdict.reason);
      process.exit(2);
    }
  } catch (error) {
    console.error(`AHP: the hook failed, so it blocked the call: ${(error as Error).message}`);
    process.exit(2);
  }
}
