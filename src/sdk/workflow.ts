import { adapters } from "../adapters/index.ts";
import {
  CAPABILITY_KINDS,
  DEFAULT_REMOTE,
  ENFORCEMENT_LEVELS,
  EXTERNAL_ACTION_KINDS,
  isBranchName,
  isOutputFieldName,
  isRemoteName,
  isRepoPath,
  isStepId,
  MERGE_METHODS,
  NETWORK_STANCES,
  RECOVERY_POLICIES,
  type CapabilityKind,
  type EnforcementLevel,
  type ExternalActionKind,
  type MergeMethod,
  type RecoveryPolicy,
  type WorkflowDefinition,
} from "../protocol/index.ts";

export class WorkflowValidationError extends Error {
  override name = "WorkflowValidationError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

const WORKFLOW_KEYS = ["name", "steps"];
const STEP_KEYS = ["id", "agent", "verification", "artifacts", "instructions", "retry", "reroute", "recovery", "review", "capabilities", "network"];
const CAPABILITY_KEYS: Record<CapabilityKind, string[]> = {
  read_only: ["kind", "require"],
  write_scope: ["kind", "paths", "require"],
  no_external_actions: ["kind", "require"],
};
const NETWORK_KEYS = ["stance", "require"];
const GATE_KEYS = ["id", "approval"];
const REVIEW_KEYS = ["sendBackTo"];
const AGENT_KEYS = ["adapter", "model", "options"];
const RETRY_KEYS = ["budget", "transientBudget", "backoff"];
const BACKOFF_KEYS = ["initialMs", "factor", "maxTotalMs"];
const VERIFICATION_KEYS = ["command", "requiredOutputFields", "protectedPaths", "hiddenTests", "install"];
/** Why the design's fourth recovery policy is not one, for whoever asks for it. */
export const DISCARD_AND_RETRY_DEFERRED =
  "`discard_and_retry` is deferred past release 1: its only safety check, the diff of the shared refs, cannot see a push that leaves no local ref behind (to a URL rather than a configured remote, or through a service's API), so AHP cannot tell that running the step again is safe";

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

/** Names the problem with each entry of a list of repository paths that is invalid or repeated. */
function checkRepoPaths(paths: unknown[], noun: string): string[] {
  return checkEntries(paths, isRepoPath, {
    invalid: (path) =>
      `${noun} ${JSON.stringify(path)} must be relative to the repository root, written with "/" separators, ` +
      `with no "." or ".." segments and no characters that are invalid in Windows paths`,
    duplicate: (path) => `${noun} ${JSON.stringify(path)} is listed twice`,
  });
}

const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The longest wait a timer takes: a longer one fires at once. */
const MAX_WAIT_MS = 2 ** 31 - 1;
const isWaitMs = (value: unknown) => isCount(value) && (value as number) <= MAX_WAIT_MS;

/** Checks a step's `agent`, or its `reroute`, which names an alternative under the same rules. */
function validateAgent(agent: unknown, key: "agent" | "reroute", problem: (message: string) => void): void {
  const prefix = key === "reroute" ? "reroute: " : "";
  if (!isRecord(agent)) {
    problem(key === "agent" ? "needs an `agent` object naming its `adapter`" : "`reroute` must be an object naming its `adapter`");
    return;
  }
  for (const name of Object.keys(agent)) if (!AGENT_KEYS.includes(name)) problem(`unknown property \`${key}.${name}\``);
  const adapter = typeof agent.adapter === "string" ? adapters.get(agent.adapter) : undefined;
  if (!adapter) {
    const known = [...adapters.keys()].join(", ");
    problem(`${prefix}unknown adapter ${JSON.stringify(agent.adapter)} (known: ${known})`);
  } else {
    for (const message of adapter.validateOptions(agent.options)) problem(`${prefix}${message}`);
  }
  if (agent.model !== undefined && typeof agent.model !== "string") problem(`\`${key}.model\` must be a string`);
}

/** Checks a step's retry budgets and backoff. */
function validateRetry(retry: Record<string, unknown>, problem: (message: string) => void): void {
  for (const name of Object.keys(retry)) if (!RETRY_KEYS.includes(name)) problem(`unknown property \`retry.${name}\``);
  for (const name of ["budget", "transientBudget"]) {
    if (retry[name] !== undefined && !isCount(retry[name])) problem(`\`retry.${name}\` must be a non-negative integer`);
  }
  const backoff = retry.backoff;
  if (backoff === undefined) return;
  if (!isRecord(backoff)) {
    problem("`retry.backoff` must be an object");
    return;
  }
  for (const name of Object.keys(backoff)) if (!BACKOFF_KEYS.includes(name)) problem(`unknown property \`retry.backoff.${name}\``);
  for (const name of ["initialMs", "maxTotalMs"]) {
    if (backoff[name] !== undefined && !isWaitMs(backoff[name])) {
      problem(`\`retry.backoff.${name}\` must be a non-negative integer number of milliseconds, at most ${MAX_WAIT_MS}`);
    }
  }
  const { factor } = backoff;
  if (factor !== undefined && !(typeof factor === "number" && Number.isFinite(factor) && factor >= 1)) {
    problem("`retry.backoff.factor` must be a number of at least 1");
  }
}

/** Checks the `require` of a capability request or the network stance: an enforcement level. */
function validateRequirement(value: unknown, where: string, problem: (message: string) => void): void {
  if (value !== undefined && !ENFORCEMENT_LEVELS.includes(value as EnforcementLevel)) {
    problem(`\`${where}.require\` must be one of ${ENFORCEMENT_LEVELS.join(", ")}`);
  }
}

/**
 * Checks a step's capability requests: each of a known kind, with its own properties, each kind at most once, and
 * nothing that contradicts itself. Whether an adapter can apply them is the handoff's validation, at run time, since it
 * depends on the adapter and the operating system.
 */
function validateCapabilities(capabilities: unknown, problem: (message: string) => void): void {
  if (!Array.isArray(capabilities)) {
    problem("`capabilities` must be an array of capability requests");
    return;
  }
  const seen = new Set<string>();
  capabilities.forEach((request: unknown, index) => {
    const where = `capabilities[${index}]`;
    if (!isRecord(request)) {
      problem(`\`${where}\` must be an object with a \`kind\`: ${CAPABILITY_KINDS.join(", ")}`);
      return;
    }
    const kind = request.kind as CapabilityKind;
    if (!CAPABILITY_KINDS.includes(kind)) {
      problem(`\`${where}.kind\` must be one of ${CAPABILITY_KINDS.join(", ")}`);
      return;
    }
    for (const name of Object.keys(request)) {
      if (!CAPABILITY_KEYS[kind].includes(name)) problem(`unknown property \`${where}.${name}\` for ${kind}`);
    }
    validateRequirement(request.require, where, problem);
    if (seen.has(kind)) problem(`\`${where}\` requests ${kind} a second time`);
    seen.add(kind);
    if (kind === "write_scope") {
      if (!Array.isArray(request.paths) || request.paths.length === 0) {
        problem(`\`${where}.paths\` must list the repository-relative paths the agent may change`);
      } else {
        for (const message of checkRepoPaths(request.paths, "write scope path")) problem(message);
      }
    }
  });
  if (seen.has("read_only") && seen.has("write_scope")) {
    problem("`read_only` and `write_scope` contradict each other: a read-only step may change nothing");
  }
}

/** Checks a step's network stance. */
function validateNetwork(network: unknown, problem: (message: string) => void): void {
  if (!isRecord(network)) {
    problem(`\`network\` must be an object with a \`stance\`: ${NETWORK_STANCES.join(", ")}`);
    return;
  }
  for (const name of Object.keys(network)) if (!NETWORK_KEYS.includes(name)) problem(`unknown property \`network.${name}\``);
  if (!NETWORK_STANCES.includes(network.stance as never)) problem(`\`network.stance\` must be one of ${NETWORK_STANCES.join(", ")}`);
  validateRequirement(network.require, "network", problem);
}

/** Checks a review step's `review`: it names the step before it, the only one a send-back reaches (ADR 0004). */
function validateReview(
  review: unknown,
  index: number,
  { order, gates, actions }: Positions,
  problem: (message: string) => void,
): void {
  if (!isRecord(review)) {
    problem("`review` must be an object naming the step it sends back in `sendBackTo`");
    return;
  }
  for (const name of Object.keys(review)) if (!REVIEW_KEYS.includes(name)) problem(`unknown property \`review.${name}\``);
  const target = review.sendBackTo;
  if (typeof target !== "string") {
    problem("`review.sendBackTo` must name the step to send back");
    return;
  }
  const position = order.indexOf(target);
  if (index === 0) {
    problem("a review needs a step before it to send back, and this is the first step");
  } else if (position === -1) {
    problem(`\`review.sendBackTo\` names ${JSON.stringify(target)}, which is not a step of the workflow`);
  } else if (position === index) {
    problem("`review.sendBackTo` names the review itself");
  } else if (position > index) {
    problem(`\`review.sendBackTo\` names ${JSON.stringify(target)}, which comes after the review: a send-back goes back, not forward`);
  } else if (position !== index - 1) {
    problem(
      `\`review.sendBackTo\` names ${JSON.stringify(target)}, ${index - position} steps back: a review sends back only the step immediately before it, ` +
        `${JSON.stringify(order[index - 1])} (ADR 0004)`,
    );
  } else if (gates[position] || actions[position] !== undefined) {
    problem(`\`review.sendBackTo\` names ${JSON.stringify(target)}, ${gates[position] ? "an approval gate" : "an external action"}: it has no coding agent to send back`);
  }
}

/** Where each step is in the workflow, for the rules that look at the steps around one. */
interface Positions {
  /** Every step's id by position, undefined for one that has none (it is not an object, or its id is not a string). */
  order: (string | undefined)[];
  /** Whether the step at each position declares `approval`, so is an approval gate. */
  gates: boolean[];
  /** The `action` of the step at each position that declares one, so is an external action; undefined for any other. */
  actions: unknown[];
}

const ACTION_KEYS: Record<ExternalActionKind, string[]> = {
  push_branch: ["kind", "branch", "remote"],
  open_pr: ["kind", "branch", "base", "title", "body", "remote"],
  merge_pr: ["kind", "branch", "method", "remote"],
};

/** What an earlier external action after the same gate must be for a later one to have what it needs. */
const NEEDS: Partial<Record<ExternalActionKind, { kind: ExternalActionKind; why: string }>> = {
  open_pr: { kind: "push_branch", why: "the pull request's branch must be the approved commit, pushed by AHP" },
  merge_pr: { kind: "open_pr", why: "the pull request it merges must be one AHP opened for the approved commit" },
};

/**
 * Checks a step that declares `action`: an external action AHP performs, which takes nothing but its id and action.
 * It follows an approval gate, with nothing but external actions between them, since it publishes what that gate
 * approved (ADR 0003): an agent step in between would publish work nobody approved.
 */
function validateExternalAction(step: Record<string, unknown>, index: number, seen: Set<string>, { order, gates, actions }: Positions): string[] {
  const problems: string[] = [];
  const label = typeof step.id === "string" ? `step "${step.id}"` : `step ${index + 1}`;
  const problem = (message: string) => problems.push(`${label}: ${message}`);
  checkStepId(step.id, seen, problem);
  for (const key of Object.keys(step)) {
    if (BRANCHING_KEYS.includes(key)) {
      problem(`\`${key}\` is not supported: release 1 workflows are linear, each step runs after the one before it (ADR 0004)`);
    } else if (key !== "id" && key !== "action") {
      problem(
        STEP_KEYS.includes(key)
          ? `an external action is performed by AHP, with no coding agent and nothing to verify, so it takes no \`${key}\``
          : `unknown property \`${key}\``,
      );
    }
  }
  const action = step.action;
  if (!isRecord(action)) {
    problem(`\`action\` must be an object with a \`kind\`: ${EXTERNAL_ACTION_KINDS.join(", ")}`);
    return problems;
  }
  const kind = action.kind as ExternalActionKind;
  if (action.kind === "deploy") {
    problem("deploy is not an external action AHP performs in release 1 (ADR 0003)");
    return problems;
  }
  if (!EXTERNAL_ACTION_KINDS.includes(kind)) {
    problem(`\`action.kind\` must be one of ${EXTERNAL_ACTION_KINDS.join(", ")}`);
    return problems;
  }
  for (const name of Object.keys(action)) if (!ACTION_KEYS[kind].includes(name)) problem(`unknown property \`action.${name}\` for ${kind}`);
  const branchProblem = (name: string) =>
    `\`action.${name}\` must be a branch name: letters, digits, ".", "_", "-" and "/" between parts, no part starting with "." or "-" or ending in ".lock", no ".."`;
  if (!isBranchName(action.branch)) problem(branchProblem("branch"));
  if (action.remote !== undefined && !isRemoteName(action.remote)) problem("`action.remote` must name a configured git remote (letters, digits, \".\", \"_\" and \"-\")");
  if (kind === "open_pr") {
    if (!isBranchName(action.base)) problem(branchProblem("base"));
    else if (action.base === action.branch) problem("`action.base` names the pull request's own branch");
    if (typeof action.title !== "string" || action.title.trim() === "") problem("needs a non-empty `action.title`");
    if (action.body !== undefined && typeof action.body !== "string") problem("`action.body` must be a string");
  }
  if (kind === "merge_pr" && action.method !== undefined && !MERGE_METHODS.includes(action.method as MergeMethod)) {
    problem(`\`action.method\` must be one of ${MERGE_METHODS.join(", ")}`);
  }

  // Back past the other external actions, to the gate whose approval this one acts on.
  let gate = index - 1;
  while (gate >= 0 && actions[gate] !== undefined) gate -= 1;
  if (gate < 0 || !gates[gate]) {
    const what = gate < 0 ? "nothing" : `step ${JSON.stringify(order[gate])}, which is not an approval gate,`;
    problem(
      `an external action needs an approval gate before it, with nothing but external actions in between, and ${what} comes before it: ` +
        "AHP publishes only what a person approved (ADR 0003)",
    );
  }
  const needed = NEEDS[kind];
  if (needed) {
    const remote = action.remote ?? DEFAULT_REMOTE;
    const earlier = actions.slice(Math.max(gate, 0), index).filter(isRecord);
    if (!earlier.some((other) => other.kind === needed.kind && other.branch === action.branch && (other.remote ?? DEFAULT_REMOTE) === remote)) {
      problem(`${kind} needs a ${needed.kind} of branch ${JSON.stringify(action.branch)} to remote "${remote}" before it, after the same gate: ${needed.why}`);
    }
  }
  return problems;
}

/** Checks a step's `id` and records it as seen; the problems it finds go to `problem`. */
function checkStepId(id: unknown, seen: Set<string>, problem: (message: string) => void): void {
  if (!isStepId(id)) {
    problem('`id` must be lowercase letters, digits, "-" or "_", starting with a letter or digit');
  } else if (seen.has(id)) {
    problem("duplicate step id");
  } else {
    seen.add(id);
  }
}

/** Checks a step that declares `approval`: a gate takes nothing but its id, and sits after a step that a rejection can send back. */
function validateGate(step: Record<string, unknown>, index: number, seen: Set<string>, { order, gates, actions }: Positions): string[] {
  const problems: string[] = [];
  const label = typeof step.id === "string" ? `step "${step.id}"` : `step ${index + 1}`;
  const problem = (message: string) => problems.push(`${label}: ${message}`);
  checkStepId(step.id, seen, problem);
  for (const key of Object.keys(step)) {
    if (BRANCHING_KEYS.includes(key)) {
      problem(`\`${key}\` is not supported: release 1 workflows are linear, each step runs after the one before it (ADR 0004)`);
    } else if (!GATE_KEYS.includes(key)) {
      problem(
        STEP_KEYS.includes(key)
          ? `an approval gate has no coding agent and nothing to verify, so it takes no \`${key}\``
          : `unknown property \`${key}\``,
      );
    }
  }
  if (!isRecord(step.approval)) {
    problem("`approval` must be an object (an empty one: a gate takes no options)");
  } else {
    for (const name of Object.keys(step.approval)) problem(`unknown property \`approval.${name}\``);
  }
  if (index === 0) {
    problem("an approval gate needs a step before it, which a rejection sends back, and this is the first step");
  } else if (gates[index - 1] || actions[index - 1] !== undefined) {
    problem(
      `follows ${gates[index - 1] ? "approval gate" : "external action"} ${JSON.stringify(order[index - 1])}: a rejection sends back the step ` +
        "immediately before the gate, which must be performed by a coding agent (ADR 0004)",
    );
  }
  return problems;
}

function validateStep(step: unknown, index: number, seen: Set<string>, positions: Positions): string[] {
  if (!isRecord(step)) return [`step ${index + 1}: must be an object`];
  if ("approval" in step) return validateGate(step, index, seen, positions);
  if ("action" in step) return validateExternalAction(step, index, seen, positions);
  const problems: string[] = [];
  const label = typeof step.id === "string" ? `step "${step.id}"` : `step ${index + 1}`;
  const problem = (message: string) => problems.push(`${label}: ${message}`);

  checkStepId(step.id, seen, problem);
  for (const key of Object.keys(step)) {
    if (BRANCHING_KEYS.includes(key)) {
      problem(`\`${key}\` is not supported: release 1 workflows are linear, each step runs after the one before it (ADR 0004)`);
    } else if (!STEP_KEYS.includes(key)) {
      problem(`unknown property \`${key}\``);
    }
  }

  if (step.review !== undefined) validateReview(step.review, index, positions, problem);
  if (step.capabilities !== undefined) validateCapabilities(step.capabilities, problem);
  if (step.network !== undefined) validateNetwork(step.network, problem);
  validateAgent(step.agent, "agent", problem);
  if (step.reroute !== undefined) validateAgent(step.reroute, "reroute", problem);
  if (step.retry !== undefined) {
    if (isRecord(step.retry)) validateRetry(step.retry, problem);
    else problem("`retry` must be an object");
  }
  if (step.recovery === "discard_and_retry") {
    problem(`\`recovery\`: ${DISCARD_AND_RETRY_DEFERRED}`);
  } else if (step.recovery !== undefined && !RECOVERY_POLICIES.includes(step.recovery as RecoveryPolicy)) {
    problem(`\`recovery\` must be one of ${RECOVERY_POLICIES.join(", ")}`);
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
    } else if (step.review === undefined && (!Array.isArray(fields) || fields.length === 0)) {
      // A step with nothing to check would succeed on nothing. A review checks its verdict and findings.
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
    if ("install" in verification) {
      if (typeof verification.install !== "string" || verification.install.trim() === "") {
        problem("needs a non-empty `verification.install`");
      } else if (!("command" in verification)) {
        problem("`verification.install` needs a `verification.command` to install for");
      }
    }
    const protectedPaths = verification.protectedPaths;
    if (protectedPaths !== undefined && !Array.isArray(protectedPaths)) {
      problem("`verification.protectedPaths` must be an array of repository-relative paths");
    } else if (protectedPaths !== undefined) {
      for (const message of checkRepoPaths(protectedPaths, "protected path")) problem(message);
    }
    const hiddenTests = verification.hiddenTests;
    if (hiddenTests !== undefined && !Array.isArray(hiddenTests)) {
      problem("`verification.hiddenTests` must be an array of `{ path, content }` files");
    } else if (hiddenTests !== undefined) {
      if (hiddenTests.length > 0 && !("command" in verification)) {
        problem("`verification.hiddenTests` need a `verification.command` to run them");
      }
      const wellFormed = hiddenTests.filter((test) => {
        const ok = isRecord(test) && typeof test.content === "string";
        if (!ok) problem("each hidden test needs a string `path` and `content`");
        return ok;
      });
      for (const message of checkRepoPaths(wellFormed.map((test) => test.path), "hidden test path")) problem(message);
    }
  }

  if (step.instructions !== undefined && (typeof step.instructions !== "string" || step.instructions.trim() === "")) {
    problem("`instructions` must be a non-empty string");
  }

  if (step.artifacts !== undefined && !Array.isArray(step.artifacts)) {
    problem("`artifacts` must be an array of repository-relative paths");
  } else if (Array.isArray(step.artifacts)) {
    for (const message of checkRepoPaths(step.artifacts, "artifact path")) problem(message);
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
  const positions: Positions = {
    order: workflow.steps.map((step: unknown) => (isRecord(step) && typeof step.id === "string" ? step.id : undefined)),
    gates: workflow.steps.map((step: unknown) => isRecord(step) && "approval" in step),
    actions: workflow.steps.map((step: unknown) => (isRecord(step) && "action" in step && !("approval" in step) ? (step.action ?? null) : undefined)),
  };
  workflow.steps.forEach((step: unknown, index) => {
    if (Array.isArray(step)) {
      const ids = step.map((member) => (isRecord(member) ? member.id : undefined)).filter((id) => typeof id === "string");
      problems.push(
        `${ids.length > 0 ? `steps ${quoted(ids)}` : `the ${step.length} steps`} at position ${index + 1} form a parallel group: ` +
          "release 1 workflows are linear, so list steps one after another (ADR 0004)",
      );
    } else {
      problems.push(...validateStep(step, index, seen, positions));
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
