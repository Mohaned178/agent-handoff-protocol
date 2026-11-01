// Tool calls counted from the `tool_call` entries of the activity log an attempt's adapter kept (`AttemptInput.activityLog`),
// or, for a run recorded before the activity log, from its tool-call log (`tool-calls/`). An attempt with no log has no
// count, which is not a count of 0.

import { readFile } from "node:fs/promises";
import { parseActivity } from "../adapters/activity.ts";
import type { AttemptView } from "../protocol/index.ts";
import { activityLogPath, locateRepo, toolCallLogPath } from "../runtime/index.ts";
import type { AttemptToolCalls, TrialToolCalls } from "./events.ts";

/**
 * The calls of one log: grouped by `toolCallId`, a call counting as the last status the tool gave it (`completed`, `failed`,
 * or neither when the log ends with it still pending). `refused` is the calls AHP answered `rejected` at any point, whatever
 * became of them after; it overlaps `failed`. A line a crash tore, or one that is not a tool call, is left out. `legacy`
 * reads a tool-call log, whose lines have no `type`.
 */
export function countToolCalls(text: string, legacy = false): Omit<AttemptToolCalls, "attemptId" | "adapter"> {
  const calls = new Map<string, { status: string | null; refused: boolean }>();
  for (const entry of parseActivity(text, legacy)) {
    if (entry.type !== "tool_call") continue;
    const call = calls.get(entry.toolCallId) ?? { status: null, refused: false };
    // A synthetic `permission_requested` line is no status the tool gave: it does not replace one.
    if (entry.status !== null && entry.status !== undefined && entry.status !== "permission_requested") call.status = entry.status;
    if (entry.permission === "rejected") call.refused = true;
    calls.set(entry.toolCallId, call);
  }
  const all = [...calls.values()];
  return {
    total: all.length,
    completed: all.filter((call) => call.status === "completed").length,
    failed: all.filter((call) => call.status === "failed").length,
    refused: all.filter((call) => call.refused).length,
  };
}

/** The text of an attempt's log, and whether it is an old tool-call log; null when it kept neither. */
async function logOf(location: Awaited<ReturnType<typeof locateRepo>>, runId: string, attemptId: string): Promise<{ text: string; legacy: boolean } | null> {
  for (const [file, legacy] of [[activityLogPath(location, runId, attemptId), false], [toolCallLogPath(location, runId, attemptId), true]] as const) {
    try {
      return { text: await readFile(file, "utf8"), legacy };
    } catch {
      // not kept there
    }
  }
  return null;
}

/** The trial's tool calls from the logs its attempts kept; null when none kept one. */
export async function toolCallsOf(repo: string, runId: string, attempts: readonly AttemptView[]): Promise<TrialToolCalls | null> {
  const location = await locateRepo(repo);
  const counted: AttemptToolCalls[] = [];
  for (const attempt of attempts) {
    const log = await logOf(location, runId, attempt.id);
    if (log === null) continue;
    counted.push({ attemptId: attempt.id, adapter: attempt.adapter, ...countToolCalls(log.text, log.legacy) });
  }
  if (counted.length === 0) return null;
  const sum = (part: "total" | "completed" | "failed" | "refused") => counted.reduce((total, attempt) => total + attempt[part], 0);
  return { total: sum("total"), completed: sum("completed"), failed: sum("failed"), refused: sum("refused"), attempts: counted };
}
