import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ledgerFile = (repo: string, runId: string) => join(repo, ".git", "ahp", "runs", runId, "ledger.jsonl");
export const lockFile = (repo: string, runId: string) => join(repo, ".git", "ahp", "runs", runId, "ledger.lock");

/**
 * A PID no process has: above the largest PID Linux and macOS hand out, and one Windows refuses as invalid. The PID
 * of a child that has exited will not do, because the OS can give it to a new process at once (Windows does, under a
 * parallel test run), and a lock naming a running PID is rightly read as held.
 */
export const GONE_PID = 2_147_483_644;

/**
 * The ledger's canonical JSON, written here from the ticket's definition rather than taken from the runtime:
 * object keys sorted, no whitespace.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An event's hash: SHA-256 (lowercase hex) over the canonical JSON of the event without its `hash` field. */
export function eventHash(event: Record<string, unknown>): string {
  const { hash: _, ...unhashed } = event;
  return createHash("sha256").update(canonicalJson(unhashed)).digest("hex");
}

/** The parsed events of a run's ledger file, in append order. */
export function ledgerLines(repo: string, runId: string): Record<string, unknown>[] {
  return readFileSync(ledgerFile(repo, runId), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Appends one hand-made event to a finished run's ledger file, for tests of how replay treats ledgers no
 * runtime would write. It is chained like any other event: the next sequence number, the last event's hash,
 * and its own hash.
 */
export function appendLedgerEvent(repo: string, runId: string, event: Record<string, unknown>): void {
  const last = ledgerLines(repo, runId).at(-1)!;
  const unhashed = { seq: (last.seq as number) + 1, prevHash: last.hash, time: new Date().toISOString(), ...event };
  appendFileSync(ledgerFile(repo, runId), `${JSON.stringify({ ...unhashed, hash: eventHash(unhashed) })}\n`);
}

/**
 * Rewrites a run's ledger file, line by line, as `edit` returns each parsed event: null removes the line. Hashes are
 * left as they are unless `edit` sets them, so this is how a test damages a ledger.
 */
export function rewriteLedger(
  repo: string,
  runId: string,
  edit: (event: Record<string, unknown>) => Record<string, unknown> | null,
): void {
  const lines = ledgerLines(repo, runId).flatMap((event) => {
    const edited = edit(event);
    return edited === null ? [] : [JSON.stringify(edited)];
  });
  writeFileSync(ledgerFile(repo, runId), `${lines.join("\n")}\n`);
}

/**
 * Cuts a finished run's ledger after the `nth` event of `type`, as if the runtime had stopped there, so a test can
 * append hand-made events to a step that is still open. What is left is a prefix of the hash chain, so it is valid.
 */
export function truncateLedgerAfter(repo: string, runId: string, type: string, nth = 1): void {
  const path = ledgerFile(repo, runId);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  let seen = 0;
  const cut = lines.findIndex((line) => (JSON.parse(line) as { type: string }).type === type && ++seen === nth);
  if (cut === -1) throw new Error(`the ledger has no ${nth}th ${type} event`);
  writeFileSync(path, `${lines.slice(0, cut + 1).join("\n")}\n`);
}
