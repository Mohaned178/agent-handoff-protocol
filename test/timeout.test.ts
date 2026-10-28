import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflow, validateWorkflow, type MockAttemptScript } from "../src/index.ts";
import { watchAttempt } from "../src/runtime/timeout.ts";
import { isRunning, until, untilGone } from "./helpers/process.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

const dirs: string[] = [];
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  removeTempRepos();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ahp-timeout-"));
  dirs.push(dir);
  return dir;
};

/** The PIDs the mock agent wrote to `path`, once it has written `count`. */
const pidsIn = (path: string, count: number) =>
  until(() => {
    const lines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
    if (lines.length < count) return undefined;
    const read = lines.map(Number);
    leftovers.push(...read);
    return read;
  }, "the mock agent to write its PIDs");

describe("a step's attempt limits", () => {
  it("stops an agent that prints nothing for timeout.idleMs, with every process it started, and retries the step", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const pidFile = join(tempDir(), "pids");
    // Silent on stdout: the mock writes only to stderr while it hangs, like a model that accepted a request and never answered.
    const silent: MockAttemptScript = { ...hello, hang: true, spawnGrandchild: true, pidFile };

    const { state } = await runWorkflow(retryWorkflow([silent, hello], { timeout: { idleMs: 400 }, retry: { budget: 1 } }), { repo, cancelGraceMs: 300 });

    expect(state.state).toBe("succeeded");
    const [timedOut, retried] = implementOf(state).attempts;
    expect(timedOut).toMatchObject({ outcome: "error", failureClass: "agent_error" });
    expect(timedOut!.error!.message).toContain("printed nothing for 0.4 s (the step's timeout.idleMs)");
    expect(retried).toMatchObject({ outcome: "ok" });
    for (const pid of await pidsIn(pidFile, 2)) await untilGone(pid, `process ${pid} of the timed-out agent's tree to be gone`);
  });

  it("stops an attempt at timeout.totalMs and fails the step when no retry is left", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(retryWorkflow([{ ...hello, hang: true }], { timeout: { totalMs: 400, idleMs: 0 }, retry: { budget: 0 } }), { repo, cancelGraceMs: 300 });

    expect(state.state).toBe("failed");
    expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "agent_error" });
    expect(implementOf(state).attempts[0]!.error!.message).toContain("ran for 0.4 s (the step's timeout.totalMs)");
  });

  it("counts output as activity: an agent that keeps printing is not idle", async () => {
    const output = join(tempDir(), "out.txt");
    writeFileSync(output, "");
    const stop = new AbortController();
    const started = Date.now();
    let lastWrite = started;
    const writer = setInterval(() => {
      if (Date.now() - started > 600) return clearInterval(writer);
      appendFileSync(output, "x");
      lastWrite = Date.now();
    }, 50);

    const overrun = await watchAttempt(output, { totalMs: 0, idleMs: 200 }, stop.signal);

    expect(overrun).toEqual({ limit: "idleMs", ms: 200 });
    expect(Date.now() - lastWrite).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });

  it("rejects limits that are not whole milliseconds, and unknown ones", () => {
    const step = { id: "implement", agent: { adapter: "mock", options: { attempts: [hello] } }, verification: { command: "node verify.mjs" } };
    expect(validateWorkflow({ name: "x", steps: [{ ...step, timeout: { idleMs: -1, totalMs: 1.5, minutes: 3 } }] })).toEqual([
      "step \"implement\": unknown property `timeout.minutes`",
      expect.stringContaining("`timeout.totalMs` must be a non-negative integer number of milliseconds (0: no limit)"),
      expect.stringContaining("`timeout.idleMs` must be a non-negative integer number of milliseconds (0: no limit)"),
    ]);
    expect(validateWorkflow({ name: "x", steps: [{ ...step, timeout: { idleMs: 0, totalMs: 90_000 } }] })).toEqual([]);
  });
});
