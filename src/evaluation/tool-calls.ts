// Tool calls counted from the logs an attempt's adapter kept (`AttemptInput.toolCallLog`). Only a transport that reports tool
// calls keeps one (ACP, so OpenCode today): an attempt with no log has no count, which is not a count of 0.

import { readFile } from "node:fs/promises";
import type { AttemptView, ToolCallLogEntry } from "../protocol/index.ts";
import { locateRepo, toolCallLogPath } from "../runtime/index.ts";
import type { AttemptToolCalls, TrialToolCalls } from "./events.ts";

const isEntry = (value: unknown): value is ToolCallLogEntry =>
  typeof value === "object" && value !== null && typeof (value as ToolCallLogEntry).toolCallId === "string" && Array.isArray((value as ToolCallLogEntry).paths);

/**
 * The calls of one log: grouped by `toolCallId`, a call counting as the last status the tool gave it (`completed`, `failed`,
 * or neither when the log ends with it still pending). `refused` is the calls AHP answered `rejected` at any point, whatever
 * became of them after; it overlaps `failed`. A line a crash tore, or one that is not an entry, is left out.
 */
export function countToolCalls(text: string): Omit<AttemptToolCalls, "attemptId" | "adapter"> {
  const calls = new Map<string, { status: string | null; refused: boolean }>();
  for (const line of text.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isEntry(entry)) continue;
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

/** The trial's tool calls from the logs its attempts kept; null when none kept one. */
export async function toolCallsOf(repo: string, runId: string, attempts: readonly AttemptView[]): Promise<TrialToolCalls | null> {
  const location = await locateRepo(repo);
  const counted: AttemptToolCalls[] = [];
  for (const attempt of attempts) {
    let text: string;
    try {
      text = await readFile(toolCallLogPath(location, runId, attempt.id), "utf8");
    } catch {
      continue;
    }
    counted.push({ attemptId: attempt.id, adapter: attempt.adapter, ...countToolCalls(text) });
  }
  if (counted.length === 0) return null;
  const sum = (part: "total" | "completed" | "failed" | "refused") => counted.reduce((total, attempt) => total + attempt[part], 0);
  return { total: sum("total"), completed: sum("completed"), failed: sum("failed"), refused: sum("refused"), attempts: counted };
}
