import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineWorkflow,
  mock,
  readRun,
  readRunEvents,
  runWorkflow,
  validateHandoff,
  validateWorkflow,
  WorkflowValidationError,
} from "../src/index.ts";
import type { HandoffRevision, MockAttemptScript, StepDefinition, WorkflowDefinition } from "../src/index.ts";
import { appendLedgerEvent } from "./helpers/ledger.ts";
import { createTempRepo, git, removeTempRepos, VERIFY_OK } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const VERIFY = { command: "node ok.mjs" };

/** A step that makes one attempt: these tests are about handoffs, not retries, so it has none. */
function step(id: string, script: MockAttemptScript = {}, verification: StepDefinition["verification"] = VERIFY) {
  return { id, agent: mock({ attempts: [script] }), verification, retry: { budget: 0 } };
}

describe("handoffs between steps", () => {
  it("issues an immutable, versioned handoff to every step and has it accepted before the attempt starts", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const workflow = defineWorkflow({ name: "two-steps", steps: [step("plan"), step("implement")] });

    const { runId, state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("succeeded");
    for (const s of state.steps) {
      expect(s.handoffs).toHaveLength(1);
      const [view] = s.handoffs;
      expect(view).toMatchObject({ revision: 1, supersedes: null, state: "accepted", rejection: null });
      expect(view?.handoff).toMatchObject({
        schemaVersion: "0.1.0",
        revision: 1,
        supersedes: null,
        contextId: runId,
        to: { stepId: s.id, adapter: "mock", requestedModel: null },
      });
      expect(s.attempts[0]?.handoff).toEqual({ id: view?.handoffId, revision: 1 });
    }
    expect(state.steps[0]?.handoffs[0]?.handoff.from).toBeNull();
    expect(state.steps[1]?.handoffs[0]?.handoff.from).toMatchObject({
      stepId: "plan",
      attemptId: state.steps[0]?.attempts[0]?.id,
    });

    const events = await readRunEvents({ repo, runId });
    const sequence = events.map((e) => e.type).filter((type) => type !== "run_created" && type !== "run_started");
    const perStep = ["step_ready", "handoff_issued", "handoff_accepted", "attempt_created"];
    expect(sequence.slice(0, 4)).toEqual(perStep);
    expect(sequence.filter((type) => type.startsWith("handoff_") || type === "attempt_created")).toEqual([
      "handoff_issued",
      "handoff_accepted",
      "attempt_created",
      "handoff_issued",
      "handoff_accepted",
      "attempt_created",
    ]);
  });
});

describe("static workflow validation", () => {
  const plain = (id: string) => ({ id, agent: mock({ attempts: [{}] }), verification: VERIFY });

  it("rejects a parallel group of steps, naming the steps", () => {
    const problems = validateWorkflow({
      name: "fan-out",
      steps: [plain("plan"), [plain("implement-a"), plain("implement-b")], plain("review")],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("parallel");
    expect(problems[0]).toContain('"implement-a"');
    expect(problems[0]).toContain('"implement-b"');
    expect(problems[0]).toContain("one after another");
  });

  it("rejects properties that would make a step branch or run alongside another", () => {
    for (const key of ["parallel", "dependsOn", "needs", "after"]) {
      const problems = validateWorkflow({ name: "branching", steps: [plain("plan"), { ...plain("implement"), [key]: ["plan"] }] });

      expect(problems).toEqual([expect.stringContaining(`step "implement": \`${key}\` is not supported`)]);
      expect(problems[0]).toContain("linear");
    }
  });

  it("rejects an unknown adapter, naming the step and the adapters that exist", () => {
    const problems = validateWorkflow({
      name: "unknown-adapter",
      steps: [plain("plan"), { ...plain("implement"), agent: { adapter: "gpt-whatever" } }],
    });

    expect(problems).toEqual([expect.stringContaining('step "implement": unknown adapter "gpt-whatever" (known: mock, claude-code, codex)')]);
  });

  it("rejects unknown properties, invalid output field names and unsafe or repeated artifact paths", () => {
    const problems = validateWorkflow({
      name: "details",
      steps: [
        {
          ...plain("plan"),
          colour: "red",
          verification: { command: "node ok.mjs", requiredOutputFields: ["summary", "not a name!", "summary"] },
          artifacts: ["docs/PLAN.md", "../outside.txt", "C:\\plan.md", "docs/PLAN.md"],
        },
        { ...plain("implement"), verification: { command: "node ok.mjs", requiredOutputFields: "summary" }, artifacts: "PLAN.md" },
      ],
    });

    const text = problems.join("\n");
    expect(text).toContain('step "plan": unknown property `colour`');
    expect(text).toContain('step "plan": required output field "not a name!" is not a valid name');
    expect(text).toContain('step "plan": required output field "summary" is listed twice');
    expect(text).toContain('step "plan": artifact path "../outside.txt" must be');
    expect(text).toContain('step "plan": artifact path "C:\\\\plan.md" must be');
    expect(text).toContain('step "plan": artifact path "docs/PLAN.md" is listed twice');
    expect(text).toContain('step "implement": `verification.requiredOutputFields` must be an array');
    expect(text).toContain('step "implement": `artifacts` must be an array');
    expect(problems).toHaveLength(8);
  });

  it("accepts a linear workflow that declares output fields, artifacts and instructions", () => {
    const problems = validateWorkflow({
      name: "ok",
      steps: [
        {
          ...plain("plan"),
          instructions: "Plan the endpoint",
          verification: { command: "node ok.mjs", requiredOutputFields: ["summary", "decisions"] },
          artifacts: ["docs/PLAN.md"],
        },
        plain("implement"),
      ],
    });

    expect(problems).toEqual([]);
  });

  it("rejects an invalid workflow before anything is recorded", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const parallel = { name: "fan-out", steps: [[plain("a"), plain("b")]] };

    await expect(runWorkflow(parallel as never, { repo })).rejects.toThrow(WorkflowValidationError);
    expect(existsSync(join(repo, ".git", "ahp"))).toBe(false);
  });
});

describe("handoff context", () => {
  it("carries the step's instructions in the handoff contract", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const workflow = defineWorkflow({
      name: "instructions",
      steps: [{ ...step("plan"), instructions: "Plan the password-reset endpoint." }, step("implement")],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.steps[0]?.handoffs[0]?.handoff.contract.instructions).toBe("Plan the password-reset endpoint.");
    expect(state.steps[1]?.handoffs[0]?.handoff.contract.instructions).toBeNull();
  });

  it("carries the previous step's required output fields, and nothing else, as the next step's context", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const planned = {
      summary: "Add POST /password-reset",
      decisions: ["tokens expire after 1 hour", "store only token hashes"],
      constraints: "do not add dependencies",
    };
    const workflow = defineWorkflow({
      name: "context",
      steps: [
        step("plan", { outputFields: { ...planned, scratch: "not a required field" } }, {
          ...VERIFY,
          requiredOutputFields: ["summary", "decisions", "constraints"],
        }),
        step("implement", { outputFields: { summary: "implemented", unrelated: "x" } }, {
          ...VERIFY,
          requiredOutputFields: ["summary"],
        }),
        step("review"),
      ],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("succeeded");
    const [plan, implement, review] = state.steps.map((s) => s.handoffs[0]!.handoff);
    expect(plan?.context.fields).toEqual({});
    expect(plan?.contract.acceptance.requiredOutputFields).toEqual(["summary", "decisions", "constraints"]);
    expect(implement?.context.fields).toEqual(planned);
    expect(implement?.requires.fields).toEqual(["summary", "decisions", "constraints"]);
    expect(review?.context.fields).toEqual({ summary: "implemented" });
    expect(review?.requires.fields).toEqual(["summary"]);
  });
});

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

describe("artifacts", () => {
  it("passes the previous step's artifacts by reference with the SHA-256 of their committed content", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const plan = "# Plan\n- add the endpoint\n";
    const workflow = defineWorkflow({
      name: "artifacts",
      steps: [
        { ...step("plan", { edits: [{ path: "docs/PLAN.md", content: plan }] }), artifacts: ["docs/PLAN.md"] },
        step("implement"),
      ],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("succeeded");
    const [planStep, implementStep] = state.steps;
    const handoff = implementStep?.handoffs[0]?.handoff;
    expect(handoff?.artifacts).toEqual([{ path: "docs/PLAN.md", sha256: sha256(plan) }]);
    expect(handoff?.requires.artifacts).toEqual(["docs/PLAN.md"]);
    expect(planStep?.handoffs[0]?.handoff.artifacts).toEqual([]);

    // The reference points at something the recipient can see: its workspace starts from the sender's snapshot.
    const snapshot = planStep?.attempts[0]?.snapshot?.commit;
    expect(handoff?.base.commit).toBe(snapshot);
    const workspace = implementStep!.attempts[0]!.workspace;
    expect(git(workspace, "rev-parse", "HEAD")).toBe(snapshot);
    expect(readFileSync(join(workspace, "docs", "PLAN.md"), "utf8").replaceAll("\r\n", "\n")).toBe(plan);
  });

  it("hashes the same artifact identically whether the checkout has CRLF or LF line endings", async () => {
    const committed = { plan: "one\ntwo\n", notes: "alpha\nbeta\n" };
    // Repo A converts to CRLF on checkout and an agent there writes CRLF; repo B does neither.
    const crlf = createTempRepo({ "ok.mjs": VERIFY_OK, "notes.txt": committed.notes }, { "core.autocrlf": "true" });
    const lf = createTempRepo({ "ok.mjs": VERIFY_OK, "notes.txt": committed.notes }, { "core.autocrlf": "false" });
    const workflowFor = (plan: string) =>
      defineWorkflow({
        name: "line-endings",
        steps: [
          { ...step("plan", { edits: [{ path: "PLAN.md", content: plan }] }), artifacts: ["PLAN.md", "notes.txt"] },
          step("implement"),
        ],
      });

    const withCrlf = await runWorkflow(workflowFor(committed.plan.replaceAll("\n", "\r\n")), { repo: crlf });
    const withLf = await runWorkflow(workflowFor(committed.plan), { repo: lf });

    // The expected hashes come from the LF bytes git stores, computed here independently of the runtime.
    const expected = [
      { path: "PLAN.md", sha256: sha256(committed.plan) },
      { path: "notes.txt", sha256: sha256(committed.notes) },
    ];
    expect(withCrlf.state.steps[1]?.handoffs[0]?.handoff.artifacts).toEqual(expected);
    expect(withLf.state.steps[1]?.handoffs[0]?.handoff.artifacts).toEqual(expected);

    // The test is meaningful only if the working trees really differ: the CRLF recipient sees CRLF bytes.
    const seen = (workspace: string, file: string) => readFileSync(join(workspace, file), "utf8");
    const crlfWorkspace = withCrlf.state.steps[1]!.attempts[0]!.workspace;
    const lfWorkspace = withLf.state.steps[1]!.attempts[0]!.workspace;
    expect(seen(crlfWorkspace, "notes.txt")).toBe(committed.notes.replaceAll("\n", "\r\n"));
    expect(seen(crlfWorkspace, "PLAN.md")).toBe(committed.plan.replaceAll("\n", "\r\n"));
    expect(seen(lfWorkspace, "notes.txt")).toBe(committed.notes);
    expect(sha256(seen(crlfWorkspace, "notes.txt"))).not.toBe(expected[1]?.sha256);
  });

  it("rejects the handoff as an unmet dependency when a declared artifact is missing, and starts no attempt", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const workflow = defineWorkflow({
      name: "missing-artifact",
      steps: [{ ...step("plan"), artifacts: ["PLAN.md"] }, step("implement")],
    });

    const { runId, state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("failed");
    const [plan, implement] = state.steps;
    expect(plan?.state).toBe("succeeded");
    expect(implement).toMatchObject({ state: "failed", failureClass: "rejected", attempts: [] });
    const [view] = implement?.handoffs ?? [];
    expect(view?.state).toBe("rejected");
    expect(view?.rejection).toEqual([
      expect.objectContaining({ code: "unmet_dependency", pointer: "/requires/artifacts/0" }),
    ]);
    expect(view?.rejection?.[0]?.message).toContain("PLAN.md");

    const events = await readRunEvents({ repo, runId });
    expect(events.filter((e) => e.type === "attempt_created")).toHaveLength(1);
    expect(events.map((e) => e.type).slice(-3)).toEqual(["handoff_rejected", "step_terminal", "run_terminal"]);
  });
});

describe("replaying handoff revisions from the ledger", () => {
  /** A finished two-step run, and the handoff its second step ran under (accepted). */
  async function finishedRun(
    workflow: WorkflowDefinition = defineWorkflow({ name: "replay", steps: [step("plan"), step("implement")] }),
  ) {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const { runId, state } = await runWorkflow(workflow, { repo });
    return { repo, runId, handoff: state.steps[1]!.handoffs[0]!.handoff };
  }
  const revision = (handoff: HandoffRevision, number: number): HandoffRevision => ({
    ...handoff,
    revision: number,
    supersedes: number === 1 ? null : number - 1,
  });

  it("marks the earlier revision superseded when a later revision of the same handoff is issued", async () => {
    const { repo, runId, handoff } = await finishedRun();

    appendLedgerEvent(repo, runId, { type: "handoff_issued", handoff: revision(handoff, 2) });

    const views = (await readRun({ repo, runId })).steps[1]!.handoffs;
    expect(views.map((v) => [v.revision, v.supersedes, v.state])).toEqual([
      [1, null, "superseded"],
      [2, 1, "issued"],
    ]);
    expect(views[0]?.handoff).toEqual(handoff);
  });

  it("refuses a ledger that re-issues or skips a revision, because a revision is immutable once written", async () => {
    for (const [name, number] of [["re-issues revision 1", 1], ["skips to revision 3", 3]] as const) {
      const { repo, runId, handoff } = await finishedRun();

      appendLedgerEvent(repo, runId, { type: "handoff_issued", handoff: revision(handoff, number) });

      await expect(readRun({ repo, runId }), name).rejects.toThrow(/revision/);
    }
  });

  it("refuses a ledger that decides a revision twice", async () => {
    const { repo, runId, handoff } = await finishedRun();

    appendLedgerEvent(repo, runId, { type: "handoff_rejected", handoffId: handoff.handoffId, revision: 1, reasons: [] });

    await expect(readRun({ repo, runId })).rejects.toThrow(/already accepted/);
  });

  it("refuses a ledger that starts an attempt under a handoff that was not accepted", async () => {
    const withMissingArtifact = defineWorkflow({
      name: "rejected",
      steps: [{ ...step("plan"), artifacts: ["PLAN.md"] }, step("implement")],
    });
    const { repo, runId, handoff } = await finishedRun(withMissingArtifact);
    expect((await readRun({ repo, runId })).steps[1]?.handoffs[0]?.state).toBe("rejected");

    appendLedgerEvent(repo, runId, {
      type: "attempt_created",
      stepId: "implement",
      attemptId: "att_sneaky",
      handoffId: handoff.handoffId,
      handoffRevision: 1,
      adapter: "mock",
      mock: true,
      requestedModel: null,
      workspace: "/nowhere",
    });

    await expect(readRun({ repo, runId })).rejects.toThrow(/not accepted/);
  });
});

describe("validating a handoff on the recipient's behalf", () => {
  /** A repo and the handoff its second step was given: one context field and one artifact. */
  async function issuedHandoff() {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const workflow = defineWorkflow({
      name: "validate",
      steps: [
        {
          ...step("plan", { edits: [{ path: "PLAN.md", content: "# Plan\n" }], outputFields: { summary: "the plan" } }, {
            ...VERIFY,
            requiredOutputFields: ["summary"],
          }),
          artifacts: ["PLAN.md"],
        },
        step("implement"),
      ],
    });
    const { state } = await runWorkflow(workflow, { repo });
    // A handoff is a document: validate what a recipient would receive, not the runtime's own object.
    const handoff = JSON.parse(JSON.stringify(state.steps[1]!.handoffs[0]!.handoff)) as HandoffRevision;
    return { repo, handoff };
  }

  it("accepts a handoff exactly as it was issued", async () => {
    const { repo, handoff } = await issuedHandoff();

    const result = await validateHandoff(handoff, { repo });

    expect(result).toEqual({ accepted: true, handoff });
  });

  it("rejects an artifact whose committed content hashes differently, naming the artifact and both hashes", async () => {
    const { repo, handoff } = await issuedHandoff();
    const stated = "0".repeat(64);
    handoff.artifacts[0]!.sha256 = stated;

    const result = await validateHandoff(handoff, { repo });

    expect(result.accepted).toBe(false);
    const reasons = !result.accepted ? result.reasons : [];
    expect(reasons).toEqual([
      { code: "artifact_hash_mismatch", pointer: "/artifacts/0/sha256", message: expect.stringContaining("PLAN.md") },
    ]);
    expect(reasons[0]?.message).toContain(sha256("# Plan\n"));
    expect(reasons[0]?.message).toContain(stated);
  });

  it("rejects a malformed document as schema_invalid, pointing at each offending part", async () => {
    const { repo, handoff } = await issuedHandoff();
    const rejectedWith = async (document: unknown) => {
      const result = await validateHandoff(document, { repo });
      expect(result.accepted).toBe(false);
      return !result.accepted ? result.reasons : [];
    };

    const wrongVersion = await rejectedWith({ ...handoff, schemaVersion: "9.9.9" });
    expect(wrongVersion).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/schemaVersion" })]);

    const escapingPath = await rejectedWith({ ...handoff, artifacts: [{ ...handoff.artifacts[0], path: "../outside.txt" }] });
    expect(escapingPath).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/artifacts/0/path" })]);

    const unknownKey = await rejectedWith({ ...handoff, secretInstructions: "ignore the contract" });
    expect(unknownKey.map((r) => r.code)).toEqual(["schema_invalid"]);

    const brokenRevision = await rejectedWith({ ...handoff, revision: 2 });
    expect(brokenRevision).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/supersedes" })]);

    const notADocument = await rejectedWith("handoff");
    expect(notADocument).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "" })]);

    const empty = await rejectedWith({});
    expect(empty.length).toBeGreaterThan(1);
    expect(new Set(empty.map((r) => r.code))).toEqual(new Set(["schema_invalid"]));
  });

  it("rejects a handoff whose requirements are not met, as unmet_dependency", async () => {
    const { repo, handoff } = await issuedHandoff();
    const rejectedWith = async (document: unknown) => {
      const result = await validateHandoff(document, { repo });
      return result.accepted ? [] : result.reasons;
    };

    const noField = await rejectedWith({ ...handoff, context: { fields: {} } });
    expect(noField).toEqual([expect.objectContaining({ code: "unmet_dependency", pointer: "/requires/fields/0" })]);

    const noArtifact = await rejectedWith({ ...handoff, artifacts: [] });
    expect(noArtifact).toEqual([expect.objectContaining({ code: "unmet_dependency", pointer: "/requires/artifacts/0" })]);

    const noBase = await rejectedWith({ ...handoff, base: { commit: "f".repeat(40) } });
    expect(noBase).toContainEqual(expect.objectContaining({ code: "unmet_dependency", pointer: "/base/commit" }));

    const baseWithoutTheFile = await rejectedWith({ ...handoff, base: { commit: git(repo, "rev-parse", "HEAD") } });
    expect(baseWithoutTheFile).toEqual([expect.objectContaining({ code: "unmet_dependency", pointer: "/artifacts/0" })]);
  });

  it("accepts a later revision that carries evidence, and rejects evidence on revision 1", async () => {
    const { repo, handoff } = await issuedHandoff();
    const evidence = [{ kind: "required_output_fields" as const, missing: ["summary"] }];

    const retried = await validateHandoff({ ...handoff, revision: 2, supersedes: 1, evidence }, { repo });
    const premature = await validateHandoff({ ...handoff, evidence }, { repo });

    expect(retried.accepted).toBe(true);
    expect(premature).toEqual({
      accepted: false,
      reasons: [expect.objectContaining({ code: "schema_invalid", pointer: "/evidence" })],
    });
  });

  it("reports every problem at once", async () => {
    const { repo, handoff } = await issuedHandoff();
    handoff.artifacts[0]!.sha256 = "0".repeat(64);
    handoff.context.fields = {};

    const result = await validateHandoff(handoff, { repo });

    const codes = result.accepted ? [] : result.reasons.map((r) => r.code).sort();
    expect(codes).toEqual(["artifact_hash_mismatch", "unmet_dependency"]);
  });
});

describe("required output fields", () => {
  const REQUIRED = ["summary", "decisions", "constraints"];

  it("fails verification with evidence naming the missing and blank fields, even though the command passed", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const workflow = defineWorkflow({
      name: "missing-fields",
      steps: [
        step("plan", { outputFields: { summary: "A plan", decisions: "   " } }, { ...VERIFY, requiredOutputFields: REQUIRED }),
        step("implement"),
      ],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("failed");
    const [plan, implement] = state.steps;
    expect(plan).toMatchObject({ state: "failed", failureClass: "verification_failed" });
    const verification = plan?.attempts[0]?.verification;
    expect(verification?.state).toBe("fail");
    expect(verification?.evidence).toContainEqual({
      kind: "required_output_fields",
      required: REQUIRED,
      missing: ["decisions", "constraints"],
    });
    expect(verification?.evidence).toContainEqual(expect.objectContaining({ kind: "test_output", exitCode: 0 }));
    expect(implement).toMatchObject({ state: "blocked", handoffs: [], attempts: [] });
  });

  it("verifies a step that declares only required output fields, structurally, without running a command", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const fieldsOnly = (outputFields: Record<string, string>) =>
      defineWorkflow({
        name: "structural",
        steps: [step("review", { outputFields }, { requiredOutputFields: ["verdict", "findings"] })],
      });

    const complete = await runWorkflow(fieldsOnly({ verdict: "approved", findings: "none" }), { repo });
    const incomplete = await runWorkflow(fieldsOnly({ verdict: "approved" }), { repo });

    expect(complete.state.state).toBe("succeeded");
    const verification = complete.state.steps[0]?.attempts[0]?.verification;
    expect(verification).toMatchObject({ state: "pass", command: null, worktree: null });
    expect(verification?.evidence).toEqual([
      { kind: "required_output_fields", required: ["verdict", "findings"], missing: [] },
    ]);
    expect(complete.state.steps[0]?.handoffs[0]?.handoff.contract.acceptance.verificationCommand).toBeNull();

    expect(incomplete.state.state).toBe("failed");
    expect(incomplete.state.steps[0]).toMatchObject({ state: "failed", failureClass: "verification_failed" });
    expect(incomplete.state.steps[0]?.attempts[0]?.verification?.evidence).toEqual([
      { kind: "required_output_fields", required: ["verdict", "findings"], missing: ["findings"] },
    ]);
  });

  it("rejects, before running, a step that would succeed without checking anything", () => {
    const attempts = mock({ attempts: [{}] });
    const problemsFor = (verification: object) =>
      validateWorkflow({ name: "no-check", steps: [{ id: "review", agent: attempts, verification }] });

    for (const verification of [{}, { requiredOutputFields: [] }]) {
      expect(problemsFor(verification)).toEqual([
        expect.stringContaining('step "review": needs a `verification.command` or at least one required output field'),
      ]);
    }
    expect(problemsFor({ requiredOutputFields: ["verdict"] })).toEqual([]);
    expect(problemsFor({ command: "node ok.mjs" })).toEqual([]);
    expect(problemsFor({ command: "  " })).toEqual(['step "review": needs a non-empty `verification.command`']);
  });

  it("passes verification when every required field is reported", async () => {
    const repo = createTempRepo({ "ok.mjs": VERIFY_OK });
    const outputFields = { summary: "A plan", decisions: ["use bcrypt", "tokens expire in 1h"], constraints: "no new deps" };
    const workflow = defineWorkflow({
      name: "all-fields",
      steps: [step("plan", { outputFields }, { ...VERIFY, requiredOutputFields: REQUIRED })],
    });

    const { state } = await runWorkflow(workflow, { repo });

    expect(state.state).toBe("succeeded");
    const attempt = state.steps[0]?.attempts[0];
    expect(attempt?.reportedOutput).toEqual(outputFields);
    expect(attempt?.verification?.evidence).toContainEqual({
      kind: "required_output_fields",
      required: REQUIRED,
      missing: [],
    });
  });
});
