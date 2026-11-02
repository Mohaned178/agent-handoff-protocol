import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/commands/main.ts";
import { plain } from "./helpers/cli.ts";
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
      expect(runtime.stdout()).toContain("✗ implement  cancelled [mock]");
      expect(runtime.stdout()).toContain(`run ${runId}: cancelled [mock]`);
      // How the agent was stopped is the attempt's record: inspect has it.
      expect(plain(["inspect", runId], repo).stdout).toMatch(/attempt att_\w+ \[mock\]: exited cancelled \(signal SIG\w+; forced: its process tree was killed\)/);
      for (const pid of tree) expect(isRunning(pid)).toBe(false);
    } finally {
      runtime.child.kill("SIGKILL");
      for (const pid of tree) if (isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

// The same handler, started in this process so that it also runs on Windows: a SIGINT the process receives is the event the
// plain run listens for, and emitting it is what Ctrl+C does once the OS has delivered it.
describe("Ctrl+C on ahp run, in this process", () => {
  it("cancels the run through its signal: the cancel is recorded first, the agent is stopped, and the exit code is 130", async () => {
    const attempt = { edits: [{ path: "greeting.txt", content: "hello\n" }], hang: true };
    const workflow = `export default {
  name: "cancel",
  steps: [{ id: "implement", agent: { adapter: "mock", options: { attempts: [${JSON.stringify(attempt)}] } }, verification: { command: "node verify.mjs" } }],
};
`;
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow });
    const out: string[] = [];
    const err: string[] = [];
    const exited = main(["run", join(repo, "workflow.mjs"), "--repo", repo], { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    const runId = await until(() => /^run (run_[a-z0-9]+): created/m.exec(out.join("\n"))?.[1], "the run to be created");
    await until(() => ledgerLines(repo, runId).find((event) => event.type === "attempt_running"), "the attempt to run");

    process.emit("SIGINT");

    expect(await exited).toBe(130);
    expect(err.join("\n")).toContain("ahp: cancelling the run (Ctrl+C)");
    const recorded = ledgerLines(repo, runId).map((event) => event.type);
    expect(recorded.indexOf("run_cancel_requested")).toBeGreaterThan(recorded.indexOf("attempt_running"));
    expect(recorded.at(-1)).toBe("run_terminal");
    const text = out.join("\n");
    expect(text).toContain(`run ${runId}: cancelling: no further agent is dispatched`);
    expect(text).toContain("✗ implement  cancelled [mock]");
    expect(text).toContain(`run ${runId}: cancelled [mock]`);
    expect(plain(["inspect", runId], repo).stdout).toMatch(/attempt att_\w+ \[mock\]: exited cancelled \(/);
  });
});
