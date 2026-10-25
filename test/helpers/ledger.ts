import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ledgerFile = (repo: string, runId: string) => join(repo, ".git", "ahp", "runs", runId, "ledger.jsonl");

/**
 * Appends one hand-made event to a finished run's ledger file, for tests of how replay treats ledgers no
 * runtime would write. The ledger is JSONL with a sequence number and timestamp on each event.
 */
export function appendLedgerEvent(repo: string, runId: string, event: Record<string, unknown>): void {
  const path = ledgerFile(repo, runId);
  const last = readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!;
  const seq = (JSON.parse(last) as { seq: number }).seq + 1;
  appendFileSync(path, `${JSON.stringify({ seq, time: new Date().toISOString(), ...event })}\n`);
}

/**
 * Cuts a finished run's ledger after the `nth` event of `type`, as if the runtime had stopped there, so a test can
 * append hand-made events to a step that is still open. (The ledger has no hash chain yet, so a cut is valid.)
 */
export function truncateLedgerAfter(repo: string, runId: string, type: string, nth = 1): void {
  const path = ledgerFile(repo, runId);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  let seen = 0;
  const cut = lines.findIndex((line) => (JSON.parse(line) as { type: string }).type === type && ++seen === nth);
  if (cut === -1) throw new Error(`the ledger has no ${nth}th ${type} event`);
  writeFileSync(path, `${lines.slice(0, cut + 1).join("\n")}\n`);
}
