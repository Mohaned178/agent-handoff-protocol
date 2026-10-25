import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEvent, LedgerEventBody } from "../protocol/index.ts";

export { applyEvent, findAttempt, findHandoff, findVerification, LedgerInconsistentError, replay } from "./replay.ts";

/**
 * Appends events to a run's ledger: one JSONL file, opened once in append mode and flushed to disk
 * after every event. The file is append-only; nothing is ever rewritten or renamed (ADR 0006).
 */
export class LedgerWriter {
  #handle: FileHandle;
  #now: () => Date;
  #seq = 0;

  private constructor(handle: FileHandle, now: () => Date) {
    this.#handle = handle;
    this.#now = now;
  }

  /** Creates a new ledger file; fails if one already exists at `path`. Events are stamped with `now()`. */
  static async create(path: string, now: () => Date = () => new Date()): Promise<LedgerWriter> {
    await mkdir(dirname(path), { recursive: true });
    return new LedgerWriter(await open(path, "ax"), now);
  }

  /** Records `body` durably and returns the event as written. */
  async append(body: LedgerEventBody): Promise<LedgerEvent> {
    const event: LedgerEvent = { seq: this.#seq + 1, time: this.#now().toISOString(), ...body };
    await this.#handle.write(`${JSON.stringify(event)}\n`);
    await this.#handle.datasync();
    this.#seq = event.seq;
    return event;
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/** Reads every event in a ledger file, in append order. */
export async function readLedger(path: string): Promise<LedgerEvent[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch {
        throw new Error(`${path}: line ${index + 1} is not valid JSON`);
      }
    });
}
