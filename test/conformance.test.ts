import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterDeclaration, AttemptExit, AttemptInput, StartedAttempt } from "../src/adapters/index.ts";
import { mockAdapter } from "../src/adapters/mock/index.ts";
import { mockSubject } from "../src/adapters/mock/conformance.ts";
import {
  ConformanceRefusedError,
  outcomeOf,
  runConformance,
  type CheckResult,
  type ConformanceOptions,
  type ConformanceResult,
  type ConformanceSubject,
} from "../src/conformance/index.ts";
import { sameOnEveryOs, type EnforcementLevel } from "../src/protocol/index.ts";
import { cleanupConformance, leaveRunning } from "./helpers/conformance.ts";

afterEach(cleanupConformance);

const CAPABILITY_CHECKS = ["capability:read_only", "capability:write_scope", "capability:no_external_actions", "network:deny", "network:package_registries"];

const check = (result: ConformanceResult, id: string): CheckResult => {
  const found = result.checks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no check "${id}" in: ${result.checks.map((c) => c.id).join(", ")}`);
  return found;
};

const statuses = (result: ConformanceResult) => Object.fromEntries(result.checks.map((c) => [c.id, c.status]));

/** The mock under another static declaration and/or a change to what its agent does, as a different adapter would. */
function adapterBased(
  declaration: Partial<AdapterDeclaration>,
  behaviour: {
    input?: (input: AttemptInput) => AttemptInput;
    started?: (started: StartedAttempt, input: AttemptInput) => StartedAttempt;
    exit?: (exit: AttemptExit, input: AttemptInput) => AttemptExit;
  } = {},
): Adapter {
  const adapter: Adapter = {
    ...mockAdapter,
    declaration: { ...mockAdapter.declaration, ...declaration },
    async startAttempt(input) {
      const given = behaviour.input?.(input) ?? input;
      const started = await mockAdapter.startAttempt.call(this, given);
      const changed = { ...started, exited: started.exited.then((exit) => behaviour.exit?.(exit, given) ?? exit) };
      return behaviour.started?.(changed, given) ?? changed;
    },
  };
  return adapter;
}

const subjectFor = (adapter: Adapter): ConformanceSubject => ({ ...mockSubject(), adapter });

/** A run of the checks under test only: the whole suite starts dozens of processes, which is slow on Windows. */
const runOnly = (subject: ConformanceSubject, only: string[], options: ConformanceOptions = {}) => runConformance(subject, { ...options, only });

const everyLevel = (level: EnforcementLevel): Partial<AdapterDeclaration> => ({
  capabilities: { read_only: sameOnEveryOs(level), write_scope: sameOnEveryOs(level), no_external_actions: sameOnEveryOs(level) },
  network: { deny: sameOnEveryOs(level), package_registries: sameOnEveryOs(level) },
});

/** What a mock agent is allowed to do under the capabilities applied: an adapter that really enforces them removes the rest. */
function enforcing(input: AttemptInput): AttemptInput {
  const asked = (kind: string) => input.capabilities.capabilities.some((c) => c.kind === kind && c.level === "enforced_by_tool");
  const options = input.options as { attempts: Record<string, unknown>[] };
  const scope = input.capabilities.capabilities.find((c) => c.kind === "write_scope");
  const attempts = options.attempts.map((script) => {
    const kept = { ...script } as Record<string, unknown> & { edits?: { path: string }[] };
    if (asked("read_only")) delete kept.edits;
    if (scope && scope.kind === "write_scope" && asked("write_scope")) {
      kept.edits = kept.edits?.filter((edit) => scope.paths.some((path) => edit.path.startsWith(`${path}/`)));
    }
    if (asked("no_external_actions")) delete kept.git;
    if (input.capabilities.network.level === "enforced_by_tool") delete kept.fetchUrl;
    return kept;
  });
  return { ...input, options: { attempts } };
}

describe("the conformance suite against the mock adapter", () => {
  // A full run starts dozens of processes (about 11 s alone on Windows), so under the whole suite's parallel load it can pass 60 s.
  it("passes every check it can make and labels the result as the mock's", { timeout: 180_000 }, async () => {
    const result = await runConformance(mockSubject(), { clock: { now: () => new Date("2026-10-27T12:00:00Z") } });

    expect(statuses(result)).toEqual({
      "declaration:complete": "passed",
      spawn_and_exit: "passed",
      "failure:agent_error": "passed",
      "failure:config_auth": "passed",
      "failure:transient": "passed",
      "model:reported": "passed",
      "model:not_reported": "passed",
      "usage:reported": "passed",
      "usage:not_reported": "passed",
      "cancel:stops_agent": "passed",
      "cancel:forced_tree": "passed",
      // The mock declares `cooperative`: the attempt accepts the request, and nothing is claimed beyond that.
      "capability:read_only": "passed",
      "capability:write_scope": "passed",
      "capability:no_external_actions": "passed",
      // and `none` for the network: nothing to check.
      "network:deny": "not_applicable",
      "network:package_registries": "not_applicable",
      "declaration:refuses_above_declared": "passed",
    });
    expect(check(result, "capability:read_only").detail).toContain("not enforcement");
    expect(result).toMatchObject({ adapter: "mock", mock: true, toolVersion: "n/a (mock)", ranAt: "2026-10-27T12:00:00.000Z", platform: process.platform });
    expect(outcomeOf(result)).toBe("passed");
  });

  it("skips what its subject cannot provoke, so the result is untested rather than passed", async () => {
    const { completes: _completes, ...rest } = mockSubject().provokers;

    const result = await runOnly({ ...mockSubject(), provokers: rest }, ["spawn_and_exit", "model:reported"]);

    expect(check(result, "spawn_and_exit")).toMatchObject({ status: "skipped", detail: expect.stringContaining("completes") });
    expect(check(result, "model:reported").status).toBe("passed");
    expect(outcomeOf(result)).toBe("untested");
  });

  it("refuses to run a real adapter in CI, and one it has no tool version for", async () => {
    const real = subjectFor(adapterBased({ name: "real", mock: false }));

    await expect(runOnly(real, [], { env: { CI: "true" }, toolVersion: "1.2.3" })).rejects.toThrow(ConformanceRefusedError);
    await expect(runOnly(real, [], { env: {} })).rejects.toThrow(/no tool version/);
    // The mock drives no tool and runs in CI.
    await expect(runOnly(mockSubject(), [], { env: { CI: "true" } })).resolves.toMatchObject({ mock: true });
  });

  it("records the tool version it is given for a real adapter", async () => {
    const real: ConformanceSubject = { ...subjectFor(adapterBased({ name: "real", mock: false })), toolVersion: async () => "9.9.9" };

    expect(await runOnly(real, [], { env: {} })).toMatchObject({ adapter: "real", mock: false, toolVersion: "9.9.9" });
    expect(await runOnly(real, [], { env: {}, toolVersion: "1.0.0" })).toMatchObject({ toolVersion: "1.0.0" });
  });
});

describe("the conformance suite finds an adapter that does not hold to its contract", () => {
  it("fails an incomplete declaration", async () => {
    const result = await runOnly(subjectFor(adapterBased({ network: undefined } as unknown as Partial<AdapterDeclaration>)), ["declaration:complete"]);

    expect(check(result, "declaration:complete")).toMatchObject({ status: "failed", detail: expect.stringContaining("network stance deny") });
  });

  it("fails a reported model filled in from the request", async () => {
    const echoing = adapterBased({}, { exit: (exit, input) => ({ ...exit, reportedModel: exit.reportedModel ?? input.requestedModel }) });

    const result = await runOnly(subjectFor(echoing), ["model:reported", "model:not_reported"]);

    expect(check(result, "model:not_reported")).toMatchObject({ status: "failed", detail: expect.stringContaining("never filled in from the request") });
    expect(check(result, "model:reported").status).toBe("passed");
  });

  it("does not take a model equal to the request for a report when the tool cannot be made to say another", async () => {
    const echoing = adapterBased({}, { exit: (exit, input) => ({ ...exit, reportedModel: input.requestedModel }) });
    const { told: _told, ...provoked } = mockSubject().provokers.reports_model!({} as never);
    const subject: ConformanceSubject = { ...subjectFor(echoing), provokers: { ...mockSubject().provokers, reports_model: () => provoked } };

    const result = await runOnly(subject, ["model:reported"]);

    expect(check(result, "model:reported")).toMatchObject({ status: "skipped", detail: expect.stringContaining("echo") });
  });

  it("fails usage without a source, usage with a 0 for a number the tool did not give, and usage the tool did not report", async () => {
    const sourceless = adapterBased({}, { exit: (exit) => ({ ...exit, usage: exit.usage && { ...exit.usage, source: "" } }) });
    const zeros = adapterBased({}, {
      exit: (exit) => ({ ...exit, usage: exit.usage && { ...exit.usage, totalTokens: exit.usage.totalTokens ?? 0 } }),
    });
    const estimating = adapterBased({}, {
      exit: (exit) => ({ ...exit, usage: exit.usage ?? { source: "estimate", inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: null, cost: null } }),
    });

    expect(check(await runOnly(subjectFor(sourceless), ["usage:reported"]), "usage:reported").status).toBe("failed");
    expect(check(await runOnly(subjectFor(zeros), ["usage:reported"]), "usage:reported")).toMatchObject({ status: "failed", detail: expect.stringContaining("totalTokens") });
    expect(check(await runOnly(subjectFor(estimating), ["usage:not_reported"]), "usage:not_reported").status).toBe("failed");
  });

  it("fails a login problem that is not classified as one", async () => {
    const lax = adapterBased({}, { exit: (exit) => ({ ...exit, error: null }) });

    const result = await runOnly(subjectFor(lax), ["failure:config_auth", "failure:transient"]);

    expect(check(result, "failure:config_auth")).toMatchObject({ status: "failed", detail: expect.stringContaining('"agent_error"') });
    expect(check(result, "failure:transient").status).toBe("failed");
  });

  it("fails a cancel that reports the tree stopped while its processes still run", async () => {
    // Says it stopped everything and stops nothing.
    const lying = adapterBased({}, {
      started: (started) => ({ ...started, cancel: async () => ({ outcome: "stopped", forced: true, via: "tree_kill" }) }),
    });
    const subject = subjectFor(lying);
    const resists = subject.provokers.resists_cancel!;
    // Tell the test which processes to kill afterwards, whatever the check found.
    subject.provokers.resists_cancel = (context) => {
      const timer = setInterval(() => {
        try {
          leaveRunning(...readFileSync(context.pidFile, "utf8").split("\n").filter(Boolean).map(Number));
          clearInterval(timer);
        } catch {
          // not written yet
        }
      }, 50);
      return resists(context);
    };

    const result = await runOnly(subject, ["cancel:forced_tree"]);

    expect(check(result, "cancel:forced_tree")).toMatchObject({ status: "failed", detail: expect.stringContaining("still running") });
  });

  /** An adapter with a transport cancel of its own; `clears` says whether that cancel really takes the agent's whole tree with it. */
  function transportCancel(clears: boolean): ConformanceSubject {
    const adapter = adapterBased(
      { gracefulCancel: true },
      {
        started: (started, input) => ({
          ...started,
          cancel: async () => {
            const { pidFile } = (input.options as { attempts: { pidFile: string }[] }).attempts[0]!;
            const pids = [...new Set([started.pid, ...readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number)])];
            if (!clears) leaveRunning(...pids);
            else {
              for (const pid of pids) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  // already gone
                }
              }
            }
            return { outcome: "stopped", forced: false, via: "transport" };
          },
        }),
      },
    );
    return subjectFor(adapter);
  }

  it("takes a transport cancel that clears a tree of processes that ignore signals as it is: forcing is for what the transport leaves", async () => {
    const result = await runOnly(transportCancel(true), ["cancel:forced_tree"]);

    expect(check(result, "cancel:forced_tree")).toMatchObject({ status: "passed", detail: expect.stringContaining("transport") });
  });

  it("fails a transport cancel that says it stopped everything unforced while the tree still runs", async () => {
    const result = await runOnly(transportCancel(false), ["cancel:forced_tree"]);

    expect(check(result, "cancel:forced_tree")).toMatchObject({ status: "failed", detail: expect.stringContaining("still running") });
  });

  it("still demands a forced tree kill of an adapter with no transport cancel", async () => {
    const lax = adapterBased({}, { started: (started) => ({ ...started, cancel: async () => ({ outcome: "stopped", forced: false, via: "signal" }) }) });

    const result = await runOnly(subjectFor(lax), ["cancel:forced_tree"]);

    expect(check(result, "cancel:forced_tree")).toMatchObject({ status: "failed", detail: expect.stringContaining("can only be stopped by a tree kill") });
  });

  it("fails a cancel that does not go the way the declaration says", async () => {
    const result = await runOnly(subjectFor(adapterBased({ gracefulCancel: true })), ["cancel:stops_agent"]);

    // Declared a transport cancel, but this adapter signals the process.
    expect(check(result, "cancel:stops_agent")).toMatchObject({ status: "failed", detail: expect.stringContaining("transport") });
  });

  it("fails capabilities declared enforced_by_tool that the agent can break", async () => {
    const liar = adapterBased(everyLevel("enforced_by_tool"));

    const result = await runOnly(subjectFor(liar), CAPABILITY_CHECKS);

    expect(check(result, "capability:read_only")).toMatchObject({ status: "failed", detail: expect.stringContaining("probe.txt") });
    expect(check(result, "capability:write_scope")).toMatchObject({ status: "failed", detail: expect.stringContaining("outside/probe.txt") });
    expect(check(result, "capability:no_external_actions")).toMatchObject({ status: "failed", detail: expect.stringContaining("shared ref") });
    expect(check(result, "network:deny")).toMatchObject({ status: "failed", detail: expect.stringContaining("reached") });
    expect(check(result, "network:package_registries").status).toBe("failed");
    expect(outcomeOf(result)).toBe("failed");
  });

  it("does not take a probe that breaks nothing for enforcement", async () => {
    // Declares `enforced_by_tool`, but the agent never does anything: nothing shows that anything is enforced.
    const idle = adapterBased(everyLevel("enforced_by_tool"), { input: (input) => ({ ...input, options: { attempts: [{}] } }) });

    const result = await runOnly(subjectFor(idle), CAPABILITY_CHECKS);

    for (const id of CAPABILITY_CHECKS) expect(check(result, id), id).toMatchObject({ status: "skipped", detail: expect.stringContaining("broke nothing") });
    expect(outcomeOf(result)).toBe("untested");
  });

  it("passes capabilities declared enforced_by_tool that the agent cannot break", async () => {
    const honest = adapterBased(everyLevel("enforced_by_tool"), { input: enforcing });

    const result = await runOnly(subjectFor(honest), [...CAPABILITY_CHECKS, "declaration:refuses_above_declared"]);

    for (const id of ["capability:read_only", "capability:write_scope", "capability:no_external_actions", "network:deny", "network:package_registries"]) {
      expect(check(result, id).status, id).toBe("passed");
    }
    expect(check(result, "declaration:refuses_above_declared").status).toBe("not_applicable");
  });

  it("fails an adapter that applies a capability above the level it declares", async () => {
    const permissive = adapterBased({}, { input: (input) => input });
    permissive.startAttempt = (input) => mockAdapter.startAttempt.call({ ...permissive, declaration: { ...mockAdapter.declaration, ...everyLevel("enforced_by_tool") } }, input);

    const result = await runOnly(subjectFor(permissive), ["declaration:refuses_above_declared"]);

    expect(check(result, "declaration:refuses_above_declared")).toMatchObject({ status: "failed", detail: expect.stringContaining("read_only") });
  });

  it("checks the levels declared for the system it is told to check", async () => {
    // Enforced on macOS only: on Linux and Windows the suite finds nothing to enforce, and on macOS it finds the lie.
    const macOnly = adapterBased({
      capabilities: {
        read_only: { win32: "cooperative", darwin: "enforced_by_tool", linux: "cooperative" },
        write_scope: sameOnEveryOs("none"),
        no_external_actions: sameOnEveryOs("none"),
      },
    });

    const elsewhere = await runOnly(subjectFor(macOnly), CAPABILITY_CHECKS, { platform: "linux" });
    const onMac = await runOnly(subjectFor(macOnly), CAPABILITY_CHECKS, { platform: "darwin" });

    expect(check(elsewhere, "capability:read_only").status).toBe("passed");
    expect(check(elsewhere, "capability:write_scope").status).toBe("not_applicable");
    expect(check(onMac, "capability:read_only").status).toBe("failed");
  });

  it("records a scenario the subject declares its tool cannot do as unprovokable, and one it merely lacks a provoker for as skipped", async () => {
    const { rate_limited, no_usage_report, ...rest } = mockSubject().provokers;
    const result = await runOnly({ ...mockSubject(), provokers: rest, unprovokable: ["rate_limited"] }, ["failure:transient", "usage:not_reported"]);

    expect(check(result, "failure:transient").status).toBe("unprovokable");
    expect(check(result, "usage:not_reported").status).toBe("skipped");
  });
});
