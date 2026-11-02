import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWorkflow } from "../src/index.ts";
import { advanceCursor, LEDGER_START, readLedgerFrom } from "../src/ledger/chain.ts";
import { locateRepo, runsDir } from "../src/runtime/paths.ts";
import { followRun } from "../src/tui/follow.ts";
import { wrapLine } from "../src/tui/run-model.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, retryWorkflow } from "./helpers/retry.ts";

let repo: string;
let ledgerLines: string[];
let attemptId: string;

beforeAll(async () => {
  repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
  const { runId, state } = await runWorkflow(retryWorkflow([goodbye, hello]), { repo });
  attemptId = state.steps[0]!.attempts[0]!.id;
  ledgerLines = readFileSync(join(runsDir(await locateRepo(repo)), runId, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
}, 60_000);

afterAll(removeTempRepos);

let copies = 0;
/** A run directory of its own holding the first `count` lines of the run's ledger, as a run that is still being written. */
async function partialRun(count: number): Promise<{ runId: string; dir: string; ledger: string }> {
  const runId = `run_copy${copies++}`;
  const dir = join(runsDir(await locateRepo(repo)), runId);
  mkdirSync(dir, { recursive: true });
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, ledgerLines.slice(0, count).map((line) => `${line}\n`).join(""));
  return { runId, dir, ledger };
}

describe("following a run's files", () => {
  it("reads a growing ledger from where it stopped, and checks each new event against the one before", async () => {
    const { ledger } = await partialRun(5);
    const first = (await readLedgerFrom(ledger, LEDGER_START))!;
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    const cursor = advanceCursor(LEDGER_START, first);

    appendFileSync(ledger, ledgerLines.slice(5, 8).map((line) => `${line}\n`).join(""));
    const next = (await readLedgerFrom(ledger, cursor))!;
    // Only what was added, and the chain still checks across the cut.
    expect(next.events.map((event) => event.seq)).toEqual([6, 7, 8]);
    expect(next.corruption).toBeNull();
    expect(next.validBytes).toBe(ledgerLines.slice(5, 8).join("\n").length + 1);

    // An event that does not follow the last one read is corruption, though the read began past it.
    const after = advanceCursor(cursor, next);
    appendFileSync(ledger, `${ledgerLines[9]}\n`);
    expect((await readLedgerFrom(ledger, after))!.corruption?.kind).toBe("out_of_sequence");
  });

  it("leaves a torn last line out until its write finishes, in the ledger and in an activity log", async () => {
    const { runId, dir, ledger } = await partialRun(6);
    mkdirSync(join(dir, "activity"), { recursive: true });
    const activity = join(dir, "activity", `${attemptId}.jsonl`);
    const message = (text: string) => JSON.stringify({ type: "message", time: "2026-01-01T00:00:00.000Z", text });
    writeFileSync(activity, `${message("one")}\n`);

    const follower = await followRun({ repo, runId, pollMs: 60_000 });
    try {
      expect(follower.current().events).toHaveLength(6);
      // Whatever attempt ID the copied ledger names, its activity log is read once it is in the replay.
      const attempts = follower.current().state!.steps.flatMap((step) => step.attempts).map((attempt) => attempt.id);
      expect(attempts).toContain(attemptId);
      expect(follower.current().activity[attemptId]).toHaveLength(1);

      const next = ledgerLines[6]!;
      appendFileSync(ledger, next.slice(0, 20));
      const half = message("two");
      appendFileSync(activity, half.slice(0, 10));
      await follower.refresh();
      expect(follower.current().events).toHaveLength(6);
      expect(follower.current().activity[attemptId]).toHaveLength(1);

      appendFileSync(ledger, `${next.slice(20)}\n`);
      appendFileSync(activity, `${half.slice(10)}\n`);
      await follower.refresh();
      expect(follower.current().events).toHaveLength(7);
      expect(follower.current().activity[attemptId]!.map((entry) => entry.type === "message" && entry.text)).toEqual(["one", "two"]);
    } finally {
      follower.close();
    }
  });

  it("says when the ledger's chain breaks, and keeps what it read before", async () => {
    const { runId, ledger } = await partialRun(4);
    const follower = await followRun({ repo, runId, pollMs: 60_000 });
    try {
      appendFileSync(ledger, `${ledgerLines[5]}\n`);
      await follower.refresh();
      expect(follower.current().events).toHaveLength(4);
      expect(follower.current().problem).toMatch(/sequence gap.*the ledger is corrupt from there on, so nothing after it is shown$/);
    } finally {
      follower.close();
    }
  });
});

describe("wrapping a receipt line", () => {
  it("breaks at spaces, indents what follows and keeps each segment's tone", () => {
    const rows = wrapLine({ key: "k", segments: [{ text: "✓ ", tone: "accent" }, { text: "implement: verified: `npm test` passed in a clean copy", tone: "text" }] }, 30);

    expect(rows.map((row) => row.segments.map((segment) => segment.text).join(""))).toEqual(["✓ implement: verified: `npm", "    test` passed in a clean", "    copy"]);
    expect(rows[0]!.segments[0]).toEqual({ text: "✓ ", tone: "accent" });
    expect(rows.map((row) => row.key)).toEqual(["k~0", "k~1", "k~2"]);
  });
});
