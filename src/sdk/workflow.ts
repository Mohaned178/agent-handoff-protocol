import { adapters } from "../adapters/index.ts";
import type { WorkflowDefinition } from "../protocol/index.ts";

/** Step IDs appear in paths and git ref names. */
const STEP_ID = /^[a-z0-9][a-z0-9_-]*$/;

export class WorkflowValidationError extends Error {
  override name = "WorkflowValidationError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

/** Returns one message per problem with `workflow`; empty when it is valid. */
export function validateWorkflow(workflow: unknown): string[] {
  const candidate = workflow as Partial<WorkflowDefinition> | null | undefined;
  if (typeof candidate !== "object" || candidate === null) return ["a workflow must be an object"];
  const problems: string[] = [];
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
    problems.push("workflow needs a non-empty `name`");
  }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    problems.push("workflow needs at least one step in `steps`");
    return problems;
  }
  const seen = new Set<string>();
  candidate.steps.forEach((step, index) => {
    const label = typeof step?.id === "string" ? `step "${step.id}"` : `step ${index + 1}`;
    if (typeof step?.id !== "string" || !STEP_ID.test(step.id)) {
      problems.push(`${label}: \`id\` must be lowercase letters, digits, "-" or "_", starting with a letter or digit`);
    } else if (seen.has(step.id)) {
      problems.push(`${label}: duplicate step id`);
    } else {
      seen.add(step.id);
    }
    const adapter = typeof step?.agent?.adapter === "string" ? adapters.get(step.agent.adapter) : undefined;
    if (!adapter) {
      const known = [...adapters.keys()].join(", ");
      problems.push(`${label}: unknown adapter ${JSON.stringify(step?.agent?.adapter)} (known: ${known})`);
    } else {
      for (const problem of adapter.validateOptions(step.agent.options)) problems.push(`${label}: ${problem}`);
    }
    if (step?.agent?.model !== undefined && typeof step.agent.model !== "string") {
      problems.push(`${label}: \`agent.model\` must be a string`);
    }
    if (typeof step?.verification?.command !== "string" || step.verification.command.trim() === "") {
      problems.push(`${label}: needs a non-empty \`verification.command\``);
    }
  });
  return problems;
}

/** Checks a workflow definition and returns it unchanged; throws `WorkflowValidationError` if it is invalid. */
export function defineWorkflow<const W extends WorkflowDefinition>(workflow: W): W {
  const problems = validateWorkflow(workflow);
  if (problems.length > 0) throw new WorkflowValidationError(problems);
  return workflow;
}
