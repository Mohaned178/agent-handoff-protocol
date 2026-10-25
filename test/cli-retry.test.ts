import { afterEach, describe, expect, it } from "vitest";
import type { MockAttemptScript, RunView } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** A workflow file with one `implement` step whose mock agent runs `attempts`, verified by `VERIFY_GREETING`. */
function workflowFile(attempts: MockAttemptScript[], step: Record<string, unknown> = {}): string {
  const implement = { id: "implement", agent: { adapter: "mock", options: { attempts } }, verification: { command: "node verify.mjs" }, ...step };
  return `export default ${JSON.stringify({ name: "retry", steps: [implement] }, null, 2)};\n`;
}

const hello: MockAttemptScript = { edits: [{ path: "greeting.txt", content: "hello\n" }] };
const goodbye: MockAttemptScript = { edits: [{ path: "greeting.txt", content: "goodbye\n" }] };

function run(attempts: MockAttemptScript[], step: Record<string, unknown> = {}) {
  const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile(attempts, step) });
  const result = ahp(["run", "workflow.mjs"], repo);
  const runId = /run (run_[a-z0-9]+): (?:succeeded|failed)/.exec(result.stdout)?.[1];
  return { repo, result, runId: runId! };
}

describe("ahp run with retries", () => {
  it("streams a failed attempt, its class and the retry that follows", () => {
    const { result } = run([{ exitCode: 3 }, hello]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/step implement: attempt \S+ \[mock\] exited error \(exit code 3\)/);
    expect(result.stdout).toMatch(/step implement: attempt \S+ \[mock\] failed: agent_error/);
    expect(result.stdout).toMatch(/step implement: retrying after attempt \S+ \(agent_error\): a new attempt under the same handoff revision/);
    expect(result.stdout).toMatch(/step implement: succeeded \[mock\]/);
  });

  it("says that a failed verification is retried under a new handoff revision with its evidence", () => {
    const { result, repo, runId } = run([goodbye, hello]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/step implement: retrying after attempt \S+ \(verification_failed\): a new handoff revision carries the evidence/);
    expect(result.stdout).toMatch(/step implement: handoff hnd_[a-z0-9]+ revision 2 issued/);

    const inspect = ahp(["inspect", runId, "--repo", repo], repo);
    expect(inspect.stdout).toMatch(/handoff hnd_[a-z0-9]+ revision 1: superseded/);
    expect(inspect.stdout).toMatch(/handoff hnd_[a-z0-9]+ revision 2: accepted/);
    expect(inspect.stdout).toContain('"kind": "test_output"');
    expect(inspect.stdout).toContain("greeting missing or wrong");
    expect(inspect.stdout).toMatch(/failure class: verification_failed/);
    expect(inspect.stdout).toMatch(/retries used: 1/);
  });

  it("surfaces a config/auth failure with the adapter's message and says it was not retried", () => {
    const { result, repo, runId } = run(
      [{ exitCode: 1, error: { kind: "config_auth", message: "not logged in: run `claude login`" } }, hello],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/step implement: failed \(config_auth\)/);
    expect(result.stdout).toContain("not logged in: run `claude login`");
    expect(result.stdout).toMatch(/not retried/);
    expect(result.stdout).not.toMatch(/retrying/);

    const inspect = ahp(["inspect", runId, "--repo", repo], repo);
    expect(inspect.stdout).toContain("error (config_auth): not logged in: run `claude login`");
    expect(inspect.stdout).toContain("verification: not run");
  });

  it("says when the retry budget is spent", () => {
    const { result } = run([{ exitCode: 3 }, { exitCode: 3 }], { retry: { budget: 1 } });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/step implement: failed \(agent_error\)/);
    expect(result.stdout).toMatch(/retry budget spent/);
  });

  it("shows an inconclusive verification that was re-run, and says it was escalated", () => {
    const { result, repo, runId } = run([hello, hello], { verification: { command: 'node -e "process.exit(127)"' } });

    expect(result.code).toBe(1);
    expect(result.stdout.match(/verification inconclusive/g)).toHaveLength(2);
    expect(result.stdout).toMatch(/step implement: failed \(inconclusive\)/);
    expect(result.stdout).toMatch(/escalated: the validator could not run twice/);

    const inspect = ahp(["inspect", runId, "--repo", repo], repo);
    expect(inspect.stdout).toMatch(/earlier verification: inconclusive/);
    const json = JSON.parse(ahp(["inspect", runId, "--json"], repo).stdout) as RunView;
    expect(json.steps[0]!.attempts[0]!.earlierVerifications).toHaveLength(1);
  });

  it("names a reroute", () => {
    const reroute = { adapter: "mock", model: "backup", options: { attempts: [{}, hello] } };
    const { result } = run([{ exitCode: 3 }], { retry: { budget: 0 }, reroute });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/step implement: rerouting after attempt \S+ \(agent_error\): the alternative agent takes over under a new handoff revision/);
  });
});
