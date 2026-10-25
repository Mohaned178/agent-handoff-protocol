import {
  isPresentOutputField,
  parseHandoffRevision,
  PROTOCOL_VERSION,
  type ArtifactReference,
  type HandoffRevision,
  type OutputFieldValue,
  type RejectionReason,
  type StepDefinition,
} from "../protocol/index.ts";
import { hashCommittedFile } from "./artifacts.ts";
import { git } from "./git.ts";

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
  const handedOnFields = sender?.step.verification.requiredOutputFields ?? [];
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
        requiredOutputFields: step.verification.requiredOutputFields ?? [],
      },
    },
    context: { fields },
    artifacts,
    requires: { fields: [...handedOnFields], artifacts: [...handedOnArtifacts] },
  };
}

export type HandoffValidation =
  | { accepted: true; handoff: HandoffRevision }
  | { accepted: false; reasons: RejectionReason[] };

/**
 * Validates a handoff revision on the recipient's behalf: the document is checked against the schema, then
 * against the repository it refers to. Every problem found is reported, each with a machine-readable code.
 */
export async function validateHandoffRevision(input: unknown, repo: string): Promise<HandoffValidation> {
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
