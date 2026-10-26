import { defineWorkflow, mock } from "../../src/index.ts";
import type { MockAttemptScript, StepDefinition, WorkflowStepDefinition } from "../../src/index.ts";
import { implementStep } from "./review.ts";

/** An approval gate: no coding agent, only the step id. */
export const gateStep = (id = "approve"): WorkflowStepDefinition => ({ id, approval: {} });

/**
 * A step after the gate. It checks the greeting the implementing step wrote, which is in its workspace only if the
 * step received that step's result across the gate.
 */
export const afterGateStep = (attempts: MockAttemptScript[]): StepDefinition => ({
  id: "publish",
  agent: mock({ attempts }),
  verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
});

/** Implement, then a gate, then whatever else `rest` lists. */
export const gatedWorkflow = (implement: ReturnType<typeof implementStep>, ...rest: WorkflowStepDefinition[]) =>
  defineWorkflow({ name: "gated", steps: [implement, gateStep(), ...rest] });
