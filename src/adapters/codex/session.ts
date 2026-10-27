// Codex's `exec --json` stream never names the model that ran; its session log does (`turn_context.model`, ticket 14 F4).
// This reads that one field and nothing else from the log: it is a conversation record in Codex's own home, not a
// credential, and every other line of it is skipped unparsed. (Not read: `session_meta`, which carries Codex's
// instructions, and every message.) What it finds is the model Codex recorded for the turn, the one it resolved from the
// request or, when none was requested, from its own default; Codex writes it even when the API then refuses the
// model, so the caller reports it only for a turn in which the model answered.

import { createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Where Codex keeps its state: `CODEX_HOME` if set, else `~/.codex`. */
export const codexHomeOf = (env: NodeJS.ProcessEnv): string => env.CODEX_HOME || join(homedir(), ".codex");

/** The newest `limit` day directories of `sessions/YYYY/MM/DD`, newest first (the folders follow the local date). */
function recentDays(sessions: string, limit: number): string[] {
  const names = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort().reverse();
    } catch {
      return [];
    }
  };
  const days: string[] = [];
  for (const year of names(sessions)) {
    for (const month of names(join(sessions, year))) {
      for (const day of names(join(sessions, year, month))) {
        days.push(join(sessions, year, month, day));
        if (days.length >= limit) return days;
      }
    }
  }
  return days;
}

const MAX_LINES = 200;

/**
 * The model Codex recorded for the thread, or null when the log is not found or has none. Looks in the newest three days
 * only: the attempt has just ended, and a thread id is looked up by exact name, never by pattern from outside.
 */
export async function sessionModel(codexHome: string, threadId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) return null;
  const sessions = join(codexHome, "sessions");
  for (const day of recentDays(sessions, 3)) {
    let names: string[];
    try {
      names = readdirSync(day);
    } catch {
      continue;
    }
    const file = names.find((name) => name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`));
    if (file) return modelIn(join(day, file));
  }
  return null;
}

async function modelIn(path: string): Promise<string | null> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    let read = 0;
    for await (const line of lines) {
      if (++read > MAX_LINES) return null;
      // Only a `turn_context` line is parsed.
      if (!line.includes('"turn_context"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null || (entry as { type?: unknown }).type !== "turn_context") continue;
      const payload = (entry as { payload?: unknown }).payload;
      const model = typeof payload === "object" && payload !== null ? (payload as { model?: unknown }).model : undefined;
      return typeof model === "string" && model.trim() !== "" ? model : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
  }
}
