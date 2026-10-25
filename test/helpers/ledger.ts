import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Appends one hand-made event to a finished run's ledger file, for tests of how replay treats ledgers no
 * runtime would write. The ledger is JSONL with a sequence number and timestamp on each event.
 */
export function appendLedgerEvent(repo: string, runId: string, event: Record<string, unknown>): void {
  const path = join(repo, ".git", "ahp", "runs", runId, "ledger.jsonl");
  const last = readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!;
  const seq = (JSON.parse(last) as { seq: number }).seq + 1;
  appendFileSync(path, `${JSON.stringify({ seq, time: new Date().toISOString(), ...event })}\n`);
}
