// Follows a run's files as they grow: the ledger and each attempt's activity log, read from where the last read stopped
// (never from the start again), the lock, and when each running attempt's raw output last grew. `fs.watch` wakes it at
// once; a 250 ms poll is the fallback, as a watch can miss changes on Windows drives. It keeps only what the files say:
// the screen reads its state from here, so it opens a run started in any process.

import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { parseActivity } from "../adapters/activity.ts";
import { advanceCursor, LEDGER_START, readLedgerFrom, type LedgerCursor } from "../ledger/chain.ts";
import { lockPathOf, readLockState, type LockState } from "../ledger/lock.ts";
import { replay } from "../ledger/replay.ts";
import type { ActivityEntry, LedgerEvent, RunView } from "../protocol/index.ts";
import { activityLogPath, ledgerPath, locateRepo, toolCallLogPath, transcriptPaths, type RepoLocation } from "../runtime/paths.ts";

export const POLL_MS = 250;

/** What a follower has read; a new object each time anything changed, so a screen can tell. */
export interface FollowedRun {
  location: RepoLocation;
  events: readonly LedgerEvent[];
  state: RunView | null;
  activity: Readonly<Record<string, readonly ActivityEntry[]>>;
  lastOutput: Readonly<Record<string, number>>;
  lock: LockState | null;
  /** Why the ledger cannot be read or followed; the state stays what it was before. */
  problem: string | null;
}

export interface RunFollower {
  current: () => FollowedRun;
  /** Reads what changed now, and resolves once it has. */
  refresh: () => Promise<void>;
  close: () => void;
}

interface LogCursor {
  /** Bytes consumed: up to the last whole line read. */
  offset: number;
  entries: ActivityEntry[];
  /** True once the activity log was found missing and the old tool-call log is followed instead. */
  legacy: boolean;
}

/** The bytes of `path` from `offset` to its end, or null when it does not exist. */
async function readFrom(path: string, offset: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return Buffer.alloc(0);
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface FollowOptions {
  /** Any directory inside the run's repository. */
  repo: string;
  runId: string;
  /** Called after a read that changed anything. */
  onChange?: (run: FollowedRun) => void;
  pollMs?: number;
}

export async function followRun({ repo, runId, onChange, pollMs = POLL_MS }: FollowOptions): Promise<RunFollower> {
  const location = await locateRepo(repo);
  const path = ledgerPath(location, runId);
  let cursor: LedgerCursor = LEDGER_START;
  let events: LedgerEvent[] = [];
  const logs = new Map<string, LogCursor>();
  let run: FollowedRun = { location, events, state: null, activity: {}, lastOutput: {}, lock: null, problem: null };
  let closed = false;
  let reading: Promise<void> | null = null;
  let again = false;

  const readLedger = async (): Promise<{ changed: boolean; problem: string | null }> => {
    let read;
    try {
      read = await readLedgerFrom(path, cursor);
    } catch (error) {
      return { changed: false, problem: (error as Error).message };
    }
    if (read === null) {
      // The file is shorter than what was read of it: it was not appended to, so it is read again from the start.
      cursor = LEDGER_START;
      events = [];
      return readLedger();
    }
    if (read.corruption) return { changed: read.events.length > 0, problem: `${path}: ${read.corruption.message}; the ledger is corrupt from there on, so nothing after it is shown` };
    if (read.events.length === 0) return { changed: false, problem: null };
    cursor = advanceCursor(cursor, read);
    events = [...events, ...read.events];
    return { changed: true, problem: null };
  };

  const readLog = async (attemptId: string): Promise<boolean> => {
    const log = logs.get(attemptId) ?? { offset: 0, entries: [], legacy: false };
    logs.set(attemptId, log);
    let bytes = await readFrom(log.legacy ? toolCallLogPath(location, runId, attemptId) : activityLogPath(location, runId, attemptId), log.offset);
    if (bytes === null && !log.legacy && log.offset === 0) {
      const old = await readFrom(toolCallLogPath(location, runId, attemptId), 0);
      if (old !== null) {
        log.legacy = true;
        bytes = old;
      }
    }
    if (bytes === null || bytes.length === 0) return false;
    // Only whole lines: the rest is a line being written, read again once its newline is there.
    const end = bytes.lastIndexOf(0x0a);
    if (end === -1) return false;
    log.offset += end + 1;
    const fresh = parseActivity(bytes.toString("utf8", 0, end + 1), log.legacy);
    if (fresh.length === 0) return false;
    log.entries = [...log.entries, ...fresh];
    return true;
  };

  const read = async () => {
    const ledger = await readLedger();
    let state = run.state;
    let problem = ledger.problem;
    if (ledger.changed) {
      try {
        state = replay(events);
      } catch (error) {
        problem = (error as Error).message;
      }
    }
    let changed = ledger.changed || problem !== run.problem;
    const attempts = state?.steps.flatMap((step) => step.attempts) ?? [];
    for (const attempt of attempts) {
      // From where it was read last: a few bytes a tick at most, and nothing once the attempt has ended.
      if (await readLog(attempt.id).catch(() => false)) changed = true;
    }
    const lastOutput: Record<string, number> = { ...run.lastOutput };
    for (const attempt of attempts.filter((candidate) => candidate.state === "running" || candidate.state === "dispatching")) {
      const at = await stat(transcriptPaths(location, runId, attempt.id).output).then((info) => info.mtimeMs, () => null);
      if (at !== null && at !== lastOutput[attempt.id]) {
        lastOutput[attempt.id] = at;
        changed = true;
      }
    }
    let lock = run.lock;
    if (state === null || state.endedAt === null || lock === null) {
      const next = await readLockState(lockPathOf(path)).catch((): LockState => ({ state: "unreadable" }));
      if (JSON.stringify(next) !== JSON.stringify(lock)) {
        lock = next;
        changed = true;
      }
    }
    if (!changed) return;
    const activity: Record<string, readonly ActivityEntry[]> = {};
    for (const [id, log] of logs) activity[id] = log.entries;
    run = { location, events, state, activity, lastOutput, lock, problem };
    if (!closed) onChange?.(run);
  };

  // One read at a time; a wake during one reads once more after it.
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          await read();
        } while (again && !closed);
      } finally {
        reading = null;
      }
    })();
    return reading;
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dirname(path), { recursive: true }, () => void refresh());
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }
  const timer = setInterval(() => void refresh(), pollMs);
  await refresh();
  return {
    current: () => run,
    refresh,
    close: () => {
      closed = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}
