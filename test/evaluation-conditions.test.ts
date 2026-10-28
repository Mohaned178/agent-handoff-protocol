import { afterEach, describe, expect, it } from "vitest";
import { APPROVES, evaluate, GREETS, greetingTaskDir, IMPLEMENTS, PLANS, REQUESTS_CHANGES, runEventsOf, runOf, scripted, suiteOf } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** C1's agents report one field of free text, `output`, which is all the next step is handed. */
const PLANS_IN_TEXT = { outputFields: { output: "Write greeting.txt with hello in it. Never write the word goodbye anywhere." } };
const IMPLEMENTS_IN_TEXT = { ...GREETS, outputFields: { output: "Wrote greeting.txt. Never write the word goodbye anywhere." } };
const REVIEWS_IN_TEXT = { outputFields: { output: "Looks right." } };

const workflowOf = async (dir: string, trial: Parameters<typeof runEventsOf>[1]) => {
  const created = (await runEventsOf(dir, trial)).find((event) => event.type === "run_created");
  if (created?.type !== "run_created") throw new Error("no run_created");
  return created.workflow;
};

describe("C1, the plain-text pipeline", () => {
  it("runs the same three agents, each handing the next only its text, with no acceptance check and no retry", async () => {
    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], { plan: scripted(PLANS_IN_TEXT), implement: scripted(IMPLEMENTS_IN_TEXT), review: scripted(REVIEWS_IN_TEXT) }, { conditions: ["C1"] }));

    const trial = state.trials[0]!;
    expect(trial.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 3, score: { verdict: "pass" } });
    const workflow = await workflowOf(dir, trial);
    expect(workflow.steps.map((step) => step.id)).toEqual(["plan", "implement", "review"]);
    for (const step of workflow.steps) {
      expect(step).toMatchObject({ retry: { budget: 0 }, recovery: "abort", verification: { requiredOutputFields: ["output"] } });
      expect(step).not.toHaveProperty("review");
      expect((step as { verification: object }).verification).not.toHaveProperty("command");
      expect((step as { verification: object }).verification).not.toHaveProperty("hiddenTests");
    }
    const run = await runOf(dir, trial);
    expect(run.steps.map((step) => step.kind)).toEqual(["agent", "agent", "agent"]);
    // What a later step knows of the task is the text before it: the plan's, then the implementer's.
    expect(run.steps[1]!.handoffs[0]!.handoff.context.fields).toEqual({ output: PLANS_IN_TEXT.outputFields.output });
    expect(run.steps[2]!.handoffs[0]!.handoff.context.fields).toEqual({ output: IMPLEMENTS_IN_TEXT.outputFields.output });
  });

  it("does not retry work the validators then fail: one attempt per step", async () => {
    const wrong = { ...IMPLEMENTS_IN_TEXT, edits: [{ path: "greeting.txt", content: "wrong\n" }] };

    const { state } = await evaluate(suiteOf([greetingTaskDir()], { plan: scripted(PLANS_IN_TEXT), implement: scripted(wrong), review: scripted(REVIEWS_IN_TEXT) }, { conditions: ["C1"] }));

    expect(state.trials[0]!.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 3, score: { verdict: "fail" } });
  });
});

describe("C2, AHP handoffs without acceptance checks or retry", () => {
  it("hands on the structured fields C3 hands on, but verifies nothing but their presence, and a review asking for changes sends nothing back", async () => {
    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], { plan: scripted(PLANS), implement: scripted(IMPLEMENTS), review: scripted(REQUESTS_CHANGES) }, { conditions: ["C2"] }));

    const trial = state.trials[0]!;
    expect(trial.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 3, score: { verdict: "pass" } });
    const workflow = await workflowOf(dir, trial);
    expect(workflow.steps.map((step) => [step.id, (step as { verification: { requiredOutputFields: string[] } }).verification.requiredOutputFields])).toEqual([
      ["plan", ["summary", "decisions", "constraints"]],
      ["implement", ["summary", "decisions", "constraints"]],
      ["review", ["verdict", "findings"]],
    ]);
    for (const step of workflow.steps) {
      expect(step).toMatchObject({ retry: { budget: 0 }, recovery: "abort" });
      expect(step).not.toHaveProperty("review");
      expect(Object.keys((step as { verification: object }).verification)).toEqual(["requiredOutputFields"]);
    }
    const run = await runOf(dir, trial);
    expect(run.steps[1]!.handoffs[0]!.handoff.context.fields).toEqual(PLANS.outputFields);
    expect(run.steps.map((step) => step.attempts.length)).toEqual([1, 1, 1]);
  });

  it("stops the pipeline when a step does not report a field its handoff carries, and scores what was left", async () => {
    const forgets = { outputFields: { summary: "Write greeting.txt.", decisions: ["greeting.txt"] } };

    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], { plan: scripted(forgets), implement: scripted(IMPLEMENTS), review: scripted(APPROVES) }, { conditions: ["C2"] }));

    expect(state.trials[0]!.ended).toMatchObject({ outcome: "scored", runState: "failed", failureClass: "verification_failed", attempts: 1, score: { verdict: "fail" } });
    expect((await runOf(dir, state.trials[0]!)).steps.map((step) => step.attempts.length)).toEqual([1, 0, 0]);
  });

  it("tells every condition's first step the task and its constraints, and gives C1 and C2 the instructions C3's steps have", async () => {
    const agents = { plan: scripted(PLANS), implement: scripted(IMPLEMENTS), review: scripted(APPROVES) };
    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], agents, { conditions: ["C2", "C3"] }));

    const [c2, c3] = await Promise.all(["C2", "C3"].map(async (condition) => workflowOf(dir, state.trials.find((trial) => trial.condition === condition)!)));
    expect(c2!.steps.map((step) => (step as { instructions: string }).instructions)).toEqual(c3!.steps.map((step) => (step as { instructions: string }).instructions));
    expect((c2!.steps[0] as { instructions: string }).instructions).toContain("Never write the word goodbye");
  });
});
