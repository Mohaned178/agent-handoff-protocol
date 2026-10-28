import { access, readFile } from "node:fs/promises";
import type { AttemptView, LedgerEvent, RecoveryReport, RefChange, SharedRef, ToolCallLog, ToolCallLogEntry } from "../protocol/index.ts";
import { bounded, worktreeChanges } from "./scope.ts";
import { messageOf } from "./verification.ts";

/** How many of the events before an attempt was found unknown its report lists. */
const LAST_EVENTS = 10;

const UNDETERMINED =
  "Host and external effects are undetermined: AHP cannot see what the coding agent did outside its workspace and " +
  "the shared repository's refs, such as files elsewhere on this machine, global installs and caches, network calls, " +
  "pushes and pull requests.";

export interface RecoveryReportInput {
  /** The attempt, with the shared refs recorded before it was dispatched and when it was found unknown. */
  attempt: AttemptView;
  /** The step's base commit: the workspace's changes are measured from it. */
  base: string;
  /** The run's ledger events so far, the one that found the attempt unknown included. */
  events: readonly LedgerEvent[];
  /** The file the attempt's adapter was told to log its tool calls to, whether or not it did. */
  toolCallLog: string;
}

/**
 * Gathers what can be known about an attempt whose outcome is unknown: the events recorded before it was found so,
 * what its workspace holds now against the step's base commit, how the shared refs moved between the two snapshots
 * recorded for it, and the statement that host and external effects are undetermined. It changes nothing: whatever
 * is wrong with the workspace or the refs is reported in the report itself.
 */
export async function buildRecoveryReport({ attempt, base, events, toolCallLog }: RecoveryReportInput): Promise<RecoveryReport> {
  const found = events.findLastIndex((event) => event.type === "attempt_unknown" && event.attemptId === attempt.id);
  const before = found === -1 ? events : events.slice(0, found);
  const process =
    attempt.pid === null
      ? " Whether the agent's process started is not known."
      : ` The agent's process (PID ${attempt.pid} when it was recorded) may still be running.`;
  return {
    lastEvents: before.slice(-LAST_EVENTS).map(({ seq, time, type }) => ({ seq, time, type })),
    workspace: await workspaceDiff(attempt.workspace, base),
    refs: refDiff(attempt.refs),
    toolCallLog: await readToolCallLog(toolCallLog),
    undetermined: `${UNDETERMINED}${process}`,
  };
}

/**
 * The last entries of the log an attempt's adapter wrote while its agent ran; null when it wrote none (an adapter whose
 * transport reports no tool calls). A line a crash tore, or one that is not an entry, is left out.
 */
async function readToolCallLog(file: string): Promise<ToolCallLog | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const entries = text.split("\n").flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      return isToolCallLogEntry(entry) ? [entry] : [];
    } catch {
      return [];
    }
  });
  return { entries: entries.slice(-MAX_LOG_ENTRIES), truncated: entries.length > MAX_LOG_ENTRIES };
}

/** How many entries of the tool-call log a report lists: the last of them, which say what the agent was doing. */
const MAX_LOG_ENTRIES = 100;

const isToolCallLogEntry = (value: unknown): value is ToolCallLogEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ToolCallLogEntry).time === "string" &&
  typeof (value as ToolCallLogEntry).toolCallId === "string" &&
  Array.isArray((value as ToolCallLogEntry).paths);

async function workspaceDiff(path: string, base: string): Promise<RecoveryReport["workspace"]> {
  try {
    await access(path);
  } catch {
    return { path, exists: false, changed: [], truncated: false, error: null };
  }
  try {
    const { items, truncated } = bounded(await worktreeChanges(path, base));
    return { path, exists: true, changed: items, truncated, error: null };
  } catch (error) {
    return { path, exists: true, changed: [], truncated: false, error: messageOf(error) };
  }
}

function refDiff({ before, after }: AttemptView["refs"]): RecoveryReport["refs"] {
  if (!before || !after) {
    return { changed: [], truncated: false, error: `no snapshot of the shared refs was recorded ${before ? "after" : "before"} the attempt` };
  }
  const { items, truncated } = bounded(refChanges(before, after));
  return { changed: items, truncated, error: null };
}

/** The refs that were added, removed or moved between two snapshots, by name. */
export function refChanges(before: readonly SharedRef[], after: readonly SharedRef[]): RefChange[] {
  const then = new Map(before.map((ref) => [ref.name, ref.oid]));
  const now = new Map(after.map((ref) => [ref.name, ref.oid]));
  const names = [...new Set([...then.keys(), ...now.keys()])].sort();
  return names
    .filter((name) => then.get(name) !== now.get(name))
    .map((name) => ({ name, before: then.get(name) ?? null, after: now.get(name) ?? null }));
}
