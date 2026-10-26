import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow, mock, readRun, readRunEvents, resumeRun, runWorkflow, validateWorkflow, WorkflowValidationError } from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { appendLedgerEvent, truncateLedgerAfter } from "./helpers/ledger.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { approved, changesRequested, implemented, implementStep, reviewedWorkflow, reviewStep, stepOf } from "./helpers/review.ts";
import { goodbye } from "./helpers/retry.ts";

afterEach(removeTempRepos);

const fixture = () => createTempRepo({ "verify.mjs": VERIFY_GREETING });

describe("a review that requests changes", () => {
  it("sends the preceding step back under a new handoff revision that carries the findings, then reviews the new result", async () => {
    const repo = fixture();
    const findings = ["greeting should be a constant", "add a test"];
    const workflow = reviewedWorkflow(
      implementStep([implemented(1), implemented(2)]),
      reviewStep([changesRequested(...findings), approved()]),
    );

    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const implement = stepOf(state, "implement");
    const review = stepOf(state, "review");
    expect([implement.state, review.state]).toEqual(["succeeded", "succeeded"]);

    // The implementing step ran twice, under one handoff whose second revision carries the findings.
    expect(implement.attempts).toHaveLength(2);
    expect(implement.handoffs.map((h) => [h.revision, h.supersedes, h.state])).toEqual([
      [1, null, "superseded"],
      [2, 1, "accepted"],
    ]);
    expect(implement.handoffs[0]!.handoff.evidence).toEqual([]);
    expect(implement.handoffs[1]!.handoff.evidence).toEqual([{ kind: "review_findings", reviewStepId: "review", findings }]);
    expect(implement.attempts.map((a) => a.handoff.revision)).toEqual([1, 2]);
    // The first attempt passed: nothing about it failed, and the send-back is what it is recorded under.
    expect(implement.attempts[0]!.failureClass).toBeNull();
    expect(implement.attempts[0]!.sentBack).toMatchObject({ reviewStepId: "review", findings });
    expect(implement.attempts[1]!.sentBack).toBeNull();
    // It spent a retry of the step's budget.
    expect(implement.retryUsage.retries).toBe(1);

    // A new attempt in a new workspace, from the step's base commit.
    const [first, second] = implement.attempts;
    expect(second!.workspace).not.toBe(first!.workspace);
    expect(git(repo, "rev-parse", `${second!.snapshot!.commit}^`)).toBe(state.baseCommit);
    expect(git(repo, "show", `${second!.snapshot!.commit}:round.txt`)).toBe("round 2");
    expect(existsSync(join(second!.workspace, "round.txt"))).toBe(true);

    // The review ran twice, and the second time on the new result, not on the first round's.
    expect(review.attempts).toHaveLength(2);
    expect(review.attempts.map((a) => a.reportedOutput.verdict)).toEqual(["changes_requested", "approved"]);
    const [round1, round2] = review.handoffs;
    expect(round1!.handoff.from).toEqual({ stepId: "implement", attemptId: first!.id });
    expect(round1!.handoff.base.commit).toBe(first!.snapshot!.commit);
    expect(round2!.handoff.from).toEqual({ stepId: "implement", attemptId: second!.id });
    expect(round2!.handoff.base.commit).toBe(second!.snapshot!.commit);
    expect(round2!.handoff.handoffId).not.toBe(round1!.handoff.handoffId);
    expect(round2!.handoff.context.fields).toMatchObject({ summary: "implemented in round 2" });
    expect(review.attempts.map((a) => a.handoff.id)).toEqual([round1!.handoffId, round2!.handoffId]);

    // The ledger shows the intent in order: the review's verdict, the send-back, the new revision, the new attempt.
    const events = await readRunEvents({ repo, runId });
    const types = events.map((e) => e.type);
    const sentBack = types.indexOf("step_sent_back");
    expect(types.slice(sentBack - 1, sentBack + 4)).toEqual([
      "verification_verdict",
      "step_sent_back",
      "handoff_issued",
      "handoff_accepted",
      "attempt_created",
    ]);
    expect(events[sentBack - 1]).toMatchObject({ verdict: "pass" });
    expect(events[sentBack]).toMatchObject({ type: "step_sent_back", stepId: "implement", reviewStepId: "review" });
  });

  it("keeps the findings with the sent-back step if it then fails verification and is retried", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(
      implementStep([implemented(1), goodbye, implemented(3)], { verification: { command: "node verify.mjs" } }),
      reviewStep([changesRequested("rename it"), approved()]),
    );

    const { state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const implement = stepOf(state, "implement");
    expect(implement.retryUsage.retries).toBe(2);
    const [, sentBack, retried] = implement.handoffs.map((h) => h.handoff.evidence.map((e) => e.kind));
    expect(sentBack).toEqual(["review_findings"]);
    expect(retried).toEqual(["review_findings", "test_output"]);
  });

  it("is not sent back when the review approves", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(implementStep([implemented(1)]), reviewStep([approved("looks right")]));

    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    expect(stepOf(state, "implement").attempts).toHaveLength(1);
    expect(stepOf(state, "implement").retryUsage.retries).toBe(0);
    expect((await readRunEvents({ repo, runId })).some((e) => e.type === "step_sent_back")).toBe(false);
  });
});

describe("the send-back budget", () => {
  it.each([
    { budget: 0, sendBacks: 0 },
    { budget: 1, sendBacks: 1 },
    { budget: 2, sendBacks: 2 },
  ])("is the preceding step's retry budget: with $budget it is sent back $sendBacks time(s), then the run fails", async ({ budget, sendBacks }) => {
    const repo = fixture();
    const rounds = Array.from({ length: sendBacks + 1 }, (_, i) => implemented(i + 1));
    const reviews = rounds.map(() => changesRequested("still wrong"));
    const workflow = reviewedWorkflow(implementStep(rounds, { retry: { budget } }), reviewStep(reviews));

    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("failed");
    const implement = stepOf(state, "implement");
    const review = stepOf(state, "review");
    expect(implement.attempts).toHaveLength(sendBacks + 1);
    expect(implement.retryUsage.retries).toBe(sendBacks);
    // The work was never accepted, so the review step is the one that failed, and no further agent was dispatched.
    expect([review.state, review.failureClass]).toEqual(["failed", "verification_failed"]);
    expect(review.attempts).toHaveLength(sendBacks + 1);
    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "step_sent_back")).toHaveLength(sendBacks);
    expect(events.at(-2)).toMatchObject({ type: "step_terminal", stepId: "review", state: "failed" });
  });

  it("is shared with failed verification: a retry spent on a failure is not available to the review", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(
      implementStep([goodbye, implemented(1)], { retry: { budget: 1 }, verification: { command: "node verify.mjs" } }),
      reviewStep([changesRequested("rename it")]),
    );

    const { state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("failed");
    const implement = stepOf(state, "implement");
    expect(implement.attempts.map((a) => a.failureClass)).toEqual(["verification_failed", null]);
    expect(implement.retryUsage.retries).toBe(1);
    expect(stepOf(state, "review").failureClass).toBe("verification_failed");
  });
});

describe("a review that reports no usable verdict", () => {
  it("fails verification when the verdict is neither approved nor changes_requested, and is retried with that evidence, never sending anything back", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(
      implementStep([implemented(1)]),
      reviewStep([{ outputFields: { verdict: "maybe", findings: "unsure" } }, approved()]),
    );

    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const review = stepOf(state, "review");
    expect(review.attempts.map((a) => [a.failureClass, a.verification?.state])).toEqual([
      ["verification_failed", "fail"],
      [null, "pass"],
    ]);
    expect(review.attempts[0]!.verification!.evidence).toContainEqual({ kind: "review_verdict", verdict: null, reported: "maybe" });
    // The reviewer is told what it may say.
    expect(review.handoffs[1]!.handoff.evidence).toEqual([
      { kind: "review_verdict", reported: "maybe", allowed: ["approved", "changes_requested"] },
    ]);
    expect(stepOf(state, "implement").attempts).toHaveLength(1);
    expect((await readRunEvents({ repo, runId })).some((e) => e.type === "step_sent_back")).toBe(false);
  });

  it("accepts a verdict with whitespace around it", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(
      implementStep([implemented(1)]),
      reviewStep([{ outputFields: { verdict: " approved\n", findings: "fine" } }]),
    );

    const { state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
  });

  it("fails verification when changes are requested without findings, so a send-back never carries empty evidence", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(
      implementStep([implemented(1)]),
      reviewStep([{ outputFields: { verdict: "changes_requested", findings: ["  "] } }, approved()]),
    );

    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const review = stepOf(state, "review");
    expect(review.attempts[0]!.verification!.evidence).toContainEqual({
      kind: "required_output_fields",
      required: ["verdict", "findings"],
      missing: ["findings"],
    });
    expect(review.handoffs[1]!.handoff.evidence).toEqual([{ kind: "required_output_fields", missing: ["findings"] }]);
    expect(stepOf(state, "implement").attempts).toHaveLength(1);
    expect((await readRunEvents({ repo, runId })).some((e) => e.type === "step_sent_back")).toBe(false);
  });
});

describe("a review step's output", () => {
  it("requires verdict and findings of the reviewer, whatever else the step lists, and hands them on", async () => {
    const repo = fixture();
    const next = { id: "ship", agent: mock({ attempts: [{}] }), verification: { command: "node verify.mjs" } };
    const review = reviewStep([{ outputFields: { verdict: "approved", findings: ["a", "b"], notes: "n" } }], {
      verification: { requiredOutputFields: ["notes", "verdict"] },
    });
    const workflow = defineWorkflow({ name: "three", steps: [implementStep([implemented(1)]), review, next] });

    const { state } = await runWorkflow(workflow, { repo, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const received = stepOf(state, "review").handoffs[0]!.handoff;
    expect(received.contract.acceptance.requiredOutputFields).toEqual(["notes", "verdict", "findings"]);
    // The next step receives what the review reported, so a gate or a later step can show the findings.
    expect(stepOf(state, "ship").handoffs[0]!.handoff.context.fields).toEqual({ notes: "n", verdict: "approved", findings: ["a", "b"] });
  });
});

describe("the static validation of a review step", () => {
  const plain = (id: string) => ({ id, agent: mock({ attempts: [{}] }), verification: { command: "node verify.mjs" } });
  const review = (id: string, sendBackTo: unknown) => ({ ...plain(id), verification: {}, review: { sendBackTo } });

  it.each([
    { name: "the first step", steps: [review("review", "review")], problem: /a review needs a step before it/ },
    {
      name: "two steps back",
      steps: [plain("plan"), plain("implement"), review("review", "plan")],
      problem: /2 steps back: a review sends back only the step immediately before it, "implement"/,
    },
    { name: "an unknown step", steps: [plain("implement"), review("review", "design")], problem: /"design", which is not a step of the workflow/ },
    { name: "itself", steps: [plain("implement"), review("review", "review")], problem: /names the review itself/ },
    { name: "a later step", steps: [plain("implement"), review("review", "ship"), plain("ship")], problem: /"ship", which comes after the review/ },
    { name: "no step at all", steps: [plain("implement"), review("review", undefined)], problem: /`review.sendBackTo` must name the step to send back/ },
    {
      name: "a step, with a property no review has",
      steps: [plain("implement"), { ...review("review", "implement"), review: { sendBackTo: "implement", always: true } }],
      problem: /unknown property `review.always`/,
    },
    { name: "a review that is not an object", steps: [plain("implement"), { ...review("review", "implement"), review: true }], problem: /`review` must be an object/ },
  ])("rejects a review that sends back $name", ({ steps, problem }) => {
    const problems = validateWorkflow({ name: "invalid", steps });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
    expect(() => defineWorkflow({ name: "invalid", steps } as never)).toThrow(WorkflowValidationError);
  });

  it("accepts the step immediately before, and asks nothing of a review's verification but its own fields", () => {
    expect(validateWorkflow({ name: "ok", steps: [plain("plan"), plain("implement"), review("review", "implement")] })).toEqual([]);
  });

  it("still asks a step that is not a review for a command or a required output field", () => {
    const problems = validateWorkflow({ name: "empty", steps: [{ ...plain("implement"), verification: {} }] });

    expect(problems).toEqual(['step "implement": needs a `verification.command` or at least one required output field in `verification.requiredOutputFields`']);
  });
});

describe("the replay of a send-back", () => {
  /** A run cut just after the review's passing verdict, with changes requested: the send-back is the next event. */
  async function reviewedRun() {
    const repo = fixture();
    const plan = { id: "plan", agent: mock({ attempts: [{ outputFields: { summary: "plan" } }] }), verification: { requiredOutputFields: ["summary"] } };
    const workflow = defineWorkflow({
      name: "replay",
      steps: [plan, implementStep([implemented(1), implemented(2)]), reviewStep([changesRequested("fix it"), approved()])],
    });
    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, "verification_verdict", 3);
    return { repo, runId, plan: state.steps[0]!, implement: state.steps[1]!, review: state.steps[2]! };
  }

  it("refuses a send-back that reaches a step other than the one immediately before the review", async () => {
    const { repo, runId, plan, review } = await reviewedRun();

    appendLedgerEvent(repo, runId, {
      type: "step_sent_back",
      stepId: "plan",
      attemptId: plan.attempts[0]!.id,
      reviewStepId: "review",
      reviewAttemptId: review.attempts[0]!.id,
    });

    await expect(readRun({ repo, runId })).rejects.toThrow('step "plan" is not the step immediately before "review"');
  });

  it("refuses a send-back of a review whose verdict was approved", async () => {
    const repo = fixture();
    const workflow = reviewedWorkflow(implementStep([implemented(1)]), reviewStep([approved()]));
    const { runId, state } = await runWorkflow(workflow, { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, "verification_verdict", 2);

    appendLedgerEvent(repo, runId, {
      type: "step_sent_back",
      stepId: "implement",
      attemptId: stepOf(state, "implement").attempts[0]!.id,
      reviewStepId: "review",
      reviewAttemptId: stepOf(state, "review").attempts[0]!.id,
    });

    await expect(readRun({ repo, runId })).rejects.toThrow("did not request changes with findings");
  });

  it("refuses a second send-back of the same attempt", async () => {
    const { repo, runId, implement, review } = await reviewedRun();
    const sendBack = {
      type: "step_sent_back",
      stepId: "implement",
      attemptId: implement.attempts[0]!.id,
      reviewStepId: "review",
      reviewAttemptId: review.attempts[0]!.id,
    };

    appendLedgerEvent(repo, runId, sendBack);
    expect(stepOf(await readRun({ repo, runId }), "implement").state).toBe("ready");
    appendLedgerEvent(repo, runId, sendBack);

    await expect(readRun({ repo, runId })).rejects.toThrow(/not succeeded with attempt/);
  });

  it("refuses a send-back once the run is being cancelled", async () => {
    const { repo, runId, implement, review } = await reviewedRun();

    appendLedgerEvent(repo, runId, { type: "run_cancel_requested" });
    appendLedgerEvent(repo, runId, {
      type: "step_sent_back",
      stepId: "implement",
      attemptId: implement.attempts[0]!.id,
      reviewStepId: "review",
      reviewAttemptId: review.attempts[0]!.id,
    });

    await expect(readRun({ repo, runId })).rejects.toThrow("the run is being cancelled, so no step is sent back");
  });
});

describe("resuming a run around a send-back", () => {
  const roundTrip = () =>
    reviewedWorkflow(implementStep([implemented(1), implemented(2)]), reviewStep([changesRequested("fix it"), approved()]));

  it.each([
    { after: "verification_verdict", nth: 2, cut: "the review's passing verdict, before the send-back" },
    { after: "step_sent_back", nth: 1, cut: "the send-back, before the new revision" },
    { after: "handoff_issued", nth: 3, cut: "the new revision's issue, before it is accepted" },
    { after: "attempt_created", nth: 3, cut: "the sent-back step's new attempt" },
    { after: "handoff_issued", nth: 4, cut: "the second review's handoff" },
  ])("goes on from the ledger cut after $cut, to the same end as an uninterrupted run", async ({ after, nth }) => {
    const repo = fixture();
    const { runId, state: whole } = await runWorkflow(roundTrip(), { repo, clock: fakeClock() });
    truncateLedgerAfter(repo, runId, after, nth);

    const { state } = await resumeRun({ repo, runId, clock: fakeClock() });

    expect(state.state).toBe("succeeded");
    const implement = stepOf(state, "implement");
    // An attempt cut after its creation was never dispatched, so it is taken up and run: still two attempts, one send-back.
    expect(implement.attempts).toHaveLength(2);
    expect(implement.retryUsage.retries).toBe(1);
    expect(implement.handoffs.map((h) => [h.revision, h.state])).toEqual([
      [1, "superseded"],
      [2, "accepted"],
    ]);
    expect(implement.handoffs[1]!.handoff.evidence).toEqual(stepOf(whole, "implement").handoffs[1]!.handoff.evidence);
    expect(stepOf(state, "review").attempts.map((a) => a.reportedOutput.verdict)).toEqual(["changes_requested", "approved"]);
    expect(stepOf(state, "review").handoffs).toHaveLength(2);
    expect(stepOf(state, "review").handoffs[1]!.handoff.from?.attemptId).toBe(implement.attempts[1]!.id);
  });
});
