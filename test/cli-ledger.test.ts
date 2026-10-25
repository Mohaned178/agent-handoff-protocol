import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerWriter } from "../src/ledger/index.ts";
import { ahp } from "./helpers/cli.ts";
import { finishedRun, GONE_PID, ledgerFile, ledgerLines, lockFile, rewriteLedger, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const cliEntry = fileURLToPath(new URL("../src/cli/bin.ts", import.meta.url));

const lockOf = (pid: number) => `${JSON.stringify({ host: hostname(), pid, startedAt: "2026-01-01T00:00:00.000Z" })}\n`;

/**
 * A verification script that holds the run in verification, so a test can act while `ahp run` is writing the run.
 * It writes its PID to `verifier.pid` in the directory named by `AHP_TEST_CONTROL` and exits once `release` appears
 * there, or after a minute rather than outlive a failed test.
 */
const VERIFY_WHEN_RELEASED = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const control = process.env.AHP_TEST_CONTROL;
writeFileSync(join(control, "verifier.pid"), String(process.pid));
const deadline = Date.now() + 60_000;
setInterval(() => {
  if (existsSync(join(control, "release")) || Date.now() > deadline) process.exit(0);
}, 50);
`;

/** Polls `check` until it returns a value. */
async function until<T>(check: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HELD_WORKFLOW = `export default {
  name: "held",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: "hello\\n" }] }] } },
      verification: { command: "node wait.mjs" },
    },
  ],
};
`;

describe("a run's writer, across processes", () => {
  it("keeps every other writer out while ahp run writes the run, and is flagged for recovery once that process is killed", async () => {
    const repo = createTempRepo({ "wait.mjs": VERIFY_WHEN_RELEASED, "workflow.mjs": HELD_WORKFLOW });
    const control = mkdtempSync(join(tmpdir(), "ahp-control-"));
    const runtime = spawn(process.execPath, [cliEntry, "run", "workflow.mjs"], {
      cwd: repo,
      env: { ...process.env, AHP_TEST_CONTROL: control },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    runtime.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const exited = new Promise((resolve) => runtime.once("exit", resolve));
    const pidFile = join(control, "verifier.pid");
    const verifierPid = () => {
      const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
      return text === "" ? undefined : Number(text);
    };
    try {
      // Once the verification command runs, the runtime is mid-run.
      await until(() => {
        if (runtime.exitCode !== null) throw new Error(`ahp run exited before verifying:\n${stdout}`);
        return verifierPid();
      }, "the verification command to start");
      const runId = /run (run_[a-z0-9]+): created/.exec(stdout)![1]!;
      const path = ledgerFile(repo, runId);

      await expect(LedgerWriter.open(path)).rejects.toThrow(`lock held by PID ${runtime.pid} on ${hostname()}`);
      const live = ahp(["inspect", runId], repo);
      expect(live.stdout).toContain(`run ${runId}: running`);
      expect(live.stdout).toMatch(new RegExp(`lock: PID ${runtime.pid} on \\S+ \\(started [^)]+\\) is writing the run`));

      runtime.kill("SIGKILL");
      await exited;
      // A PID the OS has already handed to another process rightly reads as running; wait until it is free.
      await until(() => (isRunning(runtime.pid!) ? undefined : true), "the killed runtime's PID to be free");

      const after = ahp(["inspect", runId], repo);
      expect(after.code).toBe(0);
      expect(after.stdout).toContain(`run ${runId}: running`);
      expect(after.stdout).toContain(`lock: PID ${runtime.pid} on ${hostname()}`);
      expect(after.stdout).toContain("stopped without finishing the run or releasing its lock: the run needs recovery");
      await expect(LedgerWriter.open(path)).rejects.toThrow("which is no longer running");
    } finally {
      runtime.kill("SIGKILL");
      // The verification command outlives a killed runtime. Let it end, since on Windows its working directory
      // cannot be removed while it runs.
      writeFileSync(join(control, "release"), "");
      const pid = verifierPid();
      if (pid !== undefined) await until(() => (isRunning(pid) ? undefined : true), "the verification command to exit");
      rmSync(control, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe("ahp inspect and the ledger", () => {
  it("says how many events the ledger holds and that their hash chain is intact", async () => {
    const { repo, runId } = await finishedRun();

    const inspect = ahp(["inspect", runId], repo);

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(`ledger: ${ledgerLines(repo, runId).length} events, hash chain intact`);
    expect(inspect.stdout).not.toContain("\n  lock:");
  });

  it.each([
    {
      name: "a torn tail",
      damage: (repo: string, runId: string) => appendFileSync(ledgerFile(repo, runId), `{"seq":`),
      says: "ledger: the last line (7 bytes) is torn: a write did not finish, so it was never recorded and is left out; the next process to open the run for writing truncates it",
    },
    {
      name: "a truncated torn tail",
      damage: async (repo: string, runId: string) => {
        appendFileSync(ledgerFile(repo, runId), "{");
        await (await LedgerWriter.open(ledgerFile(repo, runId))).writer.close();
      },
      says: "ledger: truncated a torn last line of 1 byte, which a write did not finish and so was never recorded",
    },
    {
      name: "a writer that is running",
      damage: (repo: string, runId: string) => writeFileSync(lockFile(repo, runId), lockOf(process.pid)),
      says: `lock: PID ${process.pid} on ${hostname()} (started 2026-01-01T00:00:00.000Z) is writing the run`,
    },
    {
      name: "an unfinished run whose writer is gone",
      damage: (repo: string, runId: string) => {
        truncateLedgerAfter(repo, runId, "attempt_running");
        writeFileSync(lockFile(repo, runId), lockOf(GONE_PID));
      },
      says: "stopped without finishing the run or releasing its lock: the run needs recovery, and AHP will not write to it until then",
    },
    {
      name: "an unfinished run that nothing is writing",
      damage: (repo: string, runId: string) => truncateLedgerAfter(repo, runId, "attempt_running"),
      says: "lock: free, yet the run has not ended: the process running it stopped partway, and the run needs recovery",
    },
  ])("reports $name", async ({ damage, says }) => {
    const { repo, runId } = await finishedRun();
    await damage(repo, runId);

    const inspect = ahp(["inspect", runId], repo);

    expect(inspect.stderr).toBe("");
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(says);
  });

  it("prints the derived state with what the ledger and its lock say as JSON", async () => {
    const { repo, runId } = await finishedRun();
    const events = ledgerLines(repo, runId).length;
    appendFileSync(ledgerFile(repo, runId), "{");

    const inspect = ahp(["inspect", runId, "--json"], repo);

    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      state: { runId, state: "succeeded" },
      ledger: { events, tornTail: { bytes: 1 } },
      lock: { state: "free" },
    });
  });

  it.each([[[]], [["--json"]]])("refuses to show the state of a corrupt ledger and exits 1 (%j)", async (options) => {
    const { repo, runId } = await finishedRun();
    rewriteLedger(repo, runId, (event) => (event.type === "verification_verdict" ? { ...event, verdict: "fail" } : event));

    const inspect = ahp(["inspect", runId, ...options], repo);

    expect(inspect.code).toBe(1);
    expect(inspect.stdout).toBe("");
    expect(inspect.stderr).toMatch(/line \d+ \(event \d+\) does not match its hash \(broken hash chain\); the ledger is corrupt/);
  });
});
