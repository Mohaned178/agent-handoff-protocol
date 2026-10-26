import { afterEach, describe, expect, it } from "vitest";
import type { MockAttemptScript, RunInspection } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const implemented = (round: number): MockAttemptScript => ({
  edits: [{ path: "greeting.txt", content: "hello\n" }],
  outputFields: { summary: `round ${round}` },
});

/** A workflow file: implement, then a review that sends it back, each with its mock agent's attempts. */
function workflowFile(implement: MockAttemptScript[], review: MockAttemptScript[], budget: number): string {
  const steps = [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: implement } },
      verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
      retry: { budget },
    },
    { id: "review", agent: { adapter: "mock", options: { attempts: review } }, review: { sendBackTo: "implement" }, verification: {} },
  ];
  return `export default ${JSON.stringify({ name: "reviewed", steps }, null, 2)};\n`;
}

const changes: MockAttemptScript = { outputFields: { verdict: "changes_requested", findings: ["rename the greeting", "add a test"] } };
const approve: MockAttemptScript = { outputFields: { verdict: "approved", findings: "nothing left" } };

describe("ahp run and ahp inspect with a review", () => {
  it("streams the send-back with the findings, labels the review's verification as structural, and inspect shows what was found", () => {
    const repo = createTempRepo({
      "verify.mjs": VERIFY_GREETING,
      "workflow.mjs": workflowFile([implemented(1), implemented(2)], [changes, approve], 2),
    });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/step review: structural verification \[mock\]: checks only that the required output fields are present/);
    expect(run.stdout).toContain(
      "step review: changes requested: step implement is sent back (retry 1 spent), and a new handoff revision carries the findings",
    );
    expect(run.stdout).toContain("  | rename the greeting\n  | add a test");
    expect(run.stdout).toMatch(/step implement: handoff hnd_[a-z0-9]+ revision 2 issued/);
    const runId = /run (run_[a-z0-9]+): succeeded/.exec(run.stdout)?.[1];

    const inspect = ahp(["inspect", runId!, "--repo", repo], repo);

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain("sent back by step review");
    expect(inspect.stdout).toContain("      | rename the greeting");
    expect(inspect.stdout).toContain('"kind": "review_findings"');
    expect(inspect.stdout).toContain("structural verification: checks only that");
    expect(inspect.stdout).toContain("evidence: review verdict: changes_requested");
    expect(inspect.stdout).toContain("evidence: review verdict: approved");
    expect(inspect.stdout).toMatch(/retries used: 1/);
    const json = (JSON.parse(ahp(["inspect", runId!, "--json"], repo).stdout) as RunInspection).state;
    expect(json.steps[0]!.attempts[0]!.sentBack).toMatchObject({ reviewStepId: "review", findings: ["rename the greeting", "add a test"] });
  });

  it("says what is left to do when the budget is spent: the run fails, exits 1, and names the step it cannot send back again", () => {
    const repo = createTempRepo({
      "verify.mjs": VERIFY_GREETING,
      "workflow.mjs": workflowFile([implemented(1)], [changes], 0),
    });

    const run = ahp(["run", "workflow.mjs"], repo);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("step review: failed (verification_failed) [mock]");
    expect(run.stdout).toContain("changes requested, and the retry budget of step implement is spent, so it cannot be sent back again");
    expect(run.stdout).not.toContain("is sent back");
    expect(run.stdout).toMatch(/run run_[a-z0-9]+: failed \[mock\]/);
  });
});
