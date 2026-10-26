import { describe, expect, it } from "vitest";
import { defineWorkflow, mock, validateWorkflow, WorkflowValidationError } from "../src/index.ts";
import { gateStep } from "./helpers/approval.ts";
import { implementStep, reviewStep } from "./helpers/review.ts";

const agent = (id: string) => ({ id, agent: mock({ attempts: [{}] }), verification: { requiredOutputFields: ["summary"] } });

describe("validating a workflow with an approval gate", () => {
  it("accepts a gate after an agent step, and steps after the gate", () => {
    expect(validateWorkflow({ name: "ok", steps: [agent("implement"), gateStep(), agent("publish")] })).toEqual([]);
    expect(validateWorkflow({ name: "ok", steps: [implementStep([{}]), reviewStep([{}]), gateStep("gate")] })).toEqual([]);
    expect(() => defineWorkflow({ name: "ok", steps: [agent("implement"), gateStep()] })).not.toThrow();
  });

  it("rejects a gate with nothing before it to send back", () => {
    expect(validateWorkflow({ name: "w", steps: [gateStep(), agent("implement")] })).toEqual([
      'step "approve": an approval gate needs a step before it, which a rejection sends back, and this is the first step',
    ]);
  });

  it("rejects a gate that follows a gate: a rejection could send back only a step with no coding agent", () => {
    const problems = validateWorkflow({ name: "w", steps: [agent("implement"), gateStep("first"), gateStep("second")] });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('step "second": follows approval gate "first"');
    expect(problems[0]).toContain("must be performed by a coding agent (ADR 0004)");
  });

  it("rejects a review that would send a gate back", () => {
    const review = { id: "review", agent: mock({ attempts: [{}] }), review: { sendBackTo: "approve" }, verification: {} };

    const problems = validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), review] });

    expect(problems).toEqual(['step "review": `review.sendBackTo` names "approve", an approval gate: it has no coding agent to send back']);
  });

  it("rejects what a gate has no use for, and says why", () => {
    const problems = validateWorkflow({
      name: "w",
      steps: [agent("implement"), { id: "approve", approval: {}, agent: { adapter: "mock" }, verification: {}, colour: "red" }],
    });

    expect(problems).toEqual([
      'step "approve": an approval gate has no coding agent and nothing to verify, so it takes no `agent`',
      'step "approve": an approval gate has no coding agent and nothing to verify, so it takes no `verification`',
      'step "approve": unknown property `colour`',
    ]);
  });

  it("rejects an approval that is not an empty object, a bad id and a repeated id", () => {
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), { id: "approve", approval: true }] })).toEqual([
      'step "approve": `approval` must be an object (an empty one: a gate takes no options)',
    ]);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), { id: "approve", approval: { who: "me" } }] })).toEqual([
      'step "approve": unknown property `approval.who`',
    ]);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), { id: "Bad Id", approval: {} }] })).toHaveLength(1);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), { id: "implement", approval: {} }] })).toEqual(['step "implement": duplicate step id']);
  });

  it("throws the problems from defineWorkflow", () => {
    expect(() => defineWorkflow({ name: "w", steps: [gateStep()] })).toThrow(WorkflowValidationError);
  });
});
