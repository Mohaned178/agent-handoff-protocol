import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterDeclaration, AttemptExit, AttemptInput } from "../src/adapters/index.ts";
import { mockAdapter } from "../src/adapters/mock/index.ts";
import {
  isUsageReport,
  levelOn,
  meetsLevel,
  MOCK_USAGE_SOURCE,
  readRunEvents,
  runWorkflow,
  sameOnEveryOs,
  validateHandoff,
  validateWorkflow,
  type EnforcementLevel,
  type LevelsByOs,
  type WorkflowDefinition,
} from "../src/index.ts";
import { executeRun } from "../src/runtime/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";
import { failing, goodbye, hello, implementOf, retryWorkflow } from "./helpers/retry.ts";

afterEach(removeTempRepos);

const perOs = (win32: EnforcementLevel, darwin: EnforcementLevel, linux: EnforcementLevel): LevelsByOs => ({ win32, darwin, linux });

/** The mock adapter under another static declaration: what the runtime checks a handoff against. */
const mockWith = (declaration: Partial<AdapterDeclaration>): Adapter => ({
  ...mockAdapter,
  declaration: { ...mockAdapter.declaration, ...declaration },
});

/** What an adapter with real control of its tool declares, to see the runtime record each level. */
const STRONG: Partial<AdapterDeclaration> = {
  capabilities: {
    read_only: sameOnEveryOs("enforced_by_tool"),
    write_scope: sameOnEveryOs("enforced_by_tool"),
    no_external_actions: sameOnEveryOs("cooperative"),
  },
  network: { deny: sameOnEveryOs("cooperative"), package_registries: sameOnEveryOs("cooperative") },
};

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe("capabilities and network stance of a step", () => {
  it("asks every agent step for the baseline `no_external_actions` and the `deny` stance, and reports what the adapter reaches", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { runId, state } = await runWorkflow(retryWorkflow([hello]), { repo });

    expect(state.state).toBe("succeeded");
    const handoff = only(implementOf(state).handoffs).handoff;
    // The baseline requires nothing and the default stance requires nothing: asked, reported, never a reason to reject.
    expect(handoff.capabilities).toEqual([{ kind: "no_external_actions", require: "none" }]);
    expect(handoff.network).toEqual({ stance: "deny", require: "none" });
    const expected = {
      platform: process.platform,
      capabilities: [{ kind: "no_external_actions", require: "none", level: "cooperative" }],
      network: { stance: "deny", require: "none", level: "none" },
    };
    expect(only(implementOf(state).attempts).capabilities).toEqual(expected);
    const created = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_created");
    expect(created).toMatchObject({ capabilities: expected });
  });

  it("records what a step asked for and the level the adapter declares for each, and hands the same to the adapter", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const started: AttemptInput[] = [];
    const adapter: Adapter = { ...mockWith(STRONG), startAttempt: (input) => (started.push(input), mockAdapter.startAttempt(input)) };
    const step = {
      capabilities: [
        { kind: "write_scope" as const, paths: ["greeting.txt", "docs"], require: "enforced_by_tool" as const },
        { kind: "no_external_actions" as const },
      ],
      network: { stance: "package_registries" as const },
    };

    const { state } = await executeRun(retryWorkflow([hello], step), { repo, adapters: new Map([["mock", adapter]]) });

    expect(state.state).toBe("succeeded");
    const expected = {
      platform: process.platform,
      capabilities: [
        { kind: "write_scope", paths: ["greeting.txt", "docs"], require: "enforced_by_tool", level: "enforced_by_tool" },
        // Listed without a level: the default asks the adapter at least to ask the agent.
        { kind: "no_external_actions", require: "cooperative", level: "cooperative" },
      ],
      network: { stance: "package_registries", require: "none", level: "cooperative" },
    };
    expect(only(implementOf(state).attempts).capabilities).toEqual(expected);
    expect(only(started).capabilities).toEqual(expected);
  });

  it("rejects a handoff whose capability the adapter cannot reach at the required level, and runs no agent", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = { capabilities: [{ kind: "read_only" as const, require: "enforced_by_tool" as const }] };

    const { runId, state } = await runWorkflow(retryWorkflow([hello], step), { repo });

    expect(state.state).toBe("failed");
    const implement = implementOf(state);
    expect(implement).toMatchObject({ state: "failed", failureClass: "rejected", attempts: [] });
    const view = only(implement.handoffs);
    expect(view.state).toBe("rejected");
    expect(view.rejection).toEqual([
      {
        code: "capability_unsatisfiable",
        pointer: "/capabilities/0",
        message: `adapter "mock" applies read_only at most at "cooperative" on ${process.platform}, and the handoff requires "enforced_by_tool"`,
      },
    ]);
    const types = (await readRunEvents({ repo, runId })).map((event) => event.type);
    expect(types).toContain("handoff_rejected");
    expect(types).not.toContain("attempt_created");
  });

  it("rejects a network stance the adapter cannot reach at the required level, saying it cannot apply it", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = { network: { stance: "deny" as const, require: "cooperative" as const } };

    const { state } = await runWorkflow(retryWorkflow([hello], step), { repo });

    expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "rejected" });
    const reasons = only(implementOf(state).handoffs).rejection!;
    expect(reasons).toEqual([expect.objectContaining({ code: "capability_unsatisfiable", pointer: "/network" })]);
    expect(reasons[0]!.message).toBe(`adapter "mock" cannot apply the network stance "deny" on ${process.platform}, and the handoff requires "cooperative"`);
  });

  it("reports every request it cannot satisfy, not only the first", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = {
      capabilities: [
        { kind: "write_scope" as const, paths: ["src"], require: "enforced_by_tool" as const },
        { kind: "no_external_actions" as const, require: "enforced_by_tool" as const },
      ],
      network: { stance: "package_registries" as const, require: "enforced_by_tool" as const },
    };

    const { state } = await runWorkflow(retryWorkflow([hello], step), { repo });

    const reasons = only(implementOf(state).handoffs).rejection!;
    expect(reasons.map((reason) => [reason.code, reason.pointer])).toEqual([
      ["capability_unsatisfiable", "/capabilities/0"],
      ["capability_unsatisfiable", "/capabilities/1"],
      ["capability_unsatisfiable", "/network"],
    ]);
  });

  // The levels are per operating system, so the same workflow is accepted on one and rejected on another. The system is
  // injected, so this runs the same on every runner.
  describe("by operating system", () => {
    const byOs = mockWith({
      capabilities: {
        read_only: sameOnEveryOs("cooperative"),
        write_scope: perOs("enforced_by_tool", "cooperative", "none"),
        no_external_actions: sameOnEveryOs("cooperative"),
      },
    });
    const step = { capabilities: [{ kind: "write_scope" as const, paths: ["greeting.txt"] }] };

    it.each([
      ["win32", "enforced_by_tool"],
      ["darwin", "cooperative"],
    ] as const)("applies write_scope at the level declared for %s", async (platform, level) => {
      const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

      const { state } = await executeRun(retryWorkflow([hello], step), { repo, adapters: new Map([["mock", byOs]]), platform });

      expect(state.state).toBe("succeeded");
      const applied = only(implementOf(state).attempts).capabilities!;
      expect(applied.platform).toBe(platform);
      expect(applied.capabilities[0]).toMatchObject({ kind: "write_scope", level });
    });

    it.each(["linux", "freebsd"])("rejects it on %s, where the adapter applies nothing (or AHP supports nothing)", async (platform) => {
      const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

      const { state } = await executeRun(retryWorkflow([hello], step), { repo, adapters: new Map([["mock", byOs]]), platform });

      expect(implementOf(state)).toMatchObject({ state: "failed", failureClass: "rejected", attempts: [] });
      const [reason] = only(implementOf(state).handoffs).rejection!;
      expect(reason).toMatchObject({ code: "capability_unsatisfiable", pointer: "/capabilities/0" });
      expect(reason!.message).toContain(`cannot apply write_scope on ${platform}`);
    });
  });

  it("checks a rerouted step's new handoff revision against the alternative adapter's declaration", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const primary = mockWith({ ...STRONG, name: "primary" });
    const backup = mockWith({ name: "backup" });
    const workflow: WorkflowDefinition = {
      name: "reroute",
      steps: [
        {
          id: "implement",
          agent: { adapter: "primary", options: { attempts: [failing] } },
          reroute: { adapter: "backup", options: { attempts: [{}, hello] } },
          verification: { command: "node verify.mjs" },
          retry: { budget: 0 },
          capabilities: [{ kind: "write_scope", paths: ["greeting.txt"], require: "enforced_by_tool" }],
        },
      ],
    };

    const { state } = await executeRun(workflow, {
      repo,
      adapters: new Map([["primary", primary], ["backup", backup]]),
      clock: fakeClock(),
    });

    const implement = implementOf(state);
    expect(implement).toMatchObject({ state: "failed", failureClass: "rejected" });
    // The first agent satisfied the request and ran; the alternative could not, so it never did.
    expect(implement.attempts.map((attempt) => attempt.adapter)).toEqual(["primary"]);
    const revision = implement.handoffs.at(-1)!;
    expect(revision).toMatchObject({ revision: 2, state: "rejected" });
    expect(revision.handoff.to.adapter).toBe("backup");
    expect(revision.rejection).toEqual([expect.objectContaining({ code: "capability_unsatisfiable", pointer: "/capabilities/0" })]);
    expect(revision.rejection![0]!.message).toContain('adapter "backup"');
  });

  it("validates a handoff document against the adapter it names, on a system the caller picks", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const step = { capabilities: [{ kind: "read_only" as const }] };
    const { state } = await runWorkflow(retryWorkflow([hello], step), { repo });
    const document = JSON.parse(JSON.stringify(only(implementOf(state).handoffs).handoff));

    expect((await validateHandoff(document, { repo })).accepted).toBe(true);
    const unknownAdapter = await validateHandoff({ ...document, to: { ...document.to, adapter: "nobody" } }, { repo });
    expect(unknownAdapter).toMatchObject({ accepted: false, reasons: [{ code: "unmet_dependency", pointer: "/to/adapter" }] });
    const unsupported = await validateHandoff(document, { repo, platform: "freebsd" });
    expect(unsupported).toMatchObject({ accepted: false, reasons: [{ code: "capability_unsatisfiable", pointer: "/capabilities/0" }] });
  });

  it("rejects a handoff document whose requests are malformed or contradict each other as schema_invalid", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const { state } = await runWorkflow(retryWorkflow([hello]), { repo });
    const document = JSON.parse(JSON.stringify(only(implementOf(state).handoffs).handoff));
    const rejectedWith = async (changes: Record<string, unknown>) => {
      const result = await validateHandoff({ ...document, ...changes }, { repo });
      expect(result.accepted).toBe(false);
      return !result.accepted ? result.reasons : [];
    };

    const unknownKind = await rejectedWith({ capabilities: [{ kind: "sudo", require: "none" }] });
    expect(unknownKind.map((r) => r.code)).toEqual(["schema_invalid"]);
    const noScope = await rejectedWith({ capabilities: [{ kind: "write_scope", paths: [], require: "none" }] });
    expect(noScope).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/capabilities/0/paths" })]);
    const twice = await rejectedWith({ capabilities: [{ kind: "read_only", require: "none" }, { kind: "read_only", require: "none" }] });
    expect(twice).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/capabilities/1" })]);
    const contradiction = await rejectedWith({
      capabilities: [{ kind: "read_only", require: "none" }, { kind: "write_scope", paths: ["src"], require: "none" }],
    });
    expect(contradiction).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/capabilities" })]);
    const noNetwork = await rejectedWith({ network: undefined });
    expect(noNetwork).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/network" })]);
    const badStance = await rejectedWith({ network: { stance: "allow", require: "none" } });
    expect(badStance).toEqual([expect.objectContaining({ code: "schema_invalid", pointer: "/network/stance" })]);
  });
});

describe("the model an attempt requested and the one its tool reported", () => {
  it("records both, as two different things", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const agent = { adapter: "mock", model: "model-a", options: { attempts: [{ ...hello, reportedModel: "model-b" }] } };

    const { runId, state } = await runWorkflow(retryWorkflow([], { agent }), { repo });

    const attempt = only(implementOf(state).attempts);
    expect(attempt).toMatchObject({ requestedModel: "model-a", reportedModel: "model-b" });
    expect(only(implementOf(state).handoffs).handoff.to.requestedModel).toBe("model-a");
    const exited = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_exited");
    expect(exited).toMatchObject({ reportedModel: "model-b" });
  });

  it("says `unknown` when the tool reported none, whatever was requested", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const agent = { adapter: "mock", model: "model-a", options: { attempts: [hello] } };

    const { runId, state } = await runWorkflow(retryWorkflow([], { agent }), { repo });

    expect(only(implementOf(state).attempts)).toMatchObject({ requestedModel: "model-a", reportedModel: "unknown" });
    const exited = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_exited");
    expect(exited).toMatchObject({ reportedModel: null });
  });

  it("does not take a blank model name for one", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const adapter = reporting({ reportedModel: "   " });

    const { state } = await executeRun(retryWorkflow([hello]), { repo, adapters: new Map([["mock", adapter]]) });

    expect(only(implementOf(state).attempts).reportedModel).toBe("unknown");
  });
});

/** The mock adapter, whose attempts end with `exit` merged into what they report, as a sloppy adapter might. */
function reporting(exit: Partial<AttemptExit>): Adapter {
  return {
    ...mockAdapter,
    async startAttempt(input) {
      const started = await mockAdapter.startAttempt(input);
      return { ...started, exited: started.exited.then((ended) => ({ ...ended, ...exit })) };
    },
  };
}

describe("usage", () => {
  it("is recorded as the tool reported it, with its source, and the numbers it did not report stay null", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const usage = { inputTokens: 1200, outputTokens: 300, cost: { amount: 0.02, currency: "USD" } };

    const { runId, state } = await runWorkflow(retryWorkflow([{ ...hello, usage }]), { repo });

    const expected = {
      source: MOCK_USAGE_SOURCE,
      inputTokens: 1200,
      outputTokens: 300,
      // Not reported, so not 1500 and not 0.
      totalTokens: null,
      cachedInputTokens: null,
      cost: { amount: 0.02, currency: "USD" },
    };
    expect(only(implementOf(state).attempts).usage).toEqual(expected);
    expect(MOCK_USAGE_SOURCE).toContain("not measured");
    const exited = (await readRunEvents({ repo, runId })).find((event) => event.type === "attempt_exited");
    expect(exited).toMatchObject({ usage: expected });
  });

  it("is null for an attempt whose tool reported none, and each attempt keeps only its own", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });

    const { state } = await runWorkflow(retryWorkflow([{ ...goodbye, usage: { totalTokens: 50 } }, hello]), { repo, clock: fakeClock() });

    expect(implementOf(state).attempts.map((attempt) => attempt.usage?.totalTokens ?? null)).toEqual([50, null]);
    expect(implementOf(state).attempts[1]!.usage).toBeNull();
  });

  it("is kept for a cancelled attempt when its adapter reported it: the cancel discards the agent's result, not what its tool measured", async () => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const controller = new AbortController();
    const usage = { source: "stream event", inputTokens: 7, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null };
    const adapter = reporting({ reportedModel: "model-b", usage });

    const { state } = await executeRun(retryWorkflow([{ ...hello, hang: true }]), {
      repo,
      adapters: new Map([["mock", adapter]]),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "attempt_running") controller.abort();
      },
    });

    expect(state.state).toBe("cancelled");
    expect(only(implementOf(state).attempts)).toMatchObject({ outcome: "cancelled", reportedOutput: {}, reportedModel: "model-b", usage });
  });

  it.each([
    ["no source", { source: "", inputTokens: 5, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null }],
    ["a negative count", { source: "x", inputTokens: -5, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null }],
    ["no number at all", { source: "x", inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null }],
    ["a count left undefined", { source: "x", inputTokens: 5 }],
  ])("is not recorded when the adapter's report has %s: it is not repaired or estimated", async (_, usage) => {
    const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING });
    const adapter = reporting({ usage: usage as never });

    const { state } = await executeRun(retryWorkflow([hello]), { repo, adapters: new Map([["mock", adapter]]) });

    expect(only(implementOf(state).attempts).usage).toBeNull();
  });
});

describe("enforcement levels", () => {
  it("rank enforced_by_tool above cooperative above none, and a level meets any weaker one", () => {
    const levels: EnforcementLevel[] = ["none", "cooperative", "enforced_by_tool"];
    for (const [achievedIndex, achieved] of levels.entries()) {
      for (const [requiredIndex, required] of levels.entries()) {
        expect(meetsLevel(achieved, required), `${achieved} against ${required}`).toBe(achievedIndex >= requiredIndex);
      }
    }
  });

  it("are read for the system a run is on, and are none on a system AHP does not support", () => {
    const levels = perOs("enforced_by_tool", "cooperative", "none");
    expect(["win32", "darwin", "linux", "freebsd", "aix", ""].map((platform) => levelOn(levels, platform))).toEqual([
      "enforced_by_tool",
      "cooperative",
      "none",
      "none",
      "none",
      "none",
    ]);
  });
});

describe("what counts as usage a tool reported", () => {
  const usage = { source: "stream event", inputTokens: 1, outputTokens: null, totalTokens: null, cachedInputTokens: null, cost: null };

  it.each([
    ["counts with a source", usage, true],
    ["a cost alone", { ...usage, inputTokens: null, cost: { amount: 0, currency: "USD" } }, true],
    ["zero tokens, which a tool may report", { ...usage, inputTokens: 0 }, true],
    ["a blank source", { ...usage, source: "  " }, false],
    ["a missing source", { ...usage, source: undefined }, false],
    ["a negative count", { ...usage, outputTokens: -1 }, false],
    ["a count that is not finite", { ...usage, totalTokens: Number.POSITIVE_INFINITY }, false],
    ["a count that is text", { ...usage, inputTokens: "1" }, false],
    ["nothing reported", { ...usage, inputTokens: null }, false],
    ["a cost without a currency", { ...usage, cost: { amount: 1, currency: "" } }, false],
    ["no report", null, false],
  ])("%s", (_, candidate, valid) => {
    expect(isUsageReport(candidate)).toBe(valid);
  });
});

describe("workflow validation of capabilities and network", () => {
  const step = (extra: Record<string, unknown>) => ({
    id: "implement",
    agent: { adapter: "mock", options: { attempts: [{}] } },
    verification: { requiredOutputFields: ["summary"] },
    ...extra,
  });
  const problemsOf = (extra: Record<string, unknown>) => validateWorkflow({ name: "w", steps: [step(extra)] });

  it("accepts every kind, with and without a required level, and every stance", () => {
    expect(
      problemsOf({
        capabilities: [
          { kind: "read_only" },
          { kind: "no_external_actions", require: "enforced_by_tool" },
        ],
        network: { stance: "package_registries", require: "cooperative" },
      }),
    ).toEqual([]);
    expect(problemsOf({ capabilities: [{ kind: "write_scope", paths: ["src", "docs/a.md"], require: "none" }], network: { stance: "deny" } })).toEqual([]);
    expect(problemsOf({ capabilities: [] })).toEqual([]);
  });

  it.each([
    ["capabilities that are not a list", { capabilities: { kind: "read_only" } }, "`capabilities` must be an array"],
    ["a request that is not an object", { capabilities: ["read_only"] }, "`capabilities[0]` must be an object"],
    ["an unknown kind", { capabilities: [{ kind: "sudo" }] }, "`capabilities[0].kind` must be one of read_only, write_scope, no_external_actions"],
    ["a property its kind does not take", { capabilities: [{ kind: "read_only", paths: ["a"] }] }, "unknown property `capabilities[0].paths` for read_only"],
    ["an unknown level", { capabilities: [{ kind: "read_only", require: "strict" }] }, "`capabilities[0].require` must be one of enforced_by_tool, cooperative, none"],
    ["a kind twice", { capabilities: [{ kind: "read_only" }, { kind: "read_only" }] }, "`capabilities[1]` requests read_only a second time"],
    ["a write scope without paths", { capabilities: [{ kind: "write_scope" }] }, "`capabilities[0].paths` must list"],
    ["a write scope with no paths", { capabilities: [{ kind: "write_scope", paths: [] }] }, "`capabilities[0].paths` must list"],
    ["a write scope path outside the repository", { capabilities: [{ kind: "write_scope", paths: ["../x"] }] }, 'write scope path "../x" must be relative'],
    ["a write scope path twice", { capabilities: [{ kind: "write_scope", paths: ["a", "a"] }] }, 'write scope path "a" is listed twice'],
    [
      "a read-only step with a write scope",
      { capabilities: [{ kind: "read_only" }, { kind: "write_scope", paths: ["a"] }] },
      "`read_only` and `write_scope` contradict each other",
    ],
    ["a network that is not an object", { network: "deny" }, "`network` must be an object with a `stance`"],
    ["an unknown stance", { network: { stance: "allow" } }, "`network.stance` must be one of deny, package_registries"],
    ["no stance", { network: {} }, "`network.stance` must be one of"],
    ["a property the stance does not take", { network: { stance: "deny", hosts: ["a"] } }, "unknown property `network.hosts`"],
    ["an unknown network level", { network: { stance: "deny", require: "strict" } }, "`network.require` must be one of"],
  ])("rejects %s", (_, extra, message) => {
    const problems = problemsOf(extra);
    expect(problems.some((problem) => problem.includes(message)), problems.join("\n")).toBe(true);
  });

  it("refuses them on an approval gate and an external action, which have no coding agent", () => {
    const gate = { id: "approve", approval: {}, network: { stance: "deny" } };
    const action = { id: "push", action: { kind: "push_branch", branch: "work" }, capabilities: [{ kind: "read_only" }] };

    const problems = validateWorkflow({ name: "w", steps: [step({}), gate, action] });

    expect(problems).toEqual([
      'step "approve": an approval gate has no coding agent and nothing to verify, so it takes no `network`',
      'step "push": an external action is performed by AHP, with no coding agent and nothing to verify, so it takes no `capabilities`',
    ]);
  });
});
