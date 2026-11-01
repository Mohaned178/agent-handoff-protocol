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

/** The conditions with an acceptance check and a retry budget: what C3 has that C0, C1 and C2 do not. */
export const GATED_CONDITIONS: readonly ConditionId[] = ["C0V", "C3min", "C3", "C3c", "C3r"];

/**
 * C3c's context budget on every step, in UTF-8 bytes of the handed-on fields as JSON: about two pages of text, a quarter or
 * less of what a plan of a pilot task runs to unchecked, so a step must compress what it hands on rather than restate all.
 */
export const C3C_CONTEXT_BUDGET = 2048;

/** What C3r's reflect step reports: C3's handed-on fields and the reflection itself. */
const REFLECTED = [...HANDED_ON, "reflection"];

/** What C3r's reflect step is told: critique the result against the task and constraints it was handed, then fix what is wrong. */
const REFLECT_TEXT =
  "Reflect on the implementation in this workspace: check it against the decisions and constraints you were handed, say what is wrong or missing, and fix it. Report your summary, your decisions, every constraint you kept (restate each one), and your reflection: what you found and what you changed.";

/** What C3c adds to each step's words: the budget, which verification also checks (the handoff's contract states it too). */
const BUDGET_TEXT = `Keep what you report short: together your reported fields must come to at most ${C3C_CONTEXT_BUDGET} bytes as JSON, since they are all the next step is handed. Keep what it needs and leave out the rest.`;

/** The retry budget of every step of `condition`: the suite's (default 2) for a gated condition, and none for any other. */
export const retryBudgetOf = (condition: ConditionId, suite: EvaluationSuite): number =>
  GATED_CONDITIONS.includes(condition) ? (suite.retryBudget ?? DEFAULT_RETRY_BUDGET) : 0;

/**
 * The acceptance check of a gated condition's step that writes code: the task's `acceptance` command over the agent's result,
 * with its install and protected paths. Never the hidden tests: those are the validators' alone, so no agent is retried
 * against the check it is scored by.
 */
function acceptanceOf(task: EvaluationTask, requiredOutputFields: string[]) {
  const { acceptance, install, protectedPaths } = task.verification;
  if (acceptance === undefined) throw new Error("the task has no `verification.acceptance`, the check C0V, C3min, C3, C3c and C3r run on an agent's result");
  return { command: acceptance, ...(install !== undefined ? { install } : {}), protectedPaths, requiredOutputFields };
}

/**
 * The workflow `condition` runs for `task`.
 * - C0 (and every trial of the matched-budget baseline): one coding agent, the suite's `implement` one, does the whole task
 *   in one attempt, with no retry and no acceptance check beyond a summary being reported: how it did is for the validators.
 * - C1: the pipeline's three agents, each handing the next one field of free text and nothing else; nothing is checked but
 *   that the text was reported (there is nothing to hand on otherwise), and nothing is retried.
 * - C2: the pipeline with C3's handoffs: the structured fields, each step's handoff validated, the same capability requests;
 *   but no verification command, hidden tests or protected paths, no retry, and a review that sends nothing back.
 * - C3: full AHP: C2 plus the task's acceptance check on the implement step, a retry budget on every step, and a review
 *   that sends `implement` back.
 * - C0V: C0 with C3's acceptance check and retry budget on its one step: a single agent with a verify-and-retry loop.
 * - C3min: C3 without its plan step: implement (told the task and its constraints) → review.
 * - C3c: C3 with a context budget (`C3C_CONTEXT_BUDGET`) on every step, told to each in its words and checked by verification:
 *   handed-on fields over it fail the step, which is retried with the bytes as evidence. Its words are C3's plus the budget.
 * - C3r: C3 with a `reflect` step between implement and review: the implement agent again, in the workspace implement left,
 *   critiques its result against the task and constraints and fixes it, under the same acceptance check and retry. Review
 *   follows it and sends `reflect` back (a review's `sendBackTo` must be the step before it).
 * Every pipeline step is told the same words in C1, C2, C3min and C3, and only the first is told the task and its constraints.
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
    case "C0V":
      return {
        name: `${task.id}-C0V`,
        steps: [
          {
            id: "solve",
            agent: agent("implement"),
            instructions: `${taskText(task)}\n\nDo the whole task in this workspace.`,
            verification: acceptanceOf(task, ["summary"]),
            retry: { budget: retryBudgetOf(condition, suite) },
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
    case "C3min":
    case "C3":
    case "C3c":
    case "C3r": {
      const full = condition !== "C2";
      const retry = { budget: retryBudgetOf(condition, suite) };
      const reportKept = "Report your summary, your decisions, and every constraint you kept: restate each one.";
      const plan = (): StepDefinition => ({
        id: "plan",
        agent: agent("plan"),
        instructions: `${taskText(task)}\n\n${PIPELINE.plan} Report your summary, the decisions you made, and every constraint the work must respect: restate each one you were given.`,
        capabilities: [{ kind: "read_only" }],
        verification: { requiredOutputFields: HANDED_ON },
        retry,
        ...common,
      });
      const steps: StepDefinition[] = [
        ...(condition === "C3min" ? [] : [plan()]),
        {
          id: "implement",
          agent: agent("implement"),
          // With no plan step, the implementer is the first step: it is told the task and its constraints, as C0's agent is.
          instructions: condition === "C3min" ? `${taskText(task)}\n\nDo the whole task in this workspace. ${reportKept}` : `${PIPELINE.implement} ${reportKept}`,
          // In C3 and C3min the task's acceptance check is this step's; a failure sends it back with the evidence.
          verification: full ? acceptanceOf(task, HANDED_ON) : { requiredOutputFields: HANDED_ON },
          retry,
          ...common,
        },
        ...(condition === "C3r"
          ? [{
              id: "reflect",
              agent: agent("implement"),
              instructions: REFLECT_TEXT,
              verification: acceptanceOf(task, REFLECTED),
              retry,
              ...common,
            } satisfies StepDefinition]
          : []),
        {
          id: "review",
          agent: agent("review"),
          instructions: `${PIPELINE.review} Report your verdict and your findings.`,
          // C2's review reports the same fields, as an ordinary step: its verdict is not checked and sends nothing back.
          ...(full ? { review: { sendBackTo: condition === "C3r" ? "reflect" : "implement" }, verification: {} } : { verification: { requiredOutputFields: [...REVIEW_OUTPUT_FIELDS] } }),
          capabilities: [{ kind: "read_only" }],
          retry,
          ...common,
        },
      ];
      // C3c: C3's steps, each held to the budget and told it in its words (the handoff's contract states it as well).
      const budgeted = condition === "C3c"
        ? steps.map((step) => ({ ...step, instructions: `${step.instructions!} ${BUDGET_TEXT}`, contextBudget: { maxBytes: C3C_CONTEXT_BUDGET } }))
        : steps;
      return { name: `${task.id}-${condition}`, steps: budgeted };
    }
  }
}
