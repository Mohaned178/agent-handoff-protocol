import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LedgerEvent } from "../protocol/index.ts";
import { whileBusy } from "./busy.ts";

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
export interface LedgerRead {
  /** The events whose sequence and hash chain check out, in append order: all of them, or those before the corruption. */
  events: LedgerEvent[];
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
export async function readLedger(path: string): Promise<LedgerRead> {
  const bytes = await whileBusy(() => readFile(path));
  const events: LedgerEvent[] = [];
  let offset = 0;
  const result = (found: Partial<LedgerRead>): LedgerRead => ({
    events,
    validBytes: offset,
    tornTail: null,
    corruption: null,
    ...found,
  });
  while (offset < bytes.length) {
    const line = events.length + 1;
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
    const corruption = checkEvent(parsed, line, events.at(-1));
    if (corruption) return result({ corruption });
    events.push(parsed as LedgerEvent);
    offset = newline + 1;
  }
  return result({});
}

function isEvent(value: unknown): value is LedgerEvent {
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
function checkEvent(value: unknown, line: number, previous: LedgerEvent | undefined): LedgerCorruption | null {
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
