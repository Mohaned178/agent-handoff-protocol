import type { AgentRef } from "../protocol/index.ts";
import { CONDITIONS, type ConditionId } from "./events.ts";
import type { EvaluationTask } from "./task.ts";

/**
 * Which trial an agent is cast for: its condition, its repeat (from 1), and for a trial of the matched-budget baseline which
 * of that cell's trials it is (from 1). A real suite casts the same agent for every trial; a scripted mock agent may differ.
 */
export interface TrialSlot {
  condition: ConditionId;
  repeat: number;
  baselineIndex: number | null;
}

/**
 * An agent for a role: the same for every task, or chosen for the task and the trial (a scripted mock agent depends on its
 * fixture). A function is also called while the suite is validated, with the first repeat and the first baseline trial.
 */
export type AgentSource = AgentRef | ((task: EvaluationTask, slot: TrialSlot) => AgentRef);

/** The roles the conditions cast coding agents in. C0 is one agent, the `implement` one, doing everything. */
export const EVALUATION_ROLES = ["plan", "implement", "review"] as const;
export type EvaluationRole = (typeof EVALUATION_ROLES)[number];

export interface EvaluationSuite {
  name: string;
  /**
   * Task directories (`docs/evaluation.md`). A relative path is resolved against `RunEvaluationOptions.baseDir`, which the
   * CLI sets to the directory of the suite file.
   */
  tasks: string[];
  /** Default: every condition there is, the matched-budget baseline (`baseline`) among them. The baseline needs C3. */
  conditions?: ConditionId[];
  /**
   * The coding agent each role is cast as. `implement` is needed always, since C0 (and so the baseline) is that one agent
   * alone; `plan` and `review` are needed when C1, C2 or C3 runs.
   */
  agents: Partial<Record<EvaluationRole, AgentSource>>;
  /**
   * The retry budget of each of C3's steps, shared by agent errors, failed verifications and review send-backs (default
   * 2). C0, C1 and C2 have none; their `transient` failures are retried as C3's are, since a rate limit is not something a
   * condition does.
   */
  retryBudget?: number;
  /** How many trials each task gets under each condition (default 1); the baseline gets a cell per repeat. */
  repeats?: number;
}

export const DEFAULT_RETRY_BUDGET = 2;

/** The conditions that cast all three roles as plan → implement → review. */
const PIPELINE_CONDITIONS: readonly ConditionId[] = ["C1", "C2", "C3"];

export const agentFor = (source: AgentSource, task: EvaluationTask, slot: TrialSlot): AgentRef => (typeof source === "function" ? source(task, slot) : source);

export const conditionsOf = (suite: EvaluationSuite): ConditionId[] => suite.conditions ?? [...CONDITIONS];

/** One message per problem with the suite's own shape; the workflows it builds are validated separately, with the tasks. */
export function validateSuite(suite: unknown): string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(suite)) return ["a suite must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(suite)) {
    if (!["name", "tasks", "conditions", "agents", "retryBudget", "repeats"].includes(key)) problems.push(`unknown suite property \`${key}\``);
  }
  if (typeof suite.name !== "string" || suite.name.trim() === "") problems.push("suite needs a non-empty `name`");
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0 || !suite.tasks.every((task) => typeof task === "string" && task !== "")) {
    problems.push("suite needs `tasks`: a non-empty array of task directories");
  } else if (new Set(suite.tasks).size !== suite.tasks.length) {
    problems.push("a task directory is listed twice");
  }
  let conditions: ConditionId[] = [...CONDITIONS];
  if (suite.conditions !== undefined) {
    // Which conditions run is unknown when the list is wrong, so no role beyond `implement` is asked for on its account.
    conditions = [];
    if (!Array.isArray(suite.conditions) || suite.conditions.length === 0 || !suite.conditions.every((c) => CONDITIONS.includes(c as ConditionId))) {
      problems.push(`\`conditions\` must be a non-empty array of: ${CONDITIONS.join(", ")}`);
    } else if (new Set(suite.conditions).size !== suite.conditions.length) {
      problems.push("a condition is listed twice");
    } else {
      conditions = suite.conditions as ConditionId[];
      if (conditions.includes("baseline") && !conditions.includes("C3")) problems.push("the matched-budget baseline (`baseline`) needs C3: it runs C0 as many times as C3 made attempts");
    }
  }
  if (!isRecord(suite.agents)) {
    problems.push("suite needs `agents`: the coding agent for each of the roles plan, implement and review");
  } else {
    for (const key of Object.keys(suite.agents)) if (!(EVALUATION_ROLES as readonly string[]).includes(key)) problems.push(`unknown role \`agents.${key}\` (roles: ${EVALUATION_ROLES.join(", ")})`);
    for (const role of EVALUATION_ROLES) {
      const source = suite.agents[role];
      const pipeline = conditions.filter((condition) => PIPELINE_CONDITIONS.includes(condition));
      const needed = role === "implement" || pipeline.length > 0;
      if (source === undefined && needed) problems.push(`\`agents.${role}\` is needed: ${role === "implement" ? "C0 is that agent alone" : `${pipeline.join(", ")} cast${pipeline.length === 1 ? "s" : ""} it as a step`}`);
      else if (source !== undefined && typeof source !== "function" && !(isRecord(source) && typeof source.adapter === "string")) {
        problems.push(`\`agents.${role}\` must be an agent (\`{ adapter, model?, options? }\`) or a function of the task that returns one`);
      }
    }
  }
  if (suite.retryBudget !== undefined && !(Number.isSafeInteger(suite.retryBudget) && (suite.retryBudget as number) >= 0)) {
    problems.push("`retryBudget` must be a non-negative integer");
  }
  if (suite.repeats !== undefined && !(Number.isSafeInteger(suite.repeats) && (suite.repeats as number) >= 1)) problems.push("`repeats` must be a positive integer");
  return problems;
}
