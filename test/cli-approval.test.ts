import { afterEach, describe, expect, it } from "vitest";
import type { MockAttemptScript, RunInspection } from "../src/index.ts";
import { ahp } from "./helpers/cli.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const implemented = (round: number): MockAttemptScript => ({
  edits: [{ path: "greeting.txt", content: "hello\n" }],
  outputFields: { summary: `round ${round}` },
});

/** A workflow file: implement, a review that approves, then an approval gate. */
function workflowFile(implement: MockAttemptScript[], budget: number): string {
  const review: MockAttemptScript = { outputFields: { verdict: "approved", findings: ["naming is fine", "tests are thin"] } };
  const steps = [
    {
      id: "implement",
      agent: { adapter: "mock", options: { attempts: implement } },
      verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
      retry: { budget },
    },
    { id: "review", agent: { adapter: "mock", options: { attempts: [review, review, review] } }, review: { sendBackTo: "implement" }, verification: {} },
    { id: "approve", approval: {} },
  ];
  return `export default ${JSON.stringify({ name: "gated", steps }, null, 2)};\n`;
}

function startedRun(implement: MockAttemptScript[], budget = 2) {
  const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflowFile(implement, budget) });
  const run = ahp(["run", "workflow.mjs"], repo);
  return { repo, run, runId: /run (run_[a-z0-9]+): created/.exec(run.stdout)?.[1]! };
}

describe("ahp run, inspect, approve and reject with an approval gate", () => {
  it("stops at the gate with exit code 4, shows what is being approved, and resumes on approve", () => {
    const { repo, run, runId } = startedRun([implemented(1)]);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(4);
    expect(run.stdout).toContain(`run ${runId}: waiting for approval [mock]`);
    expect(run.stdout).toContain("step approve awaits a person: step review's attempt");
    expect(run.stdout).toContain(`\`ahp approve ${runId} approve\``);
    expect(run.stdout).toContain(`\`ahp reject ${runId} approve --reason "..."\``);

    const inspect = ahp(["inspect", runId], repo);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(`run ${runId}: waiting_approval [mock]`);
    expect(inspect.stdout).toContain("step approve: waiting_approval");
    expect(inspect.stdout).toContain("1 path changed against the run's base commit");
    expect(inspect.stdout).toContain("      | added greeting.txt");
    expect(inspect.stdout).toContain("diff of the verified snapshot against the run's base commit:");
    expect(inspect.stdout).toContain("      | +hello");
    expect(inspect.stdout).toContain("verification of the attempt being approved: pass");
    expect(inspect.stdout).toContain("structural verification: checks only that");
    expect(inspect.stdout).toContain("review review found (verdict approved):\n      | naming is fine\n      | tests are thin");
    expect(inspect.stdout).toContain("decision: awaits a person");
    expect(inspect.stdout).toContain(`approval: \`ahp inspect ${runId}\` shows what is being approved`);
    const json = JSON.parse(ahp(["inspect", runId, "--json"], repo).stdout) as RunInspection;
    expect(json.approval).toMatchObject({ stepId: "approve", diffError: null });
    expect(json.approval!.diff).toContain("+hello");

    // Resuming a waiting run is not a decision.
    const recover = ahp(["recover", runId], repo);
    expect(recover.code).toBe(4);
    expect(recover.stdout).toContain(`run ${runId}: waiting for approval`);

    const approve = ahp(["approve", runId, "approve"], repo);
    expect(approve.stderr).toBe("");
    expect(approve.code).toBe(0);
    expect(approve.stdout).toMatch(/step approve: approved by .+/);
    expect(approve.stdout).toContain(`run ${runId}: succeeded [mock]`);
    expect(ahp(["inspect", runId], repo).stdout).toMatch(/decision: approved by .+ at \d{4}-/);
  });

  it("rejects with a reason: the step before the gate is sent back, the gate asks again, and a second approve is refused", () => {
    const { repo, runId } = startedRun([implemented(1), implemented(2)]);

    const reject = ahp(["reject", runId, "approve", "--reason", "rename the greeting"], repo);

    expect(reject.stderr).toBe("");
    expect(reject.code).toBe(4);
    expect(reject.stdout).toMatch(/step approve: rejected by .+: rename the greeting/);
    expect(reject.stdout).toContain("step approve: rejected: step review is sent back (retry 1 spent), and a new handoff revision carries the reason");
    expect(reject.stdout).toContain(`run ${runId}: waiting for approval`);
    const inspect = ahp(["inspect", runId], repo);
    expect(inspect.stdout).toMatch(/rejected at approval gate approve by .+ at .+; the reason:\n\s+\| rename the greeting/);
    expect(inspect.stdout).toContain('"kind": "approval_rejected"');

    expect(ahp(["approve", runId, "approve"], repo).code).toBe(0);
    const again = ahp(["approve", runId, "approve"], repo);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/^ahp: step approve is not waiting for approval: run run_[a-z0-9]+ already ended \(succeeded\)/);
  });

  it("fails the run when the step before the gate has no retry left to be sent back on", () => {
    const { repo, runId } = startedRun([implemented(1)], 0);

    // The step before the gate is the review, which has the default budget of 2; spend it, then reject once more.
    expect(ahp(["reject", runId, "approve", "--reason", "once"], repo).code).toBe(4);
    expect(ahp(["reject", runId, "approve", "--reason", "twice"], repo).code).toBe(4);
    const last = ahp(["reject", runId, "approve", "--reason", "thrice"], repo);

    expect(last.code).toBe(1);
    expect(last.stdout).toContain(
      "step approve: failed (verification_failed)\n  rejected, and the retry budget of step review is spent, so it cannot be sent back again",
    );
    expect(last.stdout).not.toContain("is sent back");
  });

  it("is a usage error to reject without a reason or to leave out the step, and a refusal exits 1", () => {
    const { repo, runId } = startedRun([implemented(1)]);

    const noReason = ahp(["reject", runId, "approve"], repo);
    expect(noReason.code).toBe(2);
    expect(noReason.stderr).toContain("reject needs --reason <text>");
    const blank = ahp(["reject", runId, "approve", "--reason", "  "], repo);
    expect(blank.code).toBe(2);
    const noStep = ahp(["approve", runId], repo);
    expect(noStep.code).toBe(2);
    expect(noStep.stderr).toContain("approve needs a run ID and the approval gate's step ID");
    const withReason = ahp(["approve", runId, "approve", "--reason", "x"], repo);
    expect(withReason.code).toBe(2);
    expect(ahp(["inspect", runId, "approve"], repo).code).toBe(2);
    const wrongStep = ahp(["approve", runId, "implement"], repo);
    expect(wrongStep.code).toBe(1);
    expect(wrongStep.stderr).toContain("step implement is not waiting for approval: it is not an approval gate");

    // None of that decided anything.
    expect(JSON.parse(ahp(["inspect", runId, "--json"], repo).stdout).state.state).toBe("waiting_approval");
  });
});
