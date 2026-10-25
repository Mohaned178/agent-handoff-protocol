import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, mock, readRunEvents, runWorkflow } from "../src/index.ts";
import type { MockAttemptScript } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { goodbye, hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

describe("a failed verification", () => {
  it("is retried under a new handoff revision that carries the failing evidence, and the earlier revision is superseded", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(retryWorkflow([goodbye, hello]), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    const [first, second] = step.handoffs;
    expect(step.handoffs.map((h) => [h.revision, h.supersedes, h.state])).toEqual([
      [1, null, "superseded"],
      [2, 1, "accepted"],
    ]);
    expect(second!.handoffId).toBe(first!.handoffId);
    // The revision changes the evidence and nothing else about the contract, and keeps the step's base commit.
    expect(first!.handoff.evidence).toEqual([]);
    expect(second!.handoff.evidence).toEqual([
      expect.objectContaining({
        kind: "test_output",
        command: "node verify.mjs",
        exitCode: 1,
        output: expect.stringContaining("greeting missing or wrong"),
      }),
    ]);
    expect(second!.handoff.base).toEqual(first!.handoff.base);
    expect(second!.handoff.contract).toEqual(first!.handoff.contract);
    expect(step.attempts.map((a) => [a.failureClass, a.handoff.revision])).toEqual([
      ["verification_failed", 1],
      [null, 2],
    ]);
    expect(step.retryUsage.retries).toBe(1);

    // The ledger shows what each attempt received: the intent to retry, then the revision, then the attempt.
    const events = await readRunEvents({ repo, runId });
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "handoff_issued")).toHaveLength(2);
    expect(events.find((e) => e.type === "retry_scheduled")).toMatchObject({
      failureClass: "verification_failed",
      change: "evidence",
      delayMs: 0,
    });
    const retryAt = types.indexOf("retry_scheduled");
    expect(types.slice(retryAt, retryAt + 3)).toEqual(["retry_scheduled", "handoff_issued", "handoff_accepted"]);
    // The idempotency key, (handoff, revision, attempt), is unique per attempt.
    const keys = events
      .filter((e) => e.type === "attempt_created")
      .map((e) => `${e.handoffId}/${e.handoffRevision}/${e.attemptId}`);
    expect(new Set(keys).size).toBe(2);
    expect(keys[1]).toContain(`${first!.handoffId}/2/`);
  });

  it("starts the retry in a new workspace from the step's base commit, so nothing the failed attempt left is there", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const messy: MockAttemptScript = {
      edits: [
        { path: "greeting.txt", content: "goodbye\n" },
        { path: "leftover.txt", content: "mess\n" },
      ],
    };

    const { state } = await runWorkflow(retryWorkflow([messy, hello]), { repo, clock: fakeClock() });

    const [failed, retried] = implementOf(state).attempts;
    expect(state.state).toBe("succeeded");
    expect(retried!.workspace).not.toBe(failed!.workspace);
    expect(existsSync(join(failed!.workspace, "leftover.txt"))).toBe(true);
    expect(existsSync(join(retried!.workspace, "leftover.txt"))).toBe(false);
    for (const attempt of [failed!, retried!]) {
      expect(git(repo, "rev-parse", `${attempt.snapshot!.commit}^`)).toBe(state.baseCommit);
    }
    expect(git(repo, "ls-tree", "-r", "--name-only", retried!.snapshot!.commit)).not.toContain("leftover.txt");
  });

  it("hands the next step the passing attempt's result, not a failed attempt's", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "ok.mjs": "process.exit(0);\n" });
    const plan = {
      id: "plan",
      agent: mock({
        attempts: [
          { ...goodbye, outputFields: { summary: "first try" } },
          { ...hello, outputFields: { summary: "second try" } },
        ],
      }),
      verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
    };
    const review = { id: "review", agent: mock({ attempts: [{}] }), verification: { command: "node ok.mjs" } };

    const { state } = await runWorkflow(defineWorkflow({ name: "chain", steps: [plan, review] }), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const [planStep, reviewStep] = state.steps;
    const passing = planStep!.attempts[1]!;
    const handoff = reviewStep!.handoffs[0]!.handoff;
    expect(handoff.from).toEqual({ stepId: "plan", attemptId: passing.id });
    expect(handoff.base.commit).toBe(passing.snapshot!.commit);
    expect(handoff.context.fields).toEqual({ summary: "second try" });
  });

  it("tells the agent the exit code of hidden tests but withholds their output, which stays in the ledger", async () => {
    const repo = createTempRepo({ "README.md": "fixture\n" });
    const hiddenCheck = `
      import { readFileSync } from "node:fs";
      const ok = readFileSync("greeting.txt", "utf8").trim() === "hello";
      console.log(ok ? "ok" : "SECRET-EXPECTATION: greeting must be hello");
      process.exit(ok ? 0 : 1);
    `;
    const verification = {
      command: "node hidden/greeting.check.mjs",
      hiddenTests: [{ path: "hidden/greeting.check.mjs", content: hiddenCheck }],
    };

    const { state } = await runWorkflow(retryWorkflow([goodbye, hello], { verification }), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const step = implementOf(state);
    expect(step.handoffs[1]!.handoff.evidence).toEqual([
      { kind: "test_output", command: "node hidden/greeting.check.mjs", exitCode: 1, signal: null, output: null, truncated: false },
    ]);
    const handoffs = JSON.stringify(step.handoffs.map((h) => h.handoff));
    expect(handoffs).not.toContain("SECRET-EXPECTATION");
    expect(handoffs).not.toContain("hiddenTests");
    // The ledger's verification evidence is the full record, for the person reading it.
    expect(JSON.stringify(step.attempts[0]!.verification!.evidence)).toContain("SECRET-EXPECTATION");
  });

  it("names the paths the agent changed that were protected, without listing what else is protected", async () => {
    const repo = createTempRepo({
      "verify.mjs": VERIFY_GREETING,
      "runner.config.mjs": "export default {};\n",
      "scripts/test.mjs": "// test\n",
    });
    const verification = { command: "node verify.mjs", protectedPaths: ["runner.config.mjs", "scripts/test.mjs"] };
    const tampered: MockAttemptScript = { edits: [{ path: "runner.config.mjs", content: "export default { skip: true };\n" }] };

    const { state } = await runWorkflow(retryWorkflow([tampered, hello], { verification }), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const evidence = implementOf(state).handoffs[1]!.handoff.evidence;
    expect(evidence).toEqual([
      { kind: "protected_paths", violations: [{ path: "runner.config.mjs", change: "modified" }], truncated: false },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("scripts/test.mjs");
  });

  it("names the required output fields the agent left out", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const verification = { command: "node verify.mjs", requiredOutputFields: ["summary", "decisions"] };
    const incomplete = { ...hello, outputFields: { summary: "done" } };
    const complete = { ...hello, outputFields: { summary: "done", decisions: ["x"] } };

    const { state } = await runWorkflow(retryWorkflow([incomplete, complete], { verification }), { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    expect(implementOf(state).handoffs[1]!.handoff.evidence).toEqual([
      { kind: "required_output_fields", missing: ["decisions"] },
    ]);
  });
});
