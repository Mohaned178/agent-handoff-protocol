// The condition runners: each builds an ordinary workflow for a task, which the SDK's run API then runs. Evaluation adds
// no execution path of its own, so what a condition does is what `ahp run` would do with the same workflow.
//
// Every workflow it builds is made of agent steps only: no approval gate and no external action, so a trial never waits
// for a person and nothing is published. Every step recovers an `unknown` attempt by `abort`, never `manual`: a trial
// has no person to wait for, and its run then ends instead of stopping, leaving the attempt `unknown` for the trial to
// record as a harness incident. The task's network stance is on every step of every condition.

import type { AgentRef, NetworkStance, StepDefinition, WorkflowDefinition } from "../protocol/index.ts";
import type { ConditionId } from "./events.ts";
import { agentFor, DEFAULT_RETRY_BUDGET, type EvaluationSuite } from "./suite.ts";
import type { EvaluationTask } from "./task.ts";

/** What every step of a condition has in common. */
const commonOf = (stance: NetworkStance): Pick<StepDefinition, "network" | "recovery"> => ({ network: { stance }, recovery: "abort" });

/**
 * The task as the first agent of a condition is told it: the prompt, then every planted constraint. Only that first step
 * is told the constraints; a later step of C3 learns them only through its handoff's context.
 */
export function taskText(task: EvaluationTask): string {
  const constraints = task.constraints.map((constraint) => `- ${constraint.statement}`);
  return constraints.length === 0 ? task.prompt : `${task.prompt}\n\nThese constraints must hold in the final result:\n${constraints.join("\n")}`;
}

const agentOf = (suite: EvaluationSuite, role: "plan" | "implement" | "review", task: EvaluationTask): AgentRef => {
  const source = suite.agents[role];
  if (source === undefined) throw new Error(`the suite names no agent for the role "${role}"`);
  return agentFor(source, task);
};

/**
 * The workflow `condition` runs for `task`. C0: one coding agent, the suite's `implement` one, does the whole task in one
 * attempt, with no retry and no acceptance check beyond a summary being reported: how it did is for the validators to say.
 */
export function workflowFor(condition: ConditionId, task: EvaluationTask, suite: EvaluationSuite): WorkflowDefinition {
  const common = commonOf(task.network.stance);
  switch (condition) {
    case "C0":
      return {
        name: `${task.id}-C0`,
        steps: [
          {
            id: "solve",
            agent: agentOf(suite, "implement", task),
            instructions: `${taskText(task)}\n\nDo the whole task in this workspace.`,
            verification: { requiredOutputFields: ["summary"] },
            retry: { budget: 0 },
            ...common,
          },
        ],
      };
    case "C3": {
      const retry = { budget: suite.retryBudget ?? DEFAULT_RETRY_BUDGET };
      // What each of the first two steps reports, and so what the next receives as its handoff context.
      const handedOn = ["summary", "decisions", "constraints"];
      const { command, install, protectedPaths } = task.verification;
      return {
        name: `${task.id}-C3`,
        steps: [
          {
            id: "plan",
            agent: agentOf(suite, "plan", task),
            instructions: `${taskText(task)}\n\nPlan the work; do not change any file. Report your summary, the decisions you made, and every constraint the work must respect: restate each one you were given.`,
            capabilities: [{ kind: "read_only" }],
            verification: { requiredOutputFields: handedOn },
            retry,
            ...common,
          },
          {
            id: "implement",
            agent: agentOf(suite, "implement", task),
            instructions:
              "Implement the plan you were handed. Follow its decisions and respect every one of its constraints. Report your summary, your decisions, and every constraint you kept: restate each one.",
            // The hidden tests are this step's acceptance, which its agent never sees; a failure sends it back with the evidence.
            verification: { command, ...(install !== undefined ? { install } : {}), hiddenTests: task.hiddenTests, protectedPaths, requiredOutputFields: handedOn },
            retry,
            ...common,
          },
          {
            id: "review",
            agent: agentOf(suite, "review", task),
            instructions:
              "Review the implementation in this workspace against the decisions and constraints you were handed. Do not change any file. Report your verdict and your findings.",
            review: { sendBackTo: "implement" },
            capabilities: [{ kind: "read_only" }],
            verification: {},
            retry,
            ...common,
          },
        ],
      };
    }
  }
}
