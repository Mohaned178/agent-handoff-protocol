// The condition runners: each builds an ordinary workflow for a task, which the SDK's run API then runs. Evaluation adds
// no execution path of its own, so what a condition does is what `ahp run` would do with the same workflow.
//
// Every workflow it builds is made of agent steps only: no approval gate and no external action, so a trial never waits
// for a person and nothing is published. Every step recovers an `unknown` attempt by `abort`, never `manual`: a trial
// has no person to wait for, and its run then ends instead of stopping, leaving the attempt `unknown` for the trial to
// record as a harness incident. The task's network stance is on every step of every condition.

import { REVIEW_OUTPUT_FIELDS, type AgentRef, type NetworkStance, type StepDefinition, type WorkflowDefinition } from "../protocol/index.ts";
import type { ConditionId } from "./events.ts";
import { agentFor, DEFAULT_RETRY_BUDGET, type EvaluationRole, type EvaluationSuite, type TrialSlot } from "./suite.ts";
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

const castAgent = (suite: EvaluationSuite, role: EvaluationRole, task: EvaluationTask, slot: TrialSlot): AgentRef => {
  const source = suite.agents[role];
  if (source === undefined) throw new Error(`the suite names no agent for the role "${role}"`);
  return agentFor(source, task, slot);
};

/** What each of the pipeline's first two steps reports in C2 and C3, and so what the next receives as its handoff context. */
const HANDED_ON = ["summary", "decisions", "constraints"];

/** The one field of free text each step of C1 reports, and so all the next is handed. */
const PLAIN_TEXT = "output";

/** What each step of the pipeline (C1, C2, C3) is told to do: the same words in all three, apart from how C1 reports. */
const PIPELINE = {
  plan: "Plan the work; do not change any file.",
  implement: "Implement the plan you were handed. Follow its decisions and respect every one of its constraints.",
  review: "Review the implementation in this workspace against the decisions and constraints you were handed. Do not change any file.",
};

/** The retry budget of every step of `condition`: C3's from the suite (default 2), and none for any other. */
export const retryBudgetOf = (condition: ConditionId, suite: EvaluationSuite): number => (condition === "C3" ? (suite.retryBudget ?? DEFAULT_RETRY_BUDGET) : 0);

/**
 * The workflow `condition` runs for `task`.
 * - C0 (and every trial of the matched-budget baseline): one coding agent, the suite's `implement` one, does the whole task
 *   in one attempt, with no retry and no acceptance check beyond a summary being reported: how it did is for the validators.
 * - C1: the pipeline's three agents, each handing the next one field of free text and nothing else; nothing is checked but
 *   that the text was reported (there is nothing to hand on otherwise), and nothing is retried.
 * - C2: the pipeline with C3's handoffs: the structured fields, each step's handoff validated, the same capability requests;
 *   but no verification command, hidden tests or protected paths, no retry, and a review that sends nothing back.
 * - C3: full AHP: C2 plus the hidden tests as the implement step's acceptance, a retry budget on every step, and a review
 *   that sends `implement` back.
 * Every pipeline step is told the same words in C1, C2 and C3, and only the first is told the task and its constraints.
 */
export function workflowFor(condition: ConditionId, task: EvaluationTask, suite: EvaluationSuite, slot: TrialSlot): WorkflowDefinition {
  const common = commonOf(task.network.stance);
  const agent = (role: EvaluationRole) => castAgent(suite, role, task, slot);
  const noRetry = { budget: retryBudgetOf("C0", suite) };
  switch (condition) {
    case "C0":
    case "baseline":
      return {
        name: `${task.id}-${condition}`,
        steps: [
          {
            id: "solve",
            agent: agent("implement"),
            instructions: `${taskText(task)}\n\nDo the whole task in this workspace.`,
            verification: { requiredOutputFields: ["summary"] },
            retry: noRetry,
            ...common,
          },
        ],
      };
    case "C1": {
      const report = `Report as \`${PLAIN_TEXT}\`, in your own words, everything the next agent needs to know, every constraint the work must respect among it.`;
      return {
        name: `${task.id}-C1`,
        steps: [
          {
            id: "plan",
            agent: agent("plan"),
            instructions: `${taskText(task)}\n\n${PIPELINE.plan} ${report}`,
            capabilities: [{ kind: "read_only" }],
            verification: { requiredOutputFields: [PLAIN_TEXT] },
            retry: noRetry,
            ...common,
          },
          {
            id: "implement",
            agent: agent("implement"),
            instructions: `${PIPELINE.implement} ${report}`,
            verification: { requiredOutputFields: [PLAIN_TEXT] },
            retry: noRetry,
            ...common,
          },
          {
            id: "review",
            agent: agent("review"),
            instructions: `${PIPELINE.review} Report as \`${PLAIN_TEXT}\` your verdict and your findings.`,
            capabilities: [{ kind: "read_only" }],
            verification: { requiredOutputFields: [PLAIN_TEXT] },
            retry: noRetry,
            ...common,
          },
        ],
      };
    }
    case "C2":
    case "C3": {
      const full = condition === "C3";
      const retry = { budget: retryBudgetOf(condition, suite) };
      const { command, install, protectedPaths } = task.verification;
      return {
        name: `${task.id}-${condition}`,
        steps: [
          {
            id: "plan",
            agent: agent("plan"),
            instructions: `${taskText(task)}\n\n${PIPELINE.plan} Report your summary, the decisions you made, and every constraint the work must respect: restate each one you were given.`,
            capabilities: [{ kind: "read_only" }],
            verification: { requiredOutputFields: HANDED_ON },
            retry,
            ...common,
          },
          {
            id: "implement",
            agent: agent("implement"),
            instructions: `${PIPELINE.implement} Report your summary, your decisions, and every constraint you kept: restate each one.`,
            // In C3 the hidden tests are this step's acceptance, which its agent never sees; a failure sends it back with the evidence.
            verification: full
              ? { command, ...(install !== undefined ? { install } : {}), hiddenTests: task.hiddenTests, protectedPaths, requiredOutputFields: HANDED_ON }
              : { requiredOutputFields: HANDED_ON },
            retry,
            ...common,
          },
          {
            id: "review",
            agent: agent("review"),
            instructions: `${PIPELINE.review} Report your verdict and your findings.`,
            // C2's review reports the same fields, as an ordinary step: its verdict is not checked and sends nothing back.
            ...(full ? { review: { sendBackTo: "implement" }, verification: {} } : { verification: { requiredOutputFields: [...REVIEW_OUTPUT_FIELDS] } }),
            capabilities: [{ kind: "read_only" }],
            retry,
            ...common,
          },
        ],
      };
    }
  }
}
