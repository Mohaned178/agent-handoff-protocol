import { afterEach, describe, expect, it } from "vitest";
import { COMPARISONS, formatReport, replayEvaluation, reportOf, type EvaluationEvent } from "../src/evaluation/index.ts";
import { C3C_CONTEXT_BUDGET } from "../src/evaluation/conditions.ts";
import type { OutputFieldValue } from "../src/index.ts";
import { APPROVES, evaluate, greetingTaskDir, IMPLEMENTS, PLANS, runEventsOf, runOf, scripted, suiteOf } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** Written from the ticket, not imported: UTF-8 bytes of the handed-on fields as JSON. */
const bytesOf = (fields: Record<string, OutputFieldValue> | undefined) => Buffer.byteLength(JSON.stringify(fields ?? {}), "utf8");

const c3Agents = () => ({ plan: scripted(PLANS), implement: scripted(IMPLEMENTS), review: scripted(APPROVES) });

const workflowOf = async (dir: string, trial: Parameters<typeof runEventsOf>[1]) => {
  const created = (await runEventsOf(dir, trial)).find((event) => event.type === "run_created");
  if (created?.type !== "run_created") throw new Error("no run_created");
  return created.workflow;
};

describe("the size of every handoff", () => {
  it("is recorded for each handoff issued in a trial: its step, the step it came from, its revision and its context's bytes", async () => {
    const { state } = await evaluate(suiteOf([greetingTaskDir()], c3Agents(), { conditions: ["C3"] }));

    expect(state.trials[0]!.ended!.handoffs).toEqual([
      { stepId: "plan", fromStepId: null, handoffId: expect.stringMatching(/^hnd_/), revision: 1, bytes: 2 },
      { stepId: "implement", fromStepId: "plan", handoffId: expect.stringMatching(/^hnd_/), revision: 1, bytes: bytesOf(PLANS.outputFields) },
      { stepId: "review", fromStepId: "implement", handoffId: expect.stringMatching(/^hnd_/), revision: 1, bytes: bytesOf(IMPLEMENTS.outputFields) },
    ]);
  });

  it("is recorded for a retry's revision too, which carries the same context", async () => {
    const wrong = { ...IMPLEMENTS, edits: [{ path: "greeting.txt", content: "wrong\n" }] };
    const agents = { plan: scripted(PLANS), implement: scripted(wrong, IMPLEMENTS), review: scripted(APPROVES) };

    const { state } = await evaluate(suiteOf([greetingTaskDir()], agents, { conditions: ["C3"] }));

    const implement = state.trials[0]!.ended!.handoffs!.filter((handoff) => handoff.stepId === "implement");
    expect(implement.map((handoff) => [handoff.revision, handoff.bytes])).toEqual([
      [1, bytesOf(PLANS.outputFields)],
      [2, bytesOf(PLANS.outputFields)],
    ]);
  });

  it("is reported per condition as the median and total bytes handed on, each context counted once", async () => {
    const wrong = { ...IMPLEMENTS, edits: [{ path: "greeting.txt", content: "wrong\n" }] };
    const agents = { plan: scripted(PLANS), implement: scripted(wrong, IMPLEMENTS), review: scripted(APPROVES) };

    const { report } = await evaluate(suiteOf([greetingTaskDir()], agents, { conditions: ["C3", "C0"] }));

    const plan = bytesOf(PLANS.outputFields);
    const implement = bytesOf(IMPLEMENTS.outputFields);
    const c3 = report.conditions.find((condition) => condition.condition === "C3")!;
    // The retry's revision 2 hands on the plan again: it is the same context, not more of it.
    expect(c3.context).toEqual({ trials: 1, handoffs: 2, medianBytes: (plan + implement) / 2, totalBytes: plan + implement });
    // C0's one step is handed nothing.
    const c0 = report.conditions.find((condition) => condition.condition === "C0")!;
    expect(c0.context).toEqual({ trials: 1, handoffs: 0, medianBytes: null, totalBytes: 0 });
    const text = formatReport(report);
    expect(text).toContain(`  context handed on, over 1 scored trial: 2 handoffs, median ${(plan + implement) / 2} bytes, total ${plan + implement} bytes`);
    expect(text).toContain("  context handed on, over 1 scored trial: none: no step was handed another's result");
  });

  it("is absent from a ledger written before it was recorded, which still replays and reports no context", async () => {
    const { events } = await evaluate(suiteOf([greetingTaskDir()], c3Agents(), { conditions: ["C3"] }));
    const older = events.map((event) => {
      if (event.type !== "trial_ended") return event;
      const { handoffs: _handoffs, ...rest } = event;
      return rest as EvaluationEvent;
    });

    const report = reportOf(replayEvaluation(older));

    expect(report.conditions[0]!.context).toEqual({ trials: 0, handoffs: 0, medianBytes: null, totalBytes: 0 });
    expect(formatReport(report)).not.toContain("context handed on");
  });
});

describe("C3c, full AHP with a context budget", () => {
  it("runs C3's steps, each held to the budget and told it", async () => {
    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], c3Agents(), { conditions: ["C3c"] }));

    const trial = state.trials[0]!;
    expect(trial.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 3, score: { verdict: "pass" } });
    expect(C3C_CONTEXT_BUDGET).toBe(2048);
    const workflow = await workflowOf(dir, trial);
    expect(workflow.steps.map((step) => step.id)).toEqual(["plan", "implement", "review"]);
    for (const step of workflow.steps) {
      expect(step).toMatchObject({ contextBudget: { maxBytes: 2048 }, retry: { budget: 2 }, recovery: "abort" });
      expect((step as { instructions: string }).instructions).toContain("2048 bytes");
    }
    expect(workflow.steps[1]).toMatchObject({ verification: { command: "node visible-check.mjs" } });
    expect(workflow.steps[2]).toMatchObject({ review: { sendBackTo: "implement" } });
    const run = await runOf(dir, trial);
    expect(run.steps.map((step) => step.handoffs[0]!.handoff.contract.acceptance.contextBudget)).toEqual(Array(3).fill({ maxBytes: 2048 }));
  });

  it("fails a step whose handed-on fields are over the budget and retries it with the bytes as evidence", async () => {
    const wordy = { outputFields: { ...PLANS.outputFields, summary: "x".repeat(C3C_CONTEXT_BUDGET) } };
    const agents = { plan: scripted(wordy, PLANS), implement: scripted(IMPLEMENTS), review: scripted(APPROVES) };

    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], agents, { conditions: ["C3c"] }));

    const trial = state.trials[0]!;
    expect(trial.ended).toMatchObject({ outcome: "scored", runState: "succeeded", attempts: 4, retries: 1, score: { verdict: "pass" } });
    const run = await runOf(dir, trial);
    expect(run.steps[0]!.attempts[0]!.failureClass).toBe("verification_failed");
    expect(run.steps[0]!.handoffs[1]!.handoff.evidence).toEqual([{ kind: "context_over_budget", bytes: bytesOf(wordy.outputFields), maxBytes: C3C_CONTEXT_BUDGET }]);
    expect(trial.ended!.handoffs!.find((handoff) => handoff.stepId === "implement")!.bytes).toBe(bytesOf(PLANS.outputFields));
  });

  it("is refused on a task with no acceptance check, as C3 is", async () => {
    const task = greetingTaskDir({ verification: { command: "node check-greeting.mjs" } });

    const error = await evaluate(suiteOf([task], c3Agents(), { conditions: ["C3c"] })).then(() => null, (e: unknown) => e);

    expect((error as { problems: string[] }).problems).toEqual([expect.stringMatching(/^task "greeting", C3c: the task has no `verification.acceptance`/)]);
  });

  it("needs a plan and a review agent, as C3 does", async () => {
    const error = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(IMPLEMENTS) }, { conditions: ["C3c"] })).then(() => null, (e: unknown) => e);

    expect(String((error as { problems: string[] }).problems)).toMatch(/plan/);
  });

  it("is compared with C3", () => {
    expect(COMPARISONS).toContainEqual(["C3c", "C3"]);
  });
});
