import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { whileBusy } from "./busy.ts";

/** The process that holds a run's ledger lock, and so is the one process writing the run. */
export interface LockOwner {
  host: string;
  pid: number;
  /** When the process started (ISO). With the PID it tells the owner apart from a later process given the same PID. */
  startedAt: string;
}

/** What a run's ledger lock says about who is writing the run. */
export type LockState =
  | { state: "free" }
  /** The owner is running on this host: it is writing the run. */
  | { state: "held"; owner: LockOwner }
  /** The owner is no longer running and never released the lock: it stopped partway, and the run needs recovery. */
  | { state: "stale"; owner: LockOwner }
  /** The owner is on another host, so whether it is still running cannot be checked from here. */
  | { state: "other_host"; owner: LockOwner }
  /** The lock file names no owner: it is still being written, or the process writing it stopped first. */
  | { state: "unreadable" };

/** A lock taken by some other process, or left behind by one: this process may not write the run. */
export class LedgerLockedError extends Error {
  override name = "LedgerLockedError";
  readonly lock: Exclude<LockState, { state: "free" }>;
  constructor(path: string, lock: Exclude<LockState, { state: "free" }>) {
    super(`${path}: ${describeLock(lock)}`);
    this.lock = lock;
  }
}

/** One sentence on who holds a lock and what that means for the run. */
function describeLock(lock: Exclude<LockState, { state: "free" }>): string {
  if (lock.state === "unreadable") {
    return "the lock file names no owner: it is still being written, or the process writing it stopped first";
  }
  const { pid, host, startedAt } = lock.owner;
  const owner = `lock held by PID ${pid} on ${host} (started ${startedAt})`;
  switch (lock.state) {
    case "held":
      return `${owner}, which is running: only one process writes a run`;
    case "stale":
      return `${owner}, which is no longer running: it stopped without releasing the lock, so the run needs recovery; AHP never takes a stale lock over by itself`;
    case "other_host":
      return `${owner}: another host, so AHP cannot tell whether it is still running`;
  }
}

/** The lock file of the ledger at `ledgerPath`. */
export const lockPathOf = (ledgerPath: string) => join(dirname(ledgerPath), "ledger.lock");

const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

/**
 * Takes the lock at `path` for this process by creating the lock file exclusively and writing this process
 * into it. Throws `LedgerLockedError` if the file exists, whoever left it: a stale lock is never taken over.
 */
export async function acquireLock(path: string): Promise<void> {
  const owner: LockOwner = { host: hostname(), pid: process.pid, startedAt: processStartedAt };
  for (let tries = 1; ; tries++) {
    let handle: FileHandle;
    try {
      handle = await whileBusy(() => open(path, "wx"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = await readLockState(path);
      // Released between the two looks: take it if it is still free.
      if (lock.state === "free" && tries < 3) continue;
      if (lock.state === "free") throw error;
      throw new LedgerLockedError(path, lock);
    }
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.datasync();
    } catch (error) {
      await handle.close();
      await releaseLock(path);
      throw error;
    }
    await handle.close();
    return;
  }
}

/** Releases a lock this process holds. */
export async function releaseLock(path: string): Promise<void> {
  try {
    await whileBusy(() => unlink(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Reads the lock at `path` and, for an owner on this host, checks whether it is still running. */
export async function readLockState(path: string): Promise<LockState> {
  let text: string;
  try {
    text = await whileBusy(() => readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "free" };
    throw error;
  }
  const owner = parseOwner(text);
  if (!owner) return { state: "unreadable" };
  if (owner.host !== hostname()) return { state: "other_host", owner };
  // This process's own PID, with another start time, was an earlier process's: that one has ended, since no two
  // running processes share a PID.
  if (owner.pid === process.pid) return { state: owner.startedAt === processStartedAt ? "held" : "stale", owner };
  return { state: isRunning(owner.pid) ? "held" : "stale", owner };
}

function parseOwner(text: string): LockOwner | null {
  try {
    const { host, pid, startedAt } = JSON.parse(text) as Partial<LockOwner>;
    const valid = typeof host === "string" && Number.isInteger(pid) && pid! > 0 && typeof startedAt === "string";
    return valid ? { host, pid: pid!, startedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a process with this PID is running on this host. Only "no such process" counts as not running: any
 * other answer (such as no permission to signal it) means it is there. A PID reused by an unrelated process
 * reads as running; AHP reports it rather than guessing.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
