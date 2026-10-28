import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTask } from "../src/evaluation/index.ts";
import { APPROVES, DOES_NOTHING, evaluate, GREETS, greetingTaskDir, IMPLEMENTS, PLANS, REQUESTS_CHANGES, runEventsOf, runOf, scripted, suiteOf, trialOf } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

// After the whole file: a describe's trials are run once, in `beforeAll`, and read by several tests.
afterAll(removeTempRepos);

describe("an evaluation of C0", () => {
  it("freezes every task in the ledger before any trial starts, then scores the trial by the validators", async () => {
    const dir = greetingTaskDir();
    const frozen = await loadTask(dir);

    const { types, events, report } = await evaluate(suiteOf([dir], { implement: scripted(GREETS) }, { conditions: ["C0"] }));

    expect(types).toEqual(["evaluation_created", "task_frozen", "trials_scheduled", "trial_started", "trial_ended", "evaluation_ended"]);
    expect(events[1]).toMatchObject({
      type: "task_frozen",
      taskId: "greeting",
      taskHash: frozen.hash,
      hiddenTestsHash: frozen.hiddenTestsHash,
      hiddenTests: ["check-greeting.mjs"],
      constraints: ["no-goodbye"],
    });
    expect(events[4]).toMatchObject({
      type: "trial_ended",
      outcome: "scored",
      mock: true,
      score: { verdict: "pass", tests: { exitCode: 0 }, protectedPathViolations: [], constraints: [{ id: "no-goodbye", outcome: "held" }] },
    });
    expect(report.conditions).toEqual([expect.objectContaining({ condition: "C0", trials: 1, scored: 1, passes: 1, successRate: 1, constraintViolations: 0 })]);
  });

  it("scores a trial whose agent did not do the work as a failure, never a pass", async () => {
    const { report, events } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(DOES_NOTHING) }, { conditions: ["C0"] }));

    expect(events.find((event) => event.type === "trial_ended")).toMatchObject({ outcome: "scored", score: { verdict: "fail", tests: { exitCode: 1 } } });
    expect(report.conditions[0]).toMatchObject({ scored: 1, passes: 0, successRate: 0 });
  });
});

describe("an evaluation of C3", () => {
  const c3 = (agents: Parameters<typeof suiteOf>[1], more = {}) => suiteOf([greetingTaskDir()], agents, { conditions: ["C3"], ...more });

  describe("on a task with the package-registries stance, run under C0 and C3 together", () => {
    // One evaluation, read by several tests: what a trial does is observed, not re-run for each thing said about it.
    let run: Awaited<ReturnType<typeof evaluate>>;
    beforeAll(async () => {
      const task = greetingTaskDir({ network: { stance: "package_registries" } });
      run = await evaluate(suiteOf([task], { plan: scripted(PLANS), implement: scripted(IMPLEMENTS), review: scripted(APPROVES) }, { conditions: ["C0", "C3"] }));
    });

    it("runs plan, implement and review as an ordinary workflow, scored by the validators like C0", async () => {
      const [first, trial] = [trialOf(run.state, "C0"), trialOf(run.state, "C3")];
      expect(first!.ended).toMatchObject({ outcome: "scored", attempts: 1, score: { verdict: "pass" } });
      expect(trial!.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 3, score: { verdict: "pass" } });
      const steps = (await runOf(run.dir, trial!)).steps;
      expect(steps.map((step) => [step.id, step.kind])).toEqual([["plan", "agent"], ["implement", "agent"], ["review", "review"]]);
      expect(run.report.conditions.map((condition) => [condition.condition, condition.scored, condition.passes])).toEqual([["C0", 1, 1], ["C3", 1, 1]]);
    });

    it("tells the planted constraints to the first step only, so a later one has them only from its handoff", async () => {
      const steps = (await runOf(run.dir, trialOf(run.state, "C3"))).steps;
      const [plan, implement, review] = steps.map((step) => step.handoffs[0]!.handoff);
      const forbidden = "Never write the word goodbye";
      expect(plan!.contract.instructions).toContain("Create greeting.txt containing the word hello.");
      expect(plan!.contract.instructions).toContain(forbidden);
      expect(implement!.contract.instructions).not.toContain(forbidden);
      expect(review!.contract.instructions).not.toContain(forbidden);
      // What the later steps know of them is the previous step's required output fields, as the handoff carries them.
      expect(implement!.context.fields.constraints).toEqual(PLANS.outputFields!.constraints);
      expect(review!.context.fields.constraints).toEqual(PLANS.outputFields!.constraints);
    });

    it("gives every step of both conditions the task's network stance and an `abort` recovery policy, and has no approval gate or external action", async () => {
      expect(run.state.trials.map((trial) => trial.condition).sort()).toEqual(["C0", "C3"]);
      for (const trial of run.state.trials) {
        const created = (await runEventsOf(run.dir, trial)).find((event) => event.type === "run_created");
        if (created?.type !== "run_created") throw new Error("no run_created");
        expect(created.workflow.steps.length).toBe(trial.condition === "C0" ? 1 : 3);
        for (const step of created.workflow.steps) {
          expect(step).toMatchObject({ recovery: "abort", network: { stance: "package_registries" } });
          expect(step).not.toHaveProperty("approval");
          expect(step).not.toHaveProperty("action");
        }
      }
    });
  });

  it("verifies the implement step against the hidden tests, which the agent is never sent, and retries it on a failure", async () => {
    const wrong = { ...IMPLEMENTS, edits: [{ path: "greeting.txt", content: "wrong\n" }] };
    const { dir, state } = await evaluate(c3({ plan: scripted(PLANS), implement: scripted(wrong, IMPLEMENTS), review: scripted(APPROVES) }));

    const run = await runOf(dir, state.trials[0]!);
    const implement = run.steps[1]!;
    expect(implement.attempts.map((attempt) => attempt.verification?.state)).toEqual(["fail", "pass"]);
    expect(state.trials[0]!.ended).toMatchObject({ outcome: "scored", attempts: 4, score: { verdict: "pass" } });
    // The second revision carries the failed verification as evidence: with the hidden tests' output withheld.
    expect(implement.handoffs).toHaveLength(2);
    for (const { handoff } of implement.handoffs) expect(JSON.stringify(handoff)).not.toContain("greeting missing or wrong");
  });

  it("sends the implement step back when the review asks for changes", async () => {
    const { dir, state } = await evaluate(c3({ plan: scripted(PLANS), implement: scripted(IMPLEMENTS, IMPLEMENTS), review: scripted(REQUESTS_CHANGES, APPROVES) }));

    const run = await runOf(dir, state.trials[0]!);
    expect(run.steps[1]!.attempts).toHaveLength(2);
    expect(run.steps[1]!.retryUsage.retries).toBe(1);
    expect(state.trials[0]!.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 5 });
  });
});
