import type { AdapterDeclaration } from "../adapters/index.ts";
import {
  isPresentOutputField,
  parseHandoffRevision,
  PROTOCOL_VERSION,
  requiredOutputFieldsOf,
  REVIEW_VERDICTS,
  type ArtifactReference,
  type EvidenceItem,
  type HandoffEvidence,
  type HandoffRevision,
  type OutputFieldValue,
  type RejectionReason,
  type StepDefinition,
} from "../protocol/index.ts";
import { hashCommittedFile } from "./artifacts.ts";
import { requestsOf, resolveCapabilities } from "./capabilities.ts";
import { git } from "./git.ts";
import { evidenceVerdict } from "./verification.ts";

/** The verified attempt of the step before the recipient: the result being handed on. */
export interface HandoffSender {
  step: StepDefinition;
  attemptId: string;
  reportedOutput: Readonly<Record<string, OutputFieldValue>>;
}

export interface BuildHandoffInput {
  /** Any directory inside the repository the run works on. */
  repo: string;
  runId: string;
  handoffId: string;
  /** The recipient. */
  step: StepDefinition;
  /** Null for the first step, which has nothing to receive. */
  sender: HandoffSender | null;
  /** The commit the recipient's workspace starts from; the sender's snapshot when there is a sender. */
  baseCommit: string;
}

/**
 * Assembles revision 1 of the handoff to `step`. The context is the sender's required output fields and the
 * artifacts are the files the sender declared, referenced at `baseCommit`: what the workflow definition says
 * matters, not whatever else the coding agent reported or left behind. What the sender declared but the base
 * commit does not hold stays in `requires`, so validation can reject the gap.
 */
export async function buildHandoff(input: BuildHandoffInput): Promise<HandoffRevision> {
  const { repo, runId, handoffId, step, sender, baseCommit } = input;
  const handedOnFields = sender ? requiredOutputFieldsOf(sender.step) : [];
  const fields: Record<string, OutputFieldValue> = {};
  for (const name of handedOnFields) {
    const value = sender?.reportedOutput[name];
    if (value !== undefined && isPresentOutputField(value)) fields[name] = value;
  }
  const handedOnArtifacts = sender?.step.artifacts ?? [];
  const artifacts: ArtifactReference[] = [];
  for (const path of handedOnArtifacts) {
    const sha256 = await hashCommittedFile(repo, baseCommit, path);
    if (sha256 !== null) artifacts.push({ path, sha256 });
  }
  return {
    schemaVersion: PROTOCOL_VERSION,
    handoffId,
    revision: 1,
    supersedes: null,
    contextId: runId,
    from: sender ? { stepId: sender.step.id, attemptId: sender.attemptId } : null,
    to: { stepId: step.id, adapter: step.agent.adapter, requestedModel: step.agent.model ?? null },
    base: { commit: baseCommit },
    contract: {
      instructions: step.instructions ?? null,
      acceptance: {
        verificationCommand: step.verification.command ?? null,
        requiredOutputFields: requiredOutputFieldsOf(step),
      },
    },
    ...requestsOf(step),
    context: { fields },
    artifacts,
    evidence: [],
    requires: { fields: [...handedOnFields], artifacts: [...handedOnArtifacts] },
  };
}

/** How much of a command's output a retry shows the agent: the end, where failures are reported. */
const MAX_RETRY_OUTPUT_CHARS = 8 * 1024;

/**
 * What a retry shows the coding agent of a verification that failed: its failing parts only, since a part that
 * passed, or that could not run, gives the agent nothing to fix. The output of a command that runs hidden tests
 * is withheld (the agent gets the exit code), and only the changed paths that violated a protected path are named,
 * never the list of protected paths, which holds the hidden tests' paths. The ledger keeps the full evidence.
 */
export function retryEvidence(evidence: readonly EvidenceItem[], options: { hiddenTests: boolean }): HandoffEvidence[] {
  const shown: HandoffEvidence[] = [];
  for (const item of evidence) {
    if (evidenceVerdict(item) !== "fail") continue;
    switch (item.kind) {
      case "test_output": {
        const tail = item.output.slice(-MAX_RETRY_OUTPUT_CHARS);
        shown.push({
          kind: "test_output",
          command: item.command,
          exitCode: item.exitCode,
          signal: item.signal,
          output: options.hiddenTests ? null : tail,
          truncated: !options.hiddenTests && (item.truncated || tail.length < item.output.length),
        });
        break;
      }
      case "required_output_fields":
        shown.push({ kind: "required_output_fields", missing: [...item.missing] });
        break;
      case "protected_paths":
        shown.push({ kind: "protected_paths", violations: item.violations.map((v) => ({ ...v })), truncated: item.truncated });
        break;
      case "review_verdict":
        shown.push({ kind: "review_verdict", reported: item.reported, allowed: [...REVIEW_VERDICTS] });
        break;
      case "forbidden_external_action_detected":
        shown.push({ kind: "forbidden_external_action_detected", changed: item.changed.map((c) => ({ ...c })), truncated: item.truncated });
        break;
      default:
        // The other kinds are never failing evidence.
        break;
    }
  }
  return shown;
}

/**
 * The next revision of a handoff: the same document with its input changed. It keeps the handoff's ID, base commit,
 * contract, context and artifacts, supersedes the revision before it, and carries `evidence`; a reroute also names
 * the alternative coding agent as the recipient's.
 */
export function reviseHandoff(
  previous: HandoffRevision,
  change: { evidence: HandoffEvidence[]; to?: { adapter: string; requestedModel: string | null } },
): HandoffRevision {
  const next = structuredClone(previous);
  next.revision = previous.revision + 1;
  next.supersedes = previous.revision;
  next.evidence = change.evidence;
  if (change.to) next.to = { ...next.to, ...change.to };
  return next;
}

export type HandoffValidation =
  | { accepted: true; handoff: HandoffRevision }
  | { accepted: false; reasons: RejectionReason[] };

/** The recipient's adapter, as far as validation needs it: what it declares, and the system the run is on. */
export interface HandoffRecipient {
  /** The declaration of the adapter the handoff names in `to.adapter`; undefined when there is no such adapter. */
  declaration: AdapterDeclaration | undefined;
  /** The operating system, as Node's `process.platform` names it. */
  platform: string;
}

/**
 * Validates a handoff revision on the recipient's behalf: the document is checked against the schema, then
 * against the repository it refers to, then against what the recipient's adapter declares it can apply on this
 * system. Every problem found is reported, each with a machine-readable code.
 */
export async function validateHandoffRevision(input: unknown, repo: string, recipient: HandoffRecipient): Promise<HandoffValidation> {
  const parsed = parseHandoffRevision(input);
  if (!parsed.ok) return { accepted: false, reasons: parsed.reasons };
  const { handoff } = parsed;

  const reasons: RejectionReason[] = [];
  handoff.requires.fields.forEach((name, index) => {
    if (!isPresentOutputField(handoff.context.fields[name])) {
      reasons.push({
        code: "unmet_dependency",
        pointer: `/requires/fields/${index}`,
        message: `the handoff requires field "${name}", but its context does not carry it`,
      });
    }
  });
  handoff.requires.artifacts.forEach((path, index) => {
    if (!handoff.artifacts.some((artifact) => artifact.path === path)) {
      reasons.push({
        code: "unmet_dependency",
        pointer: `/requires/artifacts/${index}`,
        message: `the handoff requires artifact "${path}", but lists no artifact with that path (it is not a file at ${handoff.base.commit})`,
      });
    }
  });

  if (!recipient.declaration) {
    reasons.push({
      code: "unmet_dependency",
      pointer: "/to/adapter",
      message: `the handoff is for adapter "${handoff.to.adapter}", which is not one of the adapters available`,
    });
  } else {
    reasons.push(...resolveCapabilities(handoff, recipient.declaration, recipient.platform).shortfalls);
  }

  const baseExists = await git(repo, ["rev-parse", "--verify", "--quiet", `${handoff.base.commit}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!baseExists) {
    reasons.push({
      code: "unmet_dependency",
      pointer: "/base/commit",
      message: `base commit ${handoff.base.commit} does not exist in the repository`,
    });
  } else {
    for (const [index, artifact] of handoff.artifacts.entries()) {
      const actual = await hashCommittedFile(repo, handoff.base.commit, artifact.path);
      if (actual === null) {
        reasons.push({
          code: "unmet_dependency",
          pointer: `/artifacts/${index}`,
          message: `artifact "${artifact.path}" is not a file at base commit ${handoff.base.commit}`,
        });
      } else if (actual !== artifact.sha256) {
        reasons.push({
          code: "artifact_hash_mismatch",
          pointer: `/artifacts/${index}/sha256`,
          message: `artifact "${artifact.path}" has committed content with SHA-256 ${actual}, not the ${artifact.sha256} the handoff states`,
        });
      }
    }
  }
  return reasons.length > 0 ? { accepted: false, reasons } : { accepted: true, handoff };
}
