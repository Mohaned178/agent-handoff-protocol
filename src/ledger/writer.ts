import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEventBody, LockOwner } from "../protocol/index.ts";
import { whileBusy } from "./busy.ts";
import { eventHash, readCheckedLedger, type ChainedEvent, type EventBody } from "./chain.ts";
import { acquireLock, LedgerLockedError, lockPathOf, releaseLock, removeStaleLock } from "./lock.ts";

/** The fields every event has beyond its body's, which the ledger sets. */
const RESERVED_FIELDS = ["seq", "prevHash", "time", "hash"];

export interface OpenLedgerOptions {
  /**
   * Take a stale lock over (one whose process is no longer running) instead of refusing it, as a recovering
   * process does when a person has asked it to continue the run. A lock held by a running process, one on another
   * host and one that names no owner are refused all the same.
   */
  takeOverStale?: boolean;
}

/**
 * Appends events to a run's ledger: one JSONL file, opened once in append mode and flushed to disk after every
 * event. The file is append-only; nothing is ever rewritten or renamed (ADR 0006). A writer holds the run's lock
 * from the moment it is made until it is closed, so only one process writes a run. The events are `LedgerEventBody`s,
 * or another ledger's bodies (the evaluation's) given as `B`, which must include `ledger_truncated`: opening a ledger that
 * ends in a torn tail records it as that.
 */
export class LedgerWriter<B extends EventBody = LedgerEventBody> {
  #handle: FileHandle;
  #lockPath: string;
  /** What this writer wrote into the lock file; the file is removed on close only while it still says so. */
  #owner: LockOwner;
  #now: () => Date;
  #seq = 0;
  #lastHash: string | null = null;
  /** Set when an append failed: what reached the file is unknown, so nothing more is appended. */
  #failed: Error | null = null;

  private constructor(handle: FileHandle, lockPath: string, owner: LockOwner, now: () => Date) {
    this.#handle = handle;
    this.#lockPath = lockPath;
    this.#owner = owner;
    this.#now = now;
  }

  /**
   * Takes the run's lock and creates its ledger file; fails if either exists. Events are stamped with `now()`.
   */
  static async create<B extends EventBody = LedgerEventBody>(path: string, now: () => Date = () => new Date()): Promise<LedgerWriter<B>> {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = lockPathOf(path);
    const owner = await acquireLock(lockPath);
    try {
      return new LedgerWriter<B>(await whileBusy(() => open(path, "ax")), lockPath, owner, now);
    } catch (error) {
      await releaseLock(lockPath, owner);
      throw error;
    }
  }

  /**
   * Takes the run's lock and opens its existing ledger to append to it, after checking the whole hash chain. A
   * torn tail (a last line a write did not finish) is truncated, and the truncation recorded as the next event.
   * Returns the writer, the ledger's events (that one included) and, if a stale lock was taken over, whose it was.
   * Throws `LedgerLockedError` if another process holds the lock or, unless `takeOverStale` is set, left it behind,
   * and `LedgerCorruptError` if the chain is broken.
   */
  static async open<B extends EventBody = LedgerEventBody>(
    path: string,
    now: () => Date = () => new Date(),
    options: OpenLedgerOptions = {},
  ): Promise<{ writer: LedgerWriter<B>; events: ChainedEvent<B>[]; takenOverFrom: LockOwner | null }> {
    const lockPath = lockPathOf(path);
    const { owner, takenOverFrom } = await takeLock(lockPath, options);
    let writer: LedgerWriter<B> | undefined;
    try {
      const read = await readCheckedLedger<B>(path);
      const last = read.events.at(-1);
      // A ledger whose first event was never completed holds no run.
      if (!last) throw new Error(`${path} holds no complete event`);
      if (read.tornTail) {
        // A handle of its own: on Windows a handle opened to append cannot truncate.
        const handle = await whileBusy(() => open(path, "r+"));
        try {
          await handle.truncate(read.validBytes);
          await handle.datasync();
        } finally {
          await handle.close();
        }
      }
      writer = new LedgerWriter<B>(await whileBusy(() => open(path, "a")), lockPath, owner, now);
      writer.#seq = last.seq;
      writer.#lastHash = last.hash;
      const events = [...read.events];
      if (read.tornTail) events.push(await writer.append({ type: "ledger_truncated", droppedBytes: read.tornTail.bytes } as unknown as B));
      return { writer, events, takenOverFrom };
    } catch (error) {
      if (writer) await writer.close();
      else await releaseLock(lockPath, owner);
      throw error;
    }
  }

  /** Records `body` durably, chained to the event before it, and returns the event exactly as a reader parses it. */
  async append(body: B): Promise<ChainedEvent<B>> {
    if (this.#failed) throw new Error("an earlier append to this ledger failed, so nothing more is appended", { cause: this.#failed });
    // The ledger sets these itself. A body field of the same name would corrupt the event, not be ignored: `seq`, `prevHash` and
    // `time` would override the ledger's, and `hash` would be overwritten by the chain hash, silently.
    for (const reserved of RESERVED_FIELDS) {
      if (reserved in body) throw new Error(`an event body may not have a \`${reserved}\` field: the ledger keeps that name for itself`);
    }
    // Hash the plain JSON that is written, so a reader that parses the line computes the same hash.
    const unhashed = JSON.parse(
      JSON.stringify({ seq: this.#seq + 1, prevHash: this.#lastHash, time: this.#now().toISOString(), ...body }),
    ) as Omit<ChainedEvent<B>, "hash">;
    const event = { ...unhashed, hash: eventHash(unhashed) } as ChainedEvent<B>;
    const line = Buffer.from(`${JSON.stringify(event)}\n`);
    try {
      // One write per event, never retried: a write that stopped partway leaves a torn tail, which the next
      // process to open the ledger truncates. Writing the rest, or the whole line again, could garble it.
      const { bytesWritten } = await this.#handle.write(line);
      if (bytesWritten !== line.length) throw new Error(`wrote ${bytesWritten} of ${line.length} bytes of event ${event.seq}`);
      await this.#handle.datasync();
    } catch (error) {
      this.#failed = error as Error;
      throw error;
    }
    this.#seq = event.seq;
    this.#lastHash = event.hash;
    return event;
  }

  /** Closes the ledger file and releases the run's lock, unless another process has taken it since. */
  async close(): Promise<void> {
    try {
      await this.#handle.close();
    } finally {
      await releaseLock(this.#lockPath, this.#owner);
    }
  }
}

/** Takes the lock at `lockPath`, first removing a stale one if `options` allow it; says whose stale lock that was. */
async function takeLock(lockPath: string, options: OpenLedgerOptions): Promise<{ owner: LockOwner; takenOverFrom: LockOwner | null }> {
  try {
    return { owner: await acquireLock(lockPath), takenOverFrom: null };
  } catch (error) {
    if (!options.takeOverStale || !(error instanceof LedgerLockedError) || error.lock.state !== "stale") throw error;
    const stale = error.lock.owner;
    await removeStaleLock(lockPath, stale);
    return { owner: await acquireLock(lockPath), takenOverFrom: stale };
  }
}
