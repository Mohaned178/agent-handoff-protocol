import { afterEach, describe, expect, it } from "vitest";
import { mock } from "../src/index.ts";
import { formatReport, recordToolVersions, reportOf, validateSuite, versionNumberOf } from "../src/evaluation/index.ts";
import { evaluate, GREETS, greetingTaskDir, scripted, suiteOf } from "./helpers/evaluation.ts";
import { fakeToolsDir, installFakeToolScript, pathWithFakes } from "./helpers/fake-tools.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const LOSES_CONTACT = { ...GREETS, loseContact: true };
const COSTS_HALF = { ...GREETS, usage: { inputTokens: 10, outputTokens: 2, cost: { amount: 0.5, currency: "USD" } } };

describe("the spend cap", () => {
  it("starts no trial once the cost the tools reported has reached the cap, and says so", async () => {
    const suite = suiteOf([greetingTaskDir()], { implement: scripted(COSTS_HALF) }, { conditions: ["C0"], repeats: 4, spendCap: { amount: 1, currency: "USD" } });

    const { state, report, events } = await evaluate(suite);

    // 0.5 after the first trial, 1 after the second: the cap is reached, so the third never starts.
    expect(state.trials).toHaveLength(2);
    expect(state.state).toBe("stopped");
    expect(state.reason).toMatch(/^spend_cap: .*1 USD.* cap of 1/);
    expect(state.pending).toHaveLength(2);
    expect(events.filter((event) => event.type === "spend_observed").map((event) => (event as { amount: number }).amount)).toEqual([0.5, 1]);
    expect(report.spend).toEqual({ cap: { amount: 1, currency: "USD" }, reported: 1, attemptsWithoutCost: 0, capReached: true });
    expect(formatReport(report)).toContain("Reported spend: 1 USD of a cap of 1, reached: no further trial was started");
    expect(formatReport(report)).toContain("provider's console");
  });

  it("runs every trial when the cap is not reached, and counts the attempts that reported no cost in its currency as unknown, not zero", async () => {
    const euro = { ...GREETS, usage: { inputTokens: 1, cost: { amount: 100, currency: "EUR" } } };
    const implement = (_task: unknown, slot: { repeat: number }) => scripted(slot.repeat === 1 ? COSTS_HALF : slot.repeat === 2 ? euro : GREETS)();

    const { state, report } = await evaluate(suiteOf([greetingTaskDir()], { implement }, { conditions: ["C0"], repeats: 3, spendCap: { amount: 5, currency: "USD" } }));

    expect(state.state).toBe("completed");
    expect(state.trials).toHaveLength(3);
    // Another currency's cost is not converted or added; the attempt that reported none and the one in euros are both unknown in USD.
    expect(report.spend).toEqual({ cap: { amount: 5, currency: "USD" }, reported: 0.5, attemptsWithoutCost: 2, capReached: false });
  });

  it("records no spend for a suite without a cap", async () => {
    const { types, report } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(COSTS_HALF) }, { conditions: ["C0"] }));

    expect(types).not.toContain("spend_observed");
    expect(report.spend).toBeNull();
  });

  it("rejects a cap that is not a positive amount in a named currency", () => {
    for (const spendCap of [{ amount: 0, currency: "USD" }, { amount: 1 }, { amount: "5", currency: "USD" }, { amount: 1, currency: "" }]) {
      expect(validateSuite(suiteOf(["t"], { implement: scripted(GREETS) }, { conditions: ["C0"], spendCap } as never))).toEqual([expect.stringContaining("`spendCap` must be")]);
    }
  });
});

describe("invalid cells", () => {
  /** Task `flaky`'s agent loses contact, so its attempt is unknown: a harness incident. */
  const agent = (task: { id: string }) => mock({ attempts: [task.id === "flaky" ? LOSES_CONTACT : GREETS] });

  it("leaves a cell whose incident rate is over the threshold out of the rates, and names it", async () => {
    const tasks = [greetingTaskDir(), greetingTaskDir({ id: "flaky" })];

    const { report } = await evaluate(suiteOf(tasks, { implement: agent }, { conditions: ["C0"], repeats: 2, maxIncidentRate: 0.5 }));

    const c0 = report.conditions[0]!;
    expect(c0.invalidCells).toEqual([{ taskId: "flaky", incidents: 2, trials: 2, leftOut: 0 }]);
    expect(c0.harnessIncidents.count).toBe(2);
    expect(c0.scored).toBe(2);
    expect(formatReport(report)).toContain("INVALID CELL flaky: 2 of 2 ended trials were harness incidents");
  });

  it("does not mark a cell whose incident rate is at the threshold, nor any when no threshold is set", async () => {
    const tasks = [greetingTaskDir(), greetingTaskDir({ id: "flaky" })];

    const atThreshold = await evaluate(suiteOf(tasks, { implement: agent }, { conditions: ["C0"], maxIncidentRate: 1 }));
    const unset = await evaluate(suiteOf(tasks, { implement: agent }, { conditions: ["C0"] }));

    expect(atThreshold.report.conditions[0]!.invalidCells).toEqual([]);
    expect(unset.report.conditions[0]!.invalidCells).toEqual([]);
    expect(unset.report.conditions[0]!.harnessIncidents.count).toBe(1);
  });

  it("takes a scored trial out of the rate when its cell is invalid", async () => {
    // One pass and two incidents on the same task: 2 of 3 over a threshold of 0.5, so the pass is left out of the rate too.
    const implement = (_task: unknown, slot: { repeat: number }) => mock({ attempts: [slot.repeat === 1 ? GREETS : LOSES_CONTACT] });

    const { report } = await evaluate(suiteOf([greetingTaskDir()], { implement }, { conditions: ["C0"], repeats: 3, maxIncidentRate: 0.5 }));

    const c0 = report.conditions[0]!;
    expect(c0.invalidCells).toEqual([{ taskId: "greeting", incidents: 2, trials: 3, leftOut: 1 }]);
    expect({ scored: c0.scored, passes: c0.passes, successRate: c0.successRate }).toEqual({ scored: 0, passes: 0, successRate: null });
  });

  it("rejects a threshold outside 0 to 1", () => {
    for (const maxIncidentRate of [-0.1, 1.5, "half"]) {
      expect(validateSuite(suiteOf(["t"], { implement: scripted(GREETS) }, { conditions: ["C0"], maxIncidentRate } as never))).toEqual([expect.stringContaining("`maxIncidentRate`")]);
    }
  });
});

describe("the network stance", () => {
  it("is the task's own under every condition, so a suite of a task that sets one is accepted", async () => {
    const agents = { plan: scripted(GREETS), implement: scripted(GREETS), review: scripted(GREETS) };
    const { state } = await evaluate(suiteOf([greetingTaskDir({ network: { stance: "package_registries" } })], agents, { conditions: ["C0", "C1", "C2", "C3"] }));

    // Nothing was rejected before the trials; none of the scripts here is meant to pass.
    expect(state.trials.length).toBeGreaterThan(0);
  });
});

describe("tool versions", () => {
  it("reads a version number out of the tool's version line", () => {
    expect(versionNumberOf("2.1.311 (Claude Code)")).toBe("2.1.311");
    expect(versionNumberOf("codex-cli 0.146.0")).toBe("0.146.0");
    expect(versionNumberOf("no number here")).toBe("no number here");
  });

  it("rejects a pin for an unknown tool or one that is not a version", () => {
    const problems = validateSuite(suiteOf(["t"], { implement: scripted(GREETS) }, { conditions: ["C0"], toolVersions: { vim: "9.0.1", codex: "latest" } } as never));
    expect(problems).toEqual([expect.stringContaining("unknown tool `toolVersions.vim`"), expect.stringContaining("`toolVersions.codex` must be a version number")]);
  });

  async function codexPrinting(line: string) {
    const { dir } = fakeToolsDir();
    installFakeToolScript(dir, "codex", `console.log(${JSON.stringify(line)});\n`);
    return pathWithFakes(dir);
  }
  const workflow = { name: "w", steps: [{ id: "s", agent: { adapter: "codex" } }] } as never;

  it("records what each tool a workflow uses prints, against the pin", async () => {
    const env = await codexPrinting("codex-cli 0.146.0");

    expect(await recordToolVersions(workflow, { codex: "0.146.0" }, env)).toEqual([{ tool: "codex", pinned: "0.146.0", found: "0.146.0", matches: true, problem: null }]);
    expect(await recordToolVersions(workflow, { codex: "0.145.0" }, env)).toEqual([{ tool: "codex", pinned: "0.145.0", found: "0.146.0", matches: false, problem: null }]);
    expect(await recordToolVersions(workflow, undefined, env)).toEqual([{ tool: "codex", pinned: null, found: "0.146.0", matches: null, problem: null }]);
  });

  it("records a tool that cannot be run as not matching its pin, with the reason", async () => {
    const { dir } = fakeToolsDir();

    const [record] = await recordToolVersions(workflow, { codex: "0.146.0" }, await pathWithFakes(dir));

    expect(record).toMatchObject({ tool: "codex", pinned: "0.146.0", found: null, matches: false });
    expect(record!.problem).toEqual(expect.any(String));
  });

  it("records nothing for the mock, which is no tool", async () => {
    const { state } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"], toolVersions: { codex: "0.146.0" } }));

    expect(state.trials[0]!.tools).toEqual([]);
    expect(state.safeguards.toolVersions).toEqual({ codex: "0.146.0" });
  });

  it("reports the versions found across trials and the trials that do not match the pin", async () => {
    const { state } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"], repeats: 2 }));
    const found = (version: string, pinned: string) => [{ tool: "codex", pinned, found: version, matches: version === pinned, problem: null }];
    state.trials[0]!.tools = found("0.146.0", "0.146.0");
    state.trials[1]!.tools = found("0.147.0", "0.146.0");

    const report = reportOf(state);

    expect(report.tools).toEqual([{ tool: "codex", pinned: "0.146.0", found: [{ version: "0.146.0", trials: 1 }, { version: "0.147.0", trials: 1 }], mismatchedTrials: 1 }]);
    expect(formatReport(report)).toContain("Tool codex: 0.146.0 (1 trial), 0.147.0 (1 trial); PINNED 0.146.0, MISMATCH in 1 trial");
  });
});
