import { afterEach, describe, expect, it } from "vitest";
import { promptFor } from "../src/adapters/prompt.ts";
import { defineWorkflow, mock, readRunEvents, runWorkflow, validateHandoff, validateWorkflow } from "../src/index.ts";
import type { HandoffRevision, MockAttemptScript, OutputFieldValue, StepDefinition } from "../src/index.ts";
import { reviseHandoff } from "../src/runtime/handoff.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_OK } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** The measure the ticket names: UTF-8 bytes of the handed-on fields as JSON. */
const bytesOf = (fields: Record<string, OutputFieldValue>) => Buffer.byteLength(JSON.stringify(fields), "utf8");

/** plan (with a budget on what it hands on) → implement, both checked by `node ok.mjs`. */
function budgeted(plan: MockAttemptScript[], maxBytes: number, extra: Partial<StepDefinition> = {}) {
  return defineWorkflow({
    name: "budget",
    steps: [
      {
        id: "plan",
        agent: mock({ attempts: plan }),
        verification: { command: "node ok.mjs", requiredOutputFields: ["summary", "decisions"] },
        contextBudget: { maxBytes },
        ...extra,
      },
      { id: "implement", agent: mock({ attempts: [{}] }), verification: { command: "node ok.mjs" }, retry: { budget: 0 } },
    ],
  });
}

const short = { summary: "add the endpoint", decisions: ["reuse the mailer"] };
// "é" is two bytes in UTF-8: a budget counted in characters would pass this.
const long = { summary: "é".repeat(150), decisions: ["reuse the mailer"] };

describe("a step's context budget", () => {
  it("passes a step whose handed-on fields fit, and tells both the step and its handoff the budget", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });

    const { state } = await runWorkflow(budgeted([{ outputFields: short }], 256), { repo });

    expect(state.state).toBe("succeeded");
    const [plan, implement] = state.steps;
    expect(plan!.handoffs[0]!.handoff.contract.acceptance.contextBudget).toEqual({ maxBytes: 256 });
    expect(implement!.handoffs[0]!.handoff.contract.acceptance.contextBudget).toBeNull();
    expect(implement!.handoffs[0]!.handoff.context.fields).toEqual(short);
    // A step within its budget records no budget evidence: the kind names a failure.
    expect(plan!.attempts[0]!.verification!.evidence.map((item) => item.kind)).not.toContain("context_over_budget");
  });

  it("fails verification over the budget, counting UTF-8 bytes, and retries with the bytes and the budget as evidence", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const budget = 256;
    expect(long.summary.length).toBeLessThan(budget);
    expect(bytesOf(long)).toBeGreaterThan(budget);

    const { runId, state } = await runWorkflow(budgeted([{ outputFields: long }, { outputFields: short }], budget), { repo });

    expect(state.state).toBe("succeeded");
    const plan = state.steps[0]!;
    expect(plan.attempts.map((attempt) => [attempt.verification?.state, attempt.failureClass])).toEqual([
      ["fail", "verification_failed"],
      ["pass", null],
    ]);
    // The check ran: only the budget failed.
    const evidence = plan.attempts[0]!.verification!.evidence;
    expect(evidence).toContainEqual({ kind: "context_over_budget", bytes: bytesOf(long), maxBytes: budget });
    expect(evidence).toContainEqual(expect.objectContaining({ kind: "test_output", exitCode: 0 }));
    expect(plan.retryUsage.retries).toBe(1);
    // The retry is a new revision that shows the agent what it handed on and what it may.
    expect(plan.handoffs.map((view) => view.revision)).toEqual([1, 2]);
    expect(plan.handoffs[1]!.handoff.evidence).toEqual([{ kind: "context_over_budget", bytes: bytesOf(long), maxBytes: budget }]);
    // Only the fields that passed go on.
    expect(state.steps[1]!.handoffs[0]!.handoff.context.fields).toEqual(short);
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((event) => event.type === "retry_scheduled")).toHaveLength(1);
  });

  it("fails the step once the retry budget is spent", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });

    const { state } = await runWorkflow(budgeted([{ outputFields: long }], 256, { retry: { budget: 0 } }), { repo });

    expect(state.state).toBe("failed");
    expect(state.steps[0]).toMatchObject({ state: "failed", failureClass: "verification_failed" });
  });

  it("counts only the fields that are handed on, never others the agent reported", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });

    const { state } = await runWorkflow(budgeted([{ outputFields: { ...short, notes: "x".repeat(1000) } }], 256), { repo });

    expect(state.state).toBe("succeeded");
    expect(state.steps[1]!.handoffs[0]!.handoff.context.fields).toEqual(short);
  });

  it("holds a review step's verdict and findings to it", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const workflow = defineWorkflow({
      name: "review-budget",
      steps: [
        { id: "implement", agent: mock({ attempts: [{}] }), verification: { command: "node ok.mjs" }, retry: { budget: 0 } },
        {
          id: "review",
          agent: mock({ attempts: [{ outputFields: { verdict: "approved", findings: ["x".repeat(300)] } }] }),
          verification: {},
          review: { sendBackTo: "implement" },
          contextBudget: { maxBytes: 128 },
          retry: { budget: 0 },
        },
      ],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.steps[1]).toMatchObject({ state: "failed", failureClass: "verification_failed" });
    expect(state.steps[1]!.attempts[0]!.verification!.evidence).toContainEqual(expect.objectContaining({ kind: "context_over_budget", maxBytes: 128 }));
  });
});

describe("validating a context budget", () => {
  const step = (contextBudget: unknown, verification: StepDefinition["verification"] = { command: "node ok.mjs", requiredOutputFields: ["summary"] }) => ({
    name: "w",
    steps: [{ id: "plan", agent: mock({ attempts: [{}] }), verification, contextBudget }],
  });

  it("accepts a positive whole number of bytes", () => {
    expect(validateWorkflow(step({ maxBytes: 2048 }))).toEqual([]);
  });

  it.each([
    [{ maxBytes: 0 }, "`contextBudget.maxBytes` must be a whole number of bytes above 0"],
    [{ maxBytes: 1.5 }, "`contextBudget.maxBytes` must be a whole number of bytes above 0"],
    [{}, "`contextBudget.maxBytes` must be a whole number of bytes above 0"],
    [{ maxBytes: 10, maxTokens: 3 }, "unknown property `contextBudget.maxTokens`"],
    [2048, "`contextBudget` must be an object `{ maxBytes }`"],
  ])("refuses %j", (budget, message) => {
    expect(validateWorkflow(step(budget))).toEqual([`step "plan": ${message}`]);
  });

  it("refuses a budget on a step that hands nothing on", () => {
    expect(validateWorkflow(step({ maxBytes: 10 }, { command: "node ok.mjs" }))).toEqual([
      'step "plan": `contextBudget` limits the output fields a step hands on, and this step requires none',
    ]);
  });
});

describe("the budget in the handoff and the prompt", () => {
  async function planHandoff(): Promise<HandoffRevision> {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const { state } = await runWorkflow(budgeted([{ outputFields: long }, { outputFields: short }], 256), { repo });
    return state.steps[0]!.handoffs[1]!.handoff;
  }

  it("is stated to the agent, and so is a failure against it", async () => {
    const prompt = promptFor(await planHandoff(), [], undefined);

    expect(prompt).toContain(`at most 256 bytes`);
    expect(prompt).toContain(`The fields you reported came to ${bytesOf(long)} bytes as JSON, over this step's budget of 256 bytes.`);
  });

  it("is carried into a revision of a handoff issued under protocol 0.1.0, which then validates under the current one", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const commit = git(repo, "rev-parse", "HEAD");
    const issued = await planHandoff();
    // As a 0.1.0 AHP wrote it: no budget in its contract.
    const { contextBudget: _budget, ...acceptance } = issued.contract.acceptance;
    const older = { ...issued, schemaVersion: "0.1.0", base: { commit }, revision: 1, supersedes: null, evidence: [], contract: { ...issued.contract, acceptance } } as unknown as HandoffRevision;

    const next = reviseHandoff(older, { evidence: [{ kind: "context_over_budget", bytes: 300, maxBytes: 256 }] });

    expect(next.schemaVersion).toBe(issued.schemaVersion);
    expect(next.contract.acceptance.contextBudget).toBeNull();
    const validation = await validateHandoff(next, { repo });
    expect(validation).toMatchObject({ accepted: true });
  });
});
