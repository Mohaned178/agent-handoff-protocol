import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRun, LedgerCorruptError, readRun, readRunEvents, runWorkflow } from "../src/index.ts";
import { LedgerLockedError, LedgerWriter } from "../src/ledger/index.ts";
import { eventHash, finishedRun, GONE_PID, ledgerFile, ledgerLines, lockFile, rewriteLedger } from "./helpers/ledger.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

describe("the ledger's hash chain", () => {
  it("numbers every event and chains it to the one before by a SHA-256 over its canonical JSON", async () => {
    const { repo, runId } = await finishedRun();

    const events = ledgerLines(repo, runId);

    expect(events.length).toBeGreaterThan(5);
    events.forEach((event, index) => {
      expect(event.seq).toBe(index + 1);
      expect(event.prevHash).toBe(index === 0 ? null : events[index - 1]!.hash);
      expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.hash).toBe(eventHash(event));
    });
  });

  it("refuses to derive state from a ledger whose event was changed after it was written", async () => {
    const { repo, runId } = await finishedRun();
    const verdict = ledgerLines(repo, runId).find((event) => event.type === "verification_verdict")!;

    rewriteLedger(repo, runId, (event) => (event.seq === verdict.seq ? { ...event, verdict: "fail" } : event));

    const reading = readRun({ repo, runId });
    await expect(reading).rejects.toThrow(LedgerCorruptError);
    await expect(reading).rejects.toThrow(`line ${verdict.seq} (event ${verdict.seq}) does not match its hash`);
  });

  it("refuses a ledger with an event missing", async () => {
    const { repo, runId } = await finishedRun();
    const running = ledgerLines(repo, runId).find((event) => event.type === "attempt_running")!;
    const seq = running.seq as number;

    rewriteLedger(repo, runId, (event) => (event.seq === seq ? null : event));

    await expect(readRun({ repo, runId })).rejects.toThrow(
      `line ${seq} (event ${seq + 1}) comes where event ${seq} belongs: event ${seq} is missing (sequence gap)`,
    );
  });

  it("refuses a ledger with an event rewritten under a fresh hash, since the next event no longer follows it", async () => {
    const { repo, runId } = await finishedRun();
    const verdict = ledgerLines(repo, runId).find((event) => event.type === "verification_verdict")!;
    const seq = verdict.seq as number;

    rewriteLedger(repo, runId, (event) => {
      if (event.seq !== seq) return event;
      const forged = { ...event, verdict: "fail" };
      return { ...forged, hash: eventHash(forged) };
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(
      `line ${seq + 1} (event ${seq + 1}) does not follow the event before it: its previous-event hash does not match`,
    );
  });

  it("refuses a ledger with a line in it that is not JSON", async () => {
    const { repo, runId } = await finishedRun();
    const lines = readFileSync(ledgerFile(repo, runId), "utf8").split("\n");

    lines.splice(3, 0, "not an event");
    writeFileSync(ledgerFile(repo, runId), lines.join("\n"));

    await expect(readRun({ repo, runId })).rejects.toThrow("line 4 is not valid JSON");
  });
});

describe("the single-writer lock", () => {
  it("is held by a run while it runs, naming the host, process and its start time, and released when it ends", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const owners: unknown[] = [];

    const { runId } = await runWorkflow(retryWorkflow([hello]), {
      repo,
      onEvent: (_, state) => owners.push(JSON.parse(readFileSync(lockFile(repo, state.runId), "utf8"))),
    });

    const owner = { host: hostname(), pid: process.pid, startedAt: expect.any(String) };
    expect(owners).toEqual(ledgerLines(repo, runId).map(() => owner));
    const startedAt = Date.parse((owners[0] as { startedAt: string }).startedAt);
    expect(startedAt).toBeLessThanOrEqual(Date.parse(ledgerLines(repo, runId)[0]!.time as string));
    expect(existsSync(lockFile(repo, runId))).toBe(false);
  });

  it("keeps a second writer out while the first holds it, naming the first writer's process", async () => {
    const { repo, runId } = await finishedRun();
    const path = ledgerFile(repo, runId);
    const first = await LedgerWriter.open(path);

    const second = LedgerWriter.open(path);

    await expect(second).rejects.toThrow(LedgerLockedError);
    await expect(second).rejects.toThrow(`lock held by PID ${process.pid} on ${hostname()}`);
    await first.writer.close();
    const third = await LedgerWriter.open(path);
    await third.writer.close();
  });

  it.each([
    [
      "a process that is no longer running",
      () => ({ host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" }),
      "which is no longer running: it stopped without releasing the lock, so the run needs recovery; AHP never takes a stale lock over by itself",
    ],
    [
      "an earlier process that had this process's PID",
      () => ({ host: hostname(), pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
      "which is no longer running",
    ],
    [
      "a process on another host",
      () => ({ host: `not-${hostname()}`, pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
      "another host, so AHP cannot tell whether it is still running",
    ],
    ["nobody", () => "", "the lock file names no owner"],
  ])("is never taken over from %s", async (_, owner, message) => {
    const { repo, runId } = await finishedRun();
    const path = ledgerFile(repo, runId);
    const recorded = owner();
    const content = typeof recorded === "string" ? recorded : `${JSON.stringify(recorded)}\n`;
    writeFileSync(lockFile(repo, runId), content);
    const ledger = readFileSync(path);

    await expect(LedgerWriter.open(path)).rejects.toThrow(message);

    expect(readFileSync(lockFile(repo, runId), "utf8")).toBe(content);
    expect(readFileSync(path)).toEqual(ledger);
  });

  it("is released only while it still names its writer, so a lock some process has taken since stays", async () => {
    const { repo, runId } = await finishedRun();
    const { writer } = await LedgerWriter.open(ledgerFile(repo, runId));
    const other = `${JSON.stringify({ host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" })}\n`;
    writeFileSync(lockFile(repo, runId), other);

    await writer.close();

    expect(readFileSync(lockFile(repo, runId), "utf8")).toBe(other);
  });

  it("is taken over, when a recovering writer asks, only from a process that is no longer running", async () => {
    const { repo, runId } = await finishedRun();
    const path = ledgerFile(repo, runId);
    const stale = { host: hostname(), pid: GONE_PID, startedAt: "2026-01-01T00:00:00.000Z" };
    for (const content of [`${JSON.stringify({ ...stale, host: `not-${hostname()}` })}\n`, ""]) {
      writeFileSync(lockFile(repo, runId), content);
      await expect(LedgerWriter.open(path, undefined, { takeOverStale: true })).rejects.toThrow(LedgerLockedError);
      expect(readFileSync(lockFile(repo, runId), "utf8")).toBe(content);
    }
    writeFileSync(lockFile(repo, runId), `${JSON.stringify(stale)}\n`);

    const { writer, takenOverFrom } = await LedgerWriter.open(path, undefined, { takeOverStale: true });

    expect(takenOverFrom).toEqual(stale);
    expect(JSON.parse(readFileSync(lockFile(repo, runId), "utf8"))).toMatchObject({ pid: process.pid });
    await expect(LedgerWriter.open(path, undefined, { takeOverStale: true })).rejects.toThrow(`lock held by PID ${process.pid}`);
    await writer.close();
  });

  it("is released again when the ledger it guards turns out to be corrupt, which is never appended to", async () => {
    const { repo, runId } = await finishedRun();
    const path = ledgerFile(repo, runId);
    rewriteLedger(repo, runId, (event) => (event.seq === 2 ? { ...event, time: "2000-01-01T00:00:00.000Z" } : event));
    const ledger = readFileSync(path);

    await expect(LedgerWriter.open(path)).rejects.toThrow(LedgerCorruptError);

    expect(readFileSync(path)).toEqual(ledger);
    expect(existsSync(lockFile(repo, runId))).toBe(false);
  });
});

describe("inspecting a run", () => {
  it("says who holds the run's lock and whether the ledger ends in a torn tail", async () => {
    const { repo, runId, state } = await finishedRun();
    const path = ledgerFile(repo, runId);
    const events = ledgerLines(repo, runId).length;
    expect(await inspectRun({ repo, runId })).toEqual({ state, ledger: { events, tornTail: null }, lock: { state: "free" }, approval: null });

    const { writer } = await LedgerWriter.open(path);
    appendFileSync(path, "{");
    const inspection = await inspectRun({ repo, runId });
    await writer.close();

    expect(inspection).toEqual({
      state,
      ledger: { events, tornTail: { bytes: 1 } },
      lock: { state: "held", owner: { host: hostname(), pid: process.pid, startedAt: expect.any(String) } },
      approval: null,
    });
  });

  it("refuses a corrupt ledger", async () => {
    const { repo, runId } = await finishedRun();

    rewriteLedger(repo, runId, (event) => (event.seq === 1 ? { ...event, repo: "/elsewhere" } : event));

    await expect(inspectRun({ repo, runId })).rejects.toThrow("line 1 (event 1) does not match its hash");
  });
});

describe("a torn tail", () => {
  it("is left out of the run by readers: a last line without its newline was never recorded", async () => {
    const { repo, runId, state } = await finishedRun();
    const recorded = await readRunEvents({ repo, runId });

    appendFileSync(ledgerFile(repo, runId), `{"seq":${recorded.length + 1},"prevHash":"${recorded.at(-1)!.hash}","ti`);

    expect(await readRunEvents({ repo, runId })).toEqual(recorded);
    expect(await readRun({ repo, runId })).toEqual(state);
  });

  it("is left out of the run by readers when the last line is not JSON", async () => {
    const { repo, runId, state } = await finishedRun();

    appendFileSync(ledgerFile(repo, runId), "\0\0\0\0\n");

    expect(await readRun({ repo, runId })).toEqual(state);
  });

  it.each([
    ["a last line without its newline", `{"seq":99,"prevHash":"0123","ti`],
    ["a last line that is not JSON", "\0\0\0\0\n"],
  ])("is truncated by the next writer, which records how many bytes it dropped: %s", async (_, tail) => {
    const { repo, runId } = await finishedRun();
    const path = ledgerFile(repo, runId);
    const intact = readFileSync(path);
    const last = ledgerLines(repo, runId).at(-1)!;
    appendFileSync(path, tail);

    const { writer, events } = await LedgerWriter.open(path);
    await writer.close();

    const truncation = { seq: (last.seq as number) + 1, prevHash: last.hash, type: "ledger_truncated", droppedBytes: Buffer.byteLength(tail) };
    expect(readFileSync(path).subarray(0, intact.length)).toEqual(intact);
    expect(ledgerLines(repo, runId).at(-1)).toMatchObject(truncation);
    expect(events.at(-1)).toEqual(ledgerLines(repo, runId).at(-1));
    const state = await readRun({ repo, runId });
    expect(state.ledgerTruncations).toEqual([{ seq: truncation.seq, time: events.at(-1)!.time, droppedBytes: Buffer.byteLength(tail) }]);
  });
});
