import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineWorkflow,
  HANDOFF_REJECTION_REASONS,
  HANDOFF_STATES,
  mock,
  protocolJsonSchemas,
  runWorkflow,
} from "../src/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING, VERIFY_OK } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const published = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));

/** A handoff the runtime issued to a second step, carrying one field and one artifact. */
async function issuedHandoff(): Promise<unknown> {
  const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
  const plan = {
    id: "plan",
    agent: mock({ attempts: [{ edits: [{ path: "PLAN.md", content: "# Plan\n" }], outputFields: { summary: "the plan" } }] }),
    verification: { command: "node ok.mjs", requiredOutputFields: ["summary"] },
    artifacts: ["PLAN.md"],
    instructions: "Plan it.",
  };
  const implement = { id: "implement", agent: mock({ attempts: [{}] }), verification: { command: "node ok.mjs" } };
  const { state } = await runWorkflow(defineWorkflow({ name: "schema", steps: [plan, implement] }), { repo });
  return JSON.parse(JSON.stringify(state.steps[1]?.handoffs[0]?.handoff));
}

describe("the published protocol schemas", () => {
  it("are checked in and match what the protocol code generates", () => {
    for (const [file, schema] of Object.entries(protocolJsonSchemas())) {
      expect(published(file), `${file} is stale: run \`npm run schemas\``).toEqual(schema);
    }
  });

  it("describe a handoff revision at schema version 0.1.0 that real handoffs conform to", async () => {
    const schema = protocolJsonSchemas()["handoff-revision.schema.json"];
    const validate = new Ajv2020({ strict: true }).compile(schema!);
    const handoff = (await issuedHandoff()) as Record<string, unknown>;

    expect(schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", additionalProperties: false });
    expect(validate(handoff), JSON.stringify(validate.errors)).toBe(true);
    expect(handoff.schemaVersion).toBe("0.1.0");

    expect(validate({ ...handoff, schemaVersion: "0.2.0" })).toBe(false);
    expect(validate({ ...handoff, extra: true })).toBe(false);
    expect(validate({ ...handoff, artifacts: [{ path: "PLAN.md", sha256: "not-a-hash" }] })).toBe(false);
    expect(validate({ ...handoff, context: { fields: { "bad name": "x" } } })).toBe(false);
    const { revision: _revision, ...withoutRevision } = handoff;
    expect(validate(withoutRevision)).toBe(false);
  });

  it("describe the evidence a retry's handoff revision carries, and real revisions conform", async () => {
    const validate = new Ajv2020({ strict: true }).compile(protocolJsonSchemas()["handoff-revision.schema.json"]!);
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const retried = defineWorkflow({
      name: "evidence",
      steps: [
        {
          id: "implement",
          agent: mock({
            attempts: [
              { edits: [{ path: "greeting.txt", content: "no\n" }] },
              { edits: [{ path: "greeting.txt", content: "hello\n" }], outputFields: { summary: "done" } },
            ],
          }),
          verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
        },
      ],
    });
    const { state } = await runWorkflow(retried, { repo, clock: fakeClock() });
    const second = JSON.parse(JSON.stringify(state.steps[0]?.handoffs[1]?.handoff)) as { evidence: unknown[] };

    expect(second.evidence.length).toBeGreaterThan(0);
    expect(validate(second), JSON.stringify(validate.errors)).toBe(true);

    const withEvidence = (evidence: unknown[]) => ({ ...second, evidence });
    const output = { kind: "test_output", command: "node verify.mjs", exitCode: 1, signal: null, output: null, truncated: false };
    expect(validate(withEvidence([output]))).toBe(true);
    expect(validate(withEvidence([{ ...output, kind: "hunch" }]))).toBe(false);
    expect(validate(withEvidence([{ ...output, note: "extra" }]))).toBe(false);
    expect(validate(withEvidence([{ ...output, output: 5 }]))).toBe(false);
    expect(validate(withEvidence([{ kind: "required_output_fields", missing: [] }]))).toBe(false);
    expect(validate(withEvidence([{ kind: "protected_paths", violations: [{ path: "a:b", change: "renamed" }], truncated: false }]))).toBe(false);
    // The agent's own file names are not held to the repository-path rules: a legal name must not reject a retry.
    expect(validate(withEvidence([{ kind: "protected_paths", violations: [{ path: "weird:name?.txt", change: "added" }], truncated: false }]))).toBe(true);
    const { evidence: _evidence, ...withoutEvidence } = second;
    expect(validate(withoutEvidence)).toBe(false);
  });

  it("describe the evidence a send-back carries: a review's findings, or a verdict it must correct", async () => {
    const validate = new Ajv2020({ strict: true }).compile(protocolJsonSchemas()["handoff-revision.schema.json"]!);
    const handoff = (await issuedHandoff()) as Record<string, unknown>;
    const second = { ...handoff, revision: 2, supersedes: 1 };
    const withEvidence = (evidence: unknown[]) => ({ ...second, evidence });
    const findings = { kind: "review_findings", reviewStepId: "review", findings: ["rename it"] };
    const verdict = { kind: "review_verdict", reported: "maybe", allowed: ["approved", "changes_requested"] };

    expect(validate(withEvidence([findings, verdict])), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(withEvidence([{ ...findings, findings: [] }]))).toBe(false);
    expect(validate(withEvidence([{ ...findings, findings: [""] }]))).toBe(false);
    expect(validate(withEvidence([{ ...findings, reviewStepId: "Not A Step" }]))).toBe(false);
    expect(validate(withEvidence([{ ...verdict, allowed: ["approved", "maybe"] }]))).toBe(false);
    expect(validate(withEvidence([{ ...findings, extra: true }]))).toBe(false);
  });

  it("describe the evidence of a rejection at an approval gate: the gate and the approver's reason", async () => {
    const validate = new Ajv2020({ strict: true }).compile(protocolJsonSchemas()["handoff-revision.schema.json"]!);
    const handoff = (await issuedHandoff()) as Record<string, unknown>;
    const withEvidence = (evidence: unknown[]) => ({ ...handoff, revision: 2, supersedes: 1, evidence });
    const rejected = { kind: "approval_rejected", gateStepId: "approve", reason: "use a constant" };

    expect(validate(withEvidence([rejected])), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(withEvidence([{ ...rejected, reason: "" }]))).toBe(false);
    expect(validate(withEvidence([{ ...rejected, gateStepId: "Not A Step" }]))).toBe(false);
    expect(validate(withEvidence([{ ...rejected, user: "someone" }]))).toBe(false);
  });

  it("carry the repository-path rules, so a third-party validator rejects paths the SDK rejects", async () => {
    const validate = new Ajv2020({ strict: true }).compile(protocolJsonSchemas()["handoff-revision.schema.json"]!);
    const handoff = (await issuedHandoff()) as { artifacts: { path: string; sha256: string }[] };
    const withPath = (path: string) => ({ ...handoff, artifacts: [{ path, sha256: handoff.artifacts[0]!.sha256 }] });

    for (const path of ["PLAN.md", "docs/PLAN.md", ".github/workflows/ci.yml", ".gitignore", "a.b/c-d_e.txt"]) {
      expect(validate(withPath(path)), `${path} should be accepted`).toBe(true);
    }
    const unsafe = ["", "../outside.txt", "a/../b", "a/..", "./x", "a/./b", "/abs.txt", "dir/", "a//b", "a\\b.txt", "C:/x.txt"];
    for (const path of [...unsafe, ".git/config", ".GIT/hooks/pre-commit", "x".repeat(1025), "what?.txt", "tab\t.txt"]) {
      expect(validate(withPath(path)), `${JSON.stringify(path)} should be rejected`).toBe(false);
    }
  });

  it("enumerate the rejection reasons and handoff states as closed lists", () => {
    const reason = protocolJsonSchemas()["rejection-reason.schema.json"] as {
      properties: { code: { enum: string[] } };
      additionalProperties: boolean;
    };

    // Literal lists: adding a reason or a state is a protocol change that must show up here.
    expect(reason.properties.code.enum).toEqual(["schema_invalid", "artifact_hash_mismatch", "unmet_dependency"]);
    expect([...HANDOFF_REJECTION_REASONS]).toEqual(["schema_invalid", "artifact_hash_mismatch", "unmet_dependency"]);
    expect([...HANDOFF_STATES]).toEqual(["issued", "accepted", "rejected", "superseded"]);
    expect(reason.additionalProperties).toBe(false);
  });
});
