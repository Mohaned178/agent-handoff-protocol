import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LockOwner } from "../protocol/index.ts";
import { whileBusy } from "./busy.ts";

export type { LockOwner };

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

/** A lock some process took, whether or not it is still running. */
export type TakenLock = Exclude<LockState, { state: "free" }>;

/** A lock taken by some other process, or left behind by one: this process may not write the run. */
export class LedgerLockedError extends Error {
  override name = "LedgerLockedError";
  readonly lock: TakenLock;
  constructor(path: string, lock: TakenLock) {
    super(`${path}: ${describeLock(lock)}`);
    this.lock = lock;
  }
}

/** One sentence on who holds a lock and what that means for the run. */
function describeLock(lock: TakenLock): string {
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

/**
 * When this process started, from the wall clock less its uptime. Every module instance and thread in the process
 * works it out for itself, and the two clocks are read a moment apart, so readings agree only to within a margin.
 */
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const START_TIME_MARGIN_MS = 1000;

/**
 * Takes the lock at `path` for this process by creating the lock file exclusively and writing this process
 * into it, and returns what it wrote. Throws `LedgerLockedError` if the file exists, whoever left it: a stale lock
 * is never taken over here.
 */
export async function acquireLock(path: string): Promise<LockOwner> {
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
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A lock this process could not finish taking must not stay behind naming it.
      await releaseLock(path);
      throw error;
    }
    return owner;
  }
}

/**
 * Releases a lock this process holds. Given the `owner` it wrote, it removes the file only while the file still
 * names that owner, so a lock some other process has taken since is left alone.
 */
export async function releaseLock(path: string, owner?: LockOwner): Promise<void> {
  try {
    if (owner && !isDeepStrictEqual(parseOwner(await whileBusy(() => readFile(path, "utf8"))), owner)) return;
    await whileBusy(() => unlink(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Removes a stale lock that names `owner`, the process a caller found gone, so that a recovering process can take
 * the run over explicitly. The lock is read again first: if it no longer names that owner, or that owner is
 * running after all, nothing is removed and `LedgerLockedError` says who holds it now.
 */
export async function removeStaleLock(path: string, owner: LockOwner): Promise<void> {
  const lock = await readLockState(path);
  if (lock.state === "free") return;
  if (lock.state !== "stale" || !isDeepStrictEqual(lock.owner, owner)) throw new LedgerLockedError(path, lock);
  await releaseLock(path, owner);
}

/**
 * Removes the lock at `path` if it is stale, for a run that no process is to write again, and returns whose it
 * was; any other lock is left alone and null returned.
 */
export async function clearStaleLock(path: string): Promise<LockOwner | null> {
  const lock = await readLockState(path);
  if (lock.state !== "stale") return null;
  await removeStaleLock(path, lock.owner);
  return lock.owner;
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
  // This process's own PID, with a start time well apart from its own, was an earlier process's: that one has ended,
  // since no two running processes share a PID. Windows gives a freed PID to the next process quickly, and that can
  // be the next AHP command. Within the margin it is read as this process's own lock, which errs on the safe side.
  if (owner.pid === process.pid) {
    const apart = Math.abs(Date.parse(owner.startedAt) - Date.parse(processStartedAt));
    return { state: apart > START_TIME_MARGIN_MS ? "stale" : "held", owner };
  }
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
