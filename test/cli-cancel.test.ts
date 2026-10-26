import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerLines } from "./helpers/ledger.ts";
import { isRunning, startRun, until } from "./helpers/process.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

const dirs: string[] = [];
afterEach(() => {
  removeTempRepos();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Windows has no way to send Ctrl+C to a child process from Node: there `child.kill("SIGINT")` terminates it
// outright. The cancel behind Ctrl+C is tested on every OS through the SDK's signal (test/cancel.test.ts).
describe.skipIf(process.platform === "win32")("Ctrl+C on ahp run", () => {
  it("cancels the run: the agent's whole tree is stopped, the cancel is recorded, and ahp exits 130", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "ahp-pids-"));
    dirs.push(pidDir);
    const pidFile = join(pidDir, "pids");
    const attempt = { edits: [{ path: "greeting.txt", content: "hello\n" }], hang: true, spawnGrandchild: true, pidFile };
    const workflow = `export default {
  name: "cancel",
  steps: [{ id: "implement", agent: { adapter: "mock", options: { attempts: [${JSON.stringify(attempt)}] } }, verification: { command: "node verify.mjs" } }],
};
`;
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow });
    const runtime = startRun(["workflow.mjs"], repo);
    let tree: number[] = [];
    try {
      const runId = await runtime.runId();
      tree = await until(() => {
        const lines = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n") : [];
        return lines.length === 2 ? lines.map(Number) : undefined;
      }, "the agent to start its grandchild");
      await until(() => ledgerLines(repo, runId).find((event) => event.type === "attempt_running"), "the attempt to run");

      runtime.child.kill("SIGINT");

      expect(await runtime.exited).toBe(130);
      expect(runtime.stdout()).toContain(`run ${runId}: cancelling: no further agent is dispatched`);
      expect(runtime.stdout()).toMatch(/attempt att_\w+ \[mock\] exited cancelled \(signal SIG\w+; forced: its process tree was killed\)/);
      expect(runtime.stdout()).toContain("step implement: cancelled [mock]");
      expect(runtime.stdout()).toContain(`run ${runId}: cancelled [mock]`);
      for (const pid of tree) expect(isRunning(pid)).toBe(false);
    } finally {
      runtime.child.kill("SIGKILL");
      for (const pid of tree) if (isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });
});
