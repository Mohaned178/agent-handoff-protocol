import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import type { LedgerEventBody } from "../protocol/index.ts";
import { whileBusy } from "./busy.ts";

/** What any ledger's body must have: a `type`. The run ledger's bodies are `LedgerEventBody`; the evaluation ledger has its own. */
export type EventBody = { type: string };

/**
 * An event as a hash-chained ledger holds it: the body plus its sequence number (from 1), the previous event's hash (null
 * for the first), its ISO timestamp, and its own hash. `ChainedEvent<LedgerEventBody>` is `LedgerEvent`.
 */
export type ChainedEvent<B extends EventBody = LedgerEventBody> = { seq: number; prevHash: string | null; time: string; hash: string } & B;

/**
 * The canonical JSON of a JSON value: object keys sorted (by UTF-16 code unit, as `Array.prototype.sort` does),
 * no whitespace. Written as a string rather than through an intermediate object, so a key such as `__proto__`
 * (an agent can report any output field name) is serialized like any other.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An event's hash: SHA-256 (lowercase hex) over the canonical JSON of the event without its own `hash` field. */
export function eventHash(event: Readonly<Record<string, unknown>>): string {
  const { hash: _, ...unhashed } = event;
  return createHash("sha256").update(canonicalJson(unhashed)).digest("hex");
}

/** The first line at which a ledger stops checking out. Nothing from there on is trusted. */
export interface LedgerCorruption {
  /** From 1. */
  line: number;
  kind: "unreadable" | "out_of_sequence" | "broken_chain";
  /** What is wrong, naming the line and, where it has one, the event. */
  message: string;
}

/** A ledger file as read and checked. */
export interface LedgerRead<B extends EventBody = LedgerEventBody> {
  /** The events whose sequence and hash chain check out, in append order: all of them, or those before the corruption. */
  events: ChainedEvent<B>[];
  /** How many bytes of the file those events take up, newlines included. */
  validBytes: number;
  /**
   * A last line that a write did not finish: it has no newline, or it is not JSON. It was never recorded, so it is
   * not part of the run; the next process to open the ledger for writing truncates it.
   */
  tornTail: { bytes: number } | null;
  corruption: LedgerCorruption | null;
}

/** A ledger whose sequence or hash chain is broken: no state derived from it can be trusted. */
export class LedgerCorruptError extends Error {
  override name = "LedgerCorruptError";
  readonly corruption: LedgerCorruption;
  constructor(path: string, corruption: LedgerCorruption) {
    super(`${path}: ${corruption.message}; the ledger is corrupt from there on, so no state is derived from it`);
    this.corruption = corruption;
  }
}

/**
 * Reads a ledger file and checks every event against the one before it: its sequence number, its link to the
 * previous event's hash, and its own hash. Reading stops at the first event that does not check out.
 */
export async function readLedger<B extends EventBody = LedgerEventBody>(path: string): Promise<LedgerRead<B>> {
  return parseLedger<B>(await whileBusy(() => readFile(path)), undefined, 1);
}

/** How far a ledger has been read: the bytes its checked events take up, and the last of them. */
export interface LedgerCursor<B extends EventBody = LedgerEventBody> {
  offset: number;
  /** The last event read; undefined before the first. */
  last: ChainedEvent<B> | undefined;
  /** How many events were read. */
  events: number;
}

/** A run ledger's cursor before anything was read; `ledgerStart()` for a ledger of other events. */
export const LEDGER_START: LedgerCursor = { offset: 0, last: undefined, events: 0 };
export const ledgerStart = <B extends EventBody>(): LedgerCursor<B> => ({ offset: 0, last: undefined, events: 0 });

/**
 * Reads what a ledger gained since `cursor`, checking each new event against the one before it as `readLedger` does (so
 * a reader that follows a growing ledger reads each byte once). `validBytes` counts from the cursor's offset, and a torn
 * tail is left out to be read again once its write finishes. Null when the file is shorter than the cursor: it was not
 * appended to, so the caller reads it again from the start.
 */
export async function readLedgerFrom<B extends EventBody = LedgerEventBody>(path: string, cursor: LedgerCursor<B>): Promise<LedgerRead<B> | null> {
  const bytes = await whileBusy(async () => {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size < cursor.offset) return null;
      const buffer = Buffer.alloc(size - cursor.offset);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, cursor.offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read);
    } finally {
      await handle.close();
    }
  });
  return bytes === null ? null : parseLedger<B>(bytes, cursor.last, cursor.events + 1);
}

/** The cursor after `read`, which was read from `cursor`. */
export const advanceCursor = <B extends EventBody>(cursor: LedgerCursor<B>, read: LedgerRead<B>): LedgerCursor<B> => ({
  offset: cursor.offset + read.validBytes,
  last: read.events.at(-1) ?? cursor.last,
  events: cursor.events + read.events.length,
});

/** The events of `bytes`, the first of which follows `previous` and is on line `firstLine` of the file. */
function parseLedger<B extends EventBody>(bytes: Buffer, previous: ChainedEvent<EventBody> | undefined, firstLine: number): LedgerRead<B> {
  const events: ChainedEvent<B>[] = [];
  let offset = 0;
  const result = (found: Partial<LedgerRead<B>>): LedgerRead<B> => ({
    events,
    validBytes: offset,
    tornTail: null,
    corruption: null,
    ...found,
  });
  while (offset < bytes.length) {
    const line = firstLine + events.length;
    const newline = bytes.indexOf(0x0a, offset);
    // Each event is written with its newline in one write, so a line without one is a write that did not finish.
    if (newline === -1) return result({ tornTail: { bytes: bytes.length - offset } });
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8", offset, newline));
    } catch {
      if (newline === bytes.length - 1) return result({ tornTail: { bytes: bytes.length - offset } });
      return result({ corruption: { line, kind: "unreadable", message: `line ${line} is not valid JSON` } });
    }
    const corruption = checkEvent(parsed, line, events.at(-1) ?? previous);
    if (corruption) return result({ corruption });
    events.push(parsed as ChainedEvent<B>);
    offset = newline + 1;
  }
  return result({});
}

/** Reads a ledger file as `readLedger` does, and throws `LedgerCorruptError` if its chain is broken. */
export async function readCheckedLedger<B extends EventBody = LedgerEventBody>(path: string): Promise<LedgerRead<B>> {
  const read = await readLedger<B>(path);
  if (read.corruption) throw new LedgerCorruptError(path, read.corruption);
  return read;
}

function isEvent(value: unknown): value is ChainedEvent<EventBody> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { seq, prevHash, time, type, hash } = value as Record<string, unknown>;
  return (
    Number.isInteger(seq) &&
    (prevHash === null || typeof prevHash === "string") &&
    typeof time === "string" &&
    typeof type === "string" &&
    typeof hash === "string"
  );
}

/** Whether `value` is the event that may follow `previous` (none for the first line), and if not, what is wrong. */
function checkEvent(value: unknown, line: number, previous: ChainedEvent<EventBody> | undefined): LedgerCorruption | null {
  if (!isEvent(value)) return { line, kind: "unreadable", message: `line ${line} is not a ledger event` };
  const at = `line ${line} (event ${value.seq})`;
  const expected = (previous?.seq ?? 0) + 1;
  if (value.seq > expected) {
    const missing = value.seq === expected + 1 ? `event ${expected} is` : `events ${expected} to ${value.seq - 1} are`;
    return { line, kind: "out_of_sequence", message: `${at} comes where event ${expected} belongs: ${missing} missing (sequence gap)` };
  }
  if (value.seq < expected) {
    return { line, kind: "out_of_sequence", message: `${at} comes where event ${expected} belongs: it repeats or goes back` };
  }
  if (value.prevHash !== (previous?.hash ?? null)) {
    return {
      line,
      kind: "broken_chain",
      message: `${at} does not follow the event before it: its previous-event hash does not match (broken hash chain)`,
    };
  }
  if (value.hash !== eventHash(value as unknown as Record<string, unknown>)) {
    return { line, kind: "broken_chain", message: `${at} does not match its hash (broken hash chain)` };
  }
  return null;
}
