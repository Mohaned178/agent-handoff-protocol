import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ahp } from "./helpers/cli.ts";
import { addBareRemote, BRANCH, remoteBranch, updatesOf } from "./helpers/external.ts";
import { ledgerLines } from "./helpers/ledger.ts";
import { startAhp, until } from "./helpers/process.ts";
import { createTempRepo, removeTempRepos, trackForRemoval, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const WORKFLOW = `export default ${JSON.stringify(
  {
    name: "publish",
    steps: [
      {
        id: "implement",
        agent: { adapter: "mock", options: { attempts: [{ edits: [{ path: "greeting.txt", content: "hello\n" }] }] } },
        verification: { command: "node verify.mjs" },
      },
      { id: "approve", approval: {} },
      { id: "push", action: { kind: "push_branch", branch: BRANCH } },
    ],
  },
  null,
  2,
)};\n`;

/**
 * Makes the bare remote hold every push after its refs are updated, until `release` appears in `control`: a push in
 * flight whose effect has already landed. It marks `landed` first. Git for Windows runs hooks with its own sh, which
 * takes forward slashes.
 */
function holdPushes(remote: string, control: string): void {
  const dir = control.replaceAll("\\", "/");
  const hook = join(remote, "hooks", "post-receive");
  writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\n: > "${dir}/landed"\nwhile [ ! -f "${dir}/release" ]; do sleep 0.1; done\n`);
  chmodSync(hook, 0o755);
}

describe("ahp approve killed mid-push, then ahp recover", () => {
  it("finds the push already landed, records it, and never pushes twice", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": WORKFLOW });
    const remote = addBareRemote(repo);
    const run = ahp(["run", "workflow.mjs"], repo);
    expect(run.code).toBe(4);
    const runId = /run (run_[a-z0-9]+): created/.exec(run.stdout)![1]!;
    const control = mkdtempSync(join(tmpdir(), "ahp-control-"));
    trackForRemoval(control);
    holdPushes(remote, control);

    const approve = startAhp(["approve", runId, "approve"], repo);
    try {
      await until(() => existsSync(join(control, "landed")) || undefined, "the push to reach the remote");
      await approve.kill();
    } finally {
      // The push itself outlives the killed runtime until the hook lets it end.
      writeFileSync(join(control, "release"), "");
      approve.child.kill("SIGKILL");
    }
    const recorded = ledgerLines(repo, runId).map((event) => event.type);
    // Killed between its intent (and the check before it) and recording that it was performed.
    expect(recorded.slice(-3)).toEqual(["step_ready", "external_action_intended", "external_action_checked"]);
    const approved = ledgerLines(repo, runId).find((event) => event.type === "approval_requested")!.commit;
    expect(remoteBranch(remote)).toBe(approved);

    const recover = ahp(["recover", runId], repo);

    expect(recover.stderr).toBe("");
    expect(recover.code).toBe(0);
    expect(recover.stdout).toContain(`run ${runId}: resumed by a new process, which took over the stale lock of PID ${approve.pid}`);
    expect(recover.stdout).toContain(`step push: checked the remote: the remote's branch is at ${String(approved).slice(0, 12)}; already done, so it is not done again`);
    expect(recover.stdout).toContain("step push: succeeded");
    expect(recover.stdout).toContain(`run ${runId}: succeeded [mock]`);
    expect(updatesOf(remote)).toBe(1);
    expect(ledgerLines(repo, runId).filter((event) => event.type === "external_action_performed")).toEqual([]);

    const inspect = ahp(["inspect", runId], repo);
    expect(inspect.stdout).toContain(`action: push commit ${String(approved).slice(0, 12)}, approved at gate approve, to branch ${BRANCH} on remote origin`);
    expect(inspect.stdout).toMatch(/checked: \S+: the remote has no such branch\n {4}checked: \S+: the remote's branch is at [0-9a-f]{12} \(already done\)/);
  });
});
