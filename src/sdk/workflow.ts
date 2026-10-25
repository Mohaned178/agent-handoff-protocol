import { adapters } from "../adapters/index.ts";
import { isOutputFieldName, isRepoPath, isStepId, type WorkflowDefinition } from "../protocol/index.ts";

export class WorkflowValidationError extends Error {
  override name = "WorkflowValidationError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

const WORKFLOW_KEYS = ["name", "steps"];
const STEP_KEYS = ["id", "agent", "verification", "artifacts", "instructions"];
const AGENT_KEYS = ["adapter", "model", "options"];
const VERIFICATION_KEYS = ["command", "requiredOutputFields"];
/** Properties authors reach for to run steps side by side or out of order; release 1 workflows are linear (ADR 0004). */
const BRANCHING_KEYS = ["parallel", "dependsOn", "needs", "after"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

/** Names the problem with each repeated or invalid entry of a list of strings. */
function checkEntries(
  entries: unknown[],
  valid: (entry: unknown) => boolean,
  describe: { invalid: (entry: unknown) => string; duplicate: (entry: string) => string },
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!valid(entry)) problems.push(describe.invalid(entry));
    else if (seen.has(entry as string)) problems.push(describe.duplicate(entry as string));
    else seen.add(entry as string);
  }
  return problems;
}

function validateStep(step: unknown, index: number, seen: Set<string>): string[] {
  if (!isRecord(step)) return [`step ${index + 1}: must be an object`];
  const problems: string[] = [];
  const label = typeof step.id === "string" ? `step "${step.id}"` : `step ${index + 1}`;
  const problem = (message: string) => problems.push(`${label}: ${message}`);

  if (!isStepId(step.id)) {
    problem('`id` must be lowercase letters, digits, "-" or "_", starting with a letter or digit');
  } else if (seen.has(step.id)) {
    problem("duplicate step id");
  } else {
    seen.add(step.id);
  }
  for (const key of Object.keys(step)) {
    if (BRANCHING_KEYS.includes(key)) {
      problem(`\`${key}\` is not supported: release 1 workflows are linear, each step runs after the one before it (ADR 0004)`);
    } else if (!STEP_KEYS.includes(key)) {
      problem(`unknown property \`${key}\``);
    }
  }

  const agent = step.agent;
  if (!isRecord(agent)) {
    problem("needs an `agent` object naming its `adapter`");
  } else {
    for (const key of Object.keys(agent)) if (!AGENT_KEYS.includes(key)) problem(`unknown property \`agent.${key}\``);
    const adapter = typeof agent.adapter === "string" ? adapters.get(agent.adapter) : undefined;
    if (!adapter) {
      const known = [...adapters.keys()].join(", ");
      problem(`unknown adapter ${JSON.stringify(agent.adapter)} (known: ${known})`);
    } else {
      for (const message of adapter.validateOptions(agent.options)) problem(message);
    }
    if (agent.model !== undefined && typeof agent.model !== "string") problem("`agent.model` must be a string");
  }

  const verification = step.verification;
  if (!isRecord(verification)) {
    problem("needs a `verification` object");
  } else {
    for (const key of Object.keys(verification)) {
      if (!VERIFICATION_KEYS.includes(key)) problem(`unknown property \`verification.${key}\``);
    }
    const fields = verification.requiredOutputFields;
    if ("command" in verification) {
      if (typeof verification.command !== "string" || verification.command.trim() === "") {
        problem("needs a non-empty `verification.command`");
      }
    } else if (!Array.isArray(fields) || fields.length === 0) {
      // A step with nothing to check would succeed on nothing.
      problem("needs a `verification.command` or at least one required output field in `verification.requiredOutputFields`");
    }
    if (fields !== undefined && !Array.isArray(fields)) {
      problem("`verification.requiredOutputFields` must be an array of field names");
    } else if (fields !== undefined) {
      const messages = checkEntries(fields, isOutputFieldName, {
        invalid: (name) =>
          `required output field ${JSON.stringify(name)} is not a valid name (letters, digits and "_", starting with a letter, up to 64 characters)`,
        duplicate: (name) => `required output field ${JSON.stringify(name)} is listed twice`,
      });
      for (const message of messages) problem(message);
    }
  }

  if (step.instructions !== undefined && (typeof step.instructions !== "string" || step.instructions.trim() === "")) {
    problem("`instructions` must be a non-empty string");
  }

  if (step.artifacts !== undefined && !Array.isArray(step.artifacts)) {
    problem("`artifacts` must be an array of repository-relative paths");
  } else if (Array.isArray(step.artifacts)) {
    const messages = checkEntries(step.artifacts, isRepoPath, {
      invalid: (path) =>
        `artifact path ${JSON.stringify(path)} must be relative to the repository root, written with "/" separators, ` +
        `with no "." or ".." segments and no characters that are invalid in Windows paths`,
      duplicate: (path) => `artifact path ${JSON.stringify(path)} is listed twice`,
    });
    for (const message of messages) problem(message);
  }
  return problems;
}

/** Returns one message per problem with `workflow`; empty when it is valid. */
export function validateWorkflow(workflow: unknown): string[] {
  if (!isRecord(workflow)) return ["a workflow must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(workflow)) {
    if (!WORKFLOW_KEYS.includes(key)) problems.push(`unknown workflow property \`${key}\``);
  }
  if (typeof workflow.name !== "string" || workflow.name.trim() === "") {
    problems.push("workflow needs a non-empty `name`");
  }
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    problems.push("workflow needs at least one step in `steps`");
    return problems;
  }
  const seen = new Set<string>();
  workflow.steps.forEach((step: unknown, index) => {
    if (Array.isArray(step)) {
      const ids = step.map((member) => (isRecord(member) ? member.id : undefined)).filter((id) => typeof id === "string");
      problems.push(
        `${ids.length > 0 ? `steps ${quoted(ids)}` : `the ${step.length} steps`} at position ${index + 1} form a parallel group: ` +
          "release 1 workflows are linear, so list steps one after another (ADR 0004)",
      );
    } else {
      problems.push(...validateStep(step, index, seen));
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
