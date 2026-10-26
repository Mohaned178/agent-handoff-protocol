// The handoff: the immutable, versioned envelope that passes a step's contract, context and artifact
// references to the next coding agent. The Zod schemas here are the source of the published JSON Schema.
//
// A2A alignment (design doc §3): `contextId` groups the handoffs of one run. Acceptance criteria, artifact
// hashes and rejection reasons are AHP-specific and belong to the A2A extension profile (ticket 17).

import { z } from "zod";
import { CAPABILITY_KINDS, ENFORCEMENT_LEVELS, NETWORK_STANCES } from "./capabilities.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/** Handoff revision states. `superseded` is set when a later revision of the same handoff is issued. */
export const HANDOFF_STATES = ["issued", "accepted", "rejected", "superseded"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/**
 * Why a handoff revision is rejected. A new reason is a protocol change.
 * - `schema_invalid`: the document is not a valid handoff revision.
 * - `artifact_hash_mismatch`: an artifact exists at the base commit but its committed content hashes differently.
 * - `unmet_dependency`: something the handoff requires is not there: a required field missing from the context,
 *   a required artifact not listed, or a listed artifact (or the base commit) absent from the repository.
 * - `capability_unsatisfiable`: the recipient's adapter cannot apply a requested capability, or the network stance, at the
 *   enforcement level the handoff requires on this operating system.
 */
export const HANDOFF_REJECTION_REASONS = ["schema_invalid", "artifact_hash_mismatch", "unmet_dependency", "capability_unsatisfiable"] as const;
export type HandoffRejectionReason = (typeof HANDOFF_REJECTION_REASONS)[number];

/**
 * What a review concludes. `changes_requested` sends the step before the review back (ADR 0004); `approved` lets the
 * run go on. A closed list: a new verdict is a protocol change.
 */
export const REVIEW_VERDICTS = ["approved", "changes_requested"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** How an attempt changed a path, from the step's base commit to the attempt's snapshot. */
export const PATH_CHANGES = ["added", "modified", "deleted"] as const;
export type PathChange = (typeof PATH_CHANGES)[number];

// ---------------------------------------------------------------------------
// Identifiers and value rules shared by the workflow definition and the handoff

const STEP_ID = /^[a-z0-9][a-z0-9_-]*$/;
const OUTPUT_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_REPO_PATH_LENGTH = 1024;
/**
 * A path relative to the repository root, written with forward slashes: no leading or trailing slash, no empty,
 * `.` or `..` segments, nothing under `.git` (any case), and none of the characters `\ : * ? " < > |` or
 * control characters, which are invalid in a Windows path. Written as one regex so the published JSON Schema
 * carries the same rule the SDK enforces.
 */
const REPO_PATH_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[^/\\:*?"<>|\u0000-\u001f]+`;
const REPO_PATH = new RegExp(String.raw`^(?!\.[gG][iI][tT](?:/|$))${REPO_PATH_SEGMENT}(?:/${REPO_PATH_SEGMENT})*$`, "u");

/** Step IDs appear in paths and git ref names. */
export function isStepId(value: unknown): value is string {
  return typeof value === "string" && STEP_ID.test(value);
}

export function isOutputFieldName(value: unknown): value is string {
  return typeof value === "string" && OUTPUT_FIELD_NAME.test(value);
}

/** True for a path that is safe to read from a repository on every OS (see `REPO_PATH`). */
export function isRepoPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REPO_PATH_LENGTH && REPO_PATH.test(value);
}

/** What an output field holds: text, or a list of text items (for example `decisions` and `constraints`). */
export type OutputFieldValue = string | string[];

/**
 * A required output field is present when it holds some non-blank text. Missing, blank and empty values are
 * all "missing": a field that says nothing cannot carry a decision to the next step.
 */
export function isPresentOutputField(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((item) => typeof item === "string" && item.trim() !== "");
  return false;
}

const idPattern = (prefix: string) => new RegExp(`^${prefix}_[a-z0-9]+$`);

const stepIdSchema = z.string().regex(STEP_ID);
const fieldNameSchema = z.string().regex(OUTPUT_FIELD_NAME);
const repoPathSchema = z
  .string()
  .max(MAX_REPO_PATH_LENGTH)
  .regex(REPO_PATH, "must be a repository-relative path with forward slashes")
  .describe(
    "Relative to the repository root, written with forward slashes: no leading or trailing slash, no `.` or `..` " +
      'segments, nothing under `.git`, and none of the characters \\ : * ? " < > | or control characters.',
  );
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const outputFieldValueSchema = z.union([z.string(), z.array(z.string())]);

// ---------------------------------------------------------------------------
// Handoff revision

export const ArtifactReferenceSchema = z
  .strictObject({
    path: repoPathSchema,
    sha256: sha256Schema.describe(
      "SHA-256 (lowercase hex) of the file's committed content, never of working-tree bytes (ADR 0005).",
    ),
  })
  .describe(
    "A file passed by reference, read from the handoff's base commit. AHP extension: A2A artifacts carry no content hash.",
  );

const requiredLevelSchema = z
  .enum(ENFORCEMENT_LEVELS)
  .describe("The weakest enforcement level the recipient's adapter may apply this at on the running operating system; a weaker one rejects the handoff.");

export const CapabilityRequestSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("read_only"), require: requiredLevelSchema }),
    z.strictObject({
      kind: z.literal("write_scope"),
      paths: z.array(repoPathSchema).min(1).describe("The only paths the agent may change, each a file or a directory with everything under it."),
      require: requiredLevelSchema,
    }),
    z.strictObject({ kind: z.literal("no_external_actions"), require: requiredLevelSchema }),
  ])
  .describe(
    "A capability the recipient's adapter is to apply to the coding agent's tool use. `enforced_by_tool` means the tool " +
      "blocks what it forbids; `cooperative` means the agent is only asked, which is not enforcement. AHP extension: no A2A counterpart.",
  );

export const NetworkRequestSchema = z
  .strictObject({
    stance: z.enum(NETWORK_STANCES).describe("The network access the agent's own tool use has, never its connection to its model provider."),
    require: requiredLevelSchema,
  })
  .describe("The step's network stance. AHP extension: no A2A counterpart.");

/**
 * What a retry tells the coding agent about why the step's last attempt failed: the failing parts of its
 * verification, trimmed to what the agent may see (shared refs it changed among them: only AHP performs external
 * actions), the findings of the review that sent it back, or the reason a person rejected its result at an approval
 * gate. AHP extension: no A2A counterpart. A new kind is a protocol change.
 */
export const HandoffEvidenceSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("test_output"),
      command: z.string().min(1),
      exitCode: z.int().nullable(),
      signal: z.string().nullable(),
      output: z
        .string()
        .nullable()
        .describe(
          "The end of the command's output, or null when it is withheld because the command runs hidden tests, whose " +
            "output must not reach the agent.",
        ),
      truncated: z.boolean().describe("True when `output` holds only the end of a longer output."),
    }),
    z.strictObject({
      kind: z.literal("required_output_fields"),
      missing: z.array(fieldNameSchema).min(1).describe("The required output fields the attempt did not report, or reported blank."),
    }),
    z.strictObject({
      kind: z.literal("review_findings"),
      reviewStepId: stepIdSchema.describe("The review step that sent this step back."),
      findings: z.array(z.string().min(1)).min(1).describe("What the review found, in its words."),
    }),
    z.strictObject({
      kind: z.literal("approval_rejected"),
      gateStepId: stepIdSchema.describe("The approval gate where a person rejected this step's result."),
      reason: z.string().min(1).describe("Why the approver rejected it, in their words."),
    }),
    z.strictObject({
      kind: z.literal("review_verdict"),
      reported: outputFieldValueSchema.describe("What the review reported as its verdict."),
      allowed: z.array(z.enum(REVIEW_VERDICTS)).min(1).describe("The verdicts a review may report."),
    }),
    z.strictObject({
      kind: z.literal("protected_paths"),
      violations: z
        .array(
          z.strictObject({
            // Paths the agent itself changed, not checked against the repository-path rules: a file name that is
            // legal on the agent's OS must not turn a retry into a rejected handoff.
            path: z.string(),
            change: z.enum(PATH_CHANGES),
          }),
        )
        .min(1)
        .describe("The paths the attempt changed that it must not change. The other protected paths are not listed."),
      truncated: z.boolean().describe("True when `violations` lists only the first of more."),
    }),
    z.strictObject({
      kind: z.literal("forbidden_external_action_detected"),
      changed: z
        .array(
          z.strictObject({
            name: z.string().min(1).describe("The ref, such as refs/heads/main or refs/remotes/origin/main."),
            before: z.string().nullable().describe("The object it pointed at before the attempt; null when it did not exist."),
            after: z.string().nullable().describe("The object it pointed at after the attempt; null when it was deleted."),
          }),
        )
        .min(1)
        .describe("The shared repository's refs that changed while the attempt ran. Only AHP pushes, opens or merges."),
      truncated: z.boolean().describe("True when `changed` lists only the first of more."),
    }),
  ])
  .describe("One failing part of the verification of the attempt this revision follows.");

export const HandoffRevisionSchema = z
  .strictObject({
    schemaVersion: z.literal(PROTOCOL_VERSION).describe("Version of this schema."),
    handoffId: z.string().regex(idPattern("hnd")).describe("Identifies the handoff across its revisions."),
    revision: z.int().min(1).describe("1 for the first revision; a change is always a new revision."),
    supersedes: z
      .int()
      .min(1)
      .nullable()
      .describe("The revision this one replaces: null for revision 1, otherwise revision - 1."),
    contextId: z.string().regex(idPattern("run")).describe("A2A `contextId`: the run the handoff belongs to."),
    from: z
      .strictObject({
        stepId: stepIdSchema,
        attemptId: z.string().regex(idPattern("att")),
      })
      .nullable()
      .describe("The verified attempt whose result is handed on; null for the first step."),
    to: z
      .strictObject({
        stepId: stepIdSchema,
        adapter: z.string().min(1),
        requestedModel: z.string().min(1).nullable().describe("As requested; never what the tool reports."),
      })
      .describe("The recipient step and its coding agent."),
    base: z
      .strictObject({ commit: gitObjectIdSchema })
      .describe("The commit the recipient's workspace starts from, and the commit artifacts are read from."),
    contract: z
      .strictObject({
        instructions: z.string().min(1).nullable().describe("What the step is to do, as the workflow states it."),
        acceptance: z.strictObject({
          verificationCommand: z.string().min(1).nullable(),
          requiredOutputFields: z.array(fieldNameSchema).describe("Fields the attempt must report to pass."),
        }),
      })
      .describe("The recipient step's contract. AHP extension: acceptance criteria."),
    capabilities: z
      .array(CapabilityRequestSchema)
      .describe("What the recipient's adapter is to apply, at least at each request's required level. Every agent step carries `no_external_actions`."),
    network: NetworkRequestSchema,
    context: z
      .strictObject({
        fields: z
          .record(fieldNameSchema, outputFieldValueSchema)
          .describe("The previous step's required output fields (for example decisions, constraints, summary)."),
      })
      .describe("What earlier steps decided and learned."),
    artifacts: z.array(ArtifactReferenceSchema).describe("Files from the previous step, passed by reference."),
    evidence: z
      .array(HandoffEvidenceSchema)
      .describe("Why the step's last attempt failed, attached by a retry; empty for revision 1. AHP extension."),
    requires: z
      .strictObject({
        fields: z.array(fieldNameSchema),
        artifacts: z.array(repoPathSchema),
      })
      .describe("What the recipient cannot start without; `context` and `artifacts` must cover it."),
  })
  .superRefine((handoff, ctx) => {
    // These rules are enforced by the validator; JSON Schema cannot express them.
    const expected = handoff.revision === 1 ? null : handoff.revision - 1;
    if (handoff.supersedes !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["supersedes"],
        message: `revision ${handoff.revision} must supersede ${expected === null ? "nothing (null)" : `revision ${expected}`}`,
      });
    }
    if (handoff.revision === 1 && handoff.evidence.length > 0) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "revision 1 carries no evidence: evidence is attached by a retry" });
    }
    const duplicates = (path: (string | number)[], values: string[]) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) ctx.addIssue({ code: "custom", path: [...path, index], message: `duplicate "${value}"` });
        seen.add(value);
      });
    };
    duplicates(["artifacts"], handoff.artifacts.map((a) => a.path));
    duplicates(["requires", "fields"], handoff.requires.fields);
    duplicates(["requires", "artifacts"], handoff.requires.artifacts);
    duplicates(["contract", "acceptance", "requiredOutputFields"], handoff.contract.acceptance.requiredOutputFields);
    const kinds = handoff.capabilities.map((c) => c.kind);
    duplicates(["capabilities"], kinds);
    handoff.capabilities.forEach((capability, index) => {
      if (capability.kind === "write_scope") duplicates(["capabilities", index, "paths"], capability.paths);
    });
    if (kinds.includes("read_only") && kinds.includes("write_scope")) {
      ctx.addIssue({ code: "custom", path: ["capabilities"], message: "`read_only` and `write_scope` contradict each other" });
    }
  })
  .meta({
    title: "AHP handoff revision",
    description:
      "An immutable revision of a handoff. Rules JSON Schema cannot express: `supersedes` is null for revision 1 " +
      "and revision - 1 otherwise; revision 1 carries no evidence; paths and field names listed in one array are unique; " +
      "each capability kind is requested at most once, and `read_only` and `write_scope` are not requested together.",
  });

export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;
export type NetworkRequest = z.infer<typeof NetworkRequestSchema>;
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
export type HandoffRevision = z.infer<typeof HandoffRevisionSchema>;
export type HandoffEvidence = z.infer<typeof HandoffEvidenceSchema>;

// ---------------------------------------------------------------------------
// Rejection

export const RejectionReasonSchema = z.strictObject({
  code: z.enum(HANDOFF_REJECTION_REASONS),
  /** RFC 6901 JSON Pointer to the part of the handoff the reason is about; "" for the whole document. */
  pointer: z.string(),
  message: z.string(),
});

export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

export type ParsedHandoff = { ok: true; handoff: HandoffRevision } | { ok: false; reasons: RejectionReason[] };

/** Checks that `input` is a valid handoff revision; every problem becomes a `schema_invalid` reason. */
export function parseHandoffRevision(input: unknown): ParsedHandoff {
  const parsed = HandoffRevisionSchema.safeParse(input);
  if (parsed.success) return { ok: true, handoff: parsed.data };
  return {
    ok: false,
    reasons: parsed.error.issues.map((issue) => ({
      code: "schema_invalid",
      pointer: pointerOf(issue.path),
      message: issue.message,
    })),
  };
}
