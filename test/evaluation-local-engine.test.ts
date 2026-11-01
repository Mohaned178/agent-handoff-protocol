import { afterEach, describe, expect, it } from "vitest";
import { opencode } from "../src/index.ts";
import { formatReport, localTargetsOf, recordToolVersions, reportOf, type EvaluationEvent } from "../src/evaluation/index.ts";
import { evaluate, greetingTaskDir, suiteOf } from "./helpers/evaluation.ts";
import { closedBaseURL, startFakeEngine, type FakeEngine } from "./helpers/fake-engine.ts";
import { completingScenario, installFakeOpencode } from "./helpers/opencode.ts";
import { removeTempRepos } from "./helpers/repo.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeTempRepos();
});

async function engine(models = ["fake-model"]): Promise<FakeEngine> {
  const started = await startFakeEngine({ models, version: { path: "/version", version: "0.32.0" }, chat: () => ({ status: 500, body: "the evaluation never chats" }) });
  cleanups.push(started.close);
  return started;
}

function fakeOpencode() {
  const fake = installFakeOpencode(completingScenario());
  cleanups.push(fake.restore);
  return fake;
}

const workflowOn = (...agents: unknown[]) => ({ name: "w", steps: agents.map((agent, i) => ({ id: `s${i}`, agent })) }) as never;

describe("the local engines a workflow reaches", () => {
  it("are each engine, URL and model its OpenCode steps name, once, leaving out a step whose model the endpoint does not list", () => {
    const vllm = { engine: "vllm" as const, baseURL: "http://localhost:8001/v1", models: ["a", "b"] };
    const workflow = workflowOn(opencode({ localEndpoint: vllm }), opencode({ localEndpoint: vllm, model: "a" }), opencode({ localEndpoint: vllm, model: "b" }), { adapter: "opencode", model: "opencode/x", options: { localEndpoint: vllm } }, opencode({ model: "opencode/y" }), { adapter: "codex" });

    expect(localTargetsOf(workflow, "opencode")).toEqual([
      { engine: "vllm", baseURL: "http://localhost:8001/v1", model: "a" },
      { engine: "vllm", baseURL: "http://localhost:8001/v1", model: "b" },
    ]);
    expect(localTargetsOf(workflow, "codex")).toEqual([]);
  });
});

describe("the engine recorded beside a tool's version", () => {
  it("is checked as the bench checks one: available with the version it says, or unavailable with the error", async () => {
    fakeOpencode();
    const served = await engine();
    const down = await closedBaseURL();
    const workflow = workflowOn(opencode({ localEndpoint: { engine: "vllm", baseURL: served.baseURL, models: ["fake-model"] } }), opencode({ localEndpoint: { engine: "sglang", baseURL: down, models: ["m"] } }));

    const [record] = await recordToolVersions(workflow, undefined, process.env);

    expect(record!.tool).toBe("opencode");
    expect(record!.engines).toEqual([
      { engine: "vllm", name: "vLLM", baseURL: served.baseURL, model: "fake-model", available: true, version: "0.32.0", error: null },
      { engine: "sglang", name: "SGLang", baseURL: down, model: "m", available: false, version: null, error: expect.stringContaining(`GET ${down}/models`) },
    ]);
  });

  it("is unavailable when the engine does not list the model the step requests", async () => {
    fakeOpencode();
    const served = await engine(["other-model"]);

    const [record] = await recordToolVersions(workflowOn(opencode({ localEndpoint: { engine: "ollama", baseURL: served.baseURL, models: ["fake-model"] } })), undefined, process.env);

    expect(record!.engines).toEqual([expect.objectContaining({ available: false, error: "the engine does not list the model fake-model (it lists: other-model)" })]);
  });
});

describe("a trial on a local engine", () => {
  it("records the engine in trial_started and runs OpenCode with the engine as its provider", async () => {
    const fake = fakeOpencode();
    const served = await engine();
    const localEndpoint = { engine: "vllm" as const, baseURL: served.baseURL, models: ["fake-model"] };

    const { state, events } = await evaluate(suiteOf([greetingTaskDir()], { implement: opencode({ localEndpoint }) }, { conditions: ["C0"] }));

    const started = events.find((event): event is Extract<EvaluationEvent, { type: "trial_started" }> => event.type === "trial_started")!;
    expect(started.tools[0]!.engines).toEqual([{ engine: "vllm", name: "vLLM", baseURL: served.baseURL, model: "fake-model", available: true, version: "0.32.0", error: null }]);
    expect(state.trials[0]!.tools[0]!.engines).toEqual(started.tools[0]!.engines);
    const acp = fake.acp();
    expect(JSON.parse(acp.env.OPENCODE_CONFIG_CONTENT!).provider["ahp-local"].options).toEqual({ baseURL: served.baseURL });
    expect(acp.received.find((message) => message.method === "session/set_config_option")).toMatchObject({ params: { value: "ahp-local/fake-model" } });
    // The fake reports no summary, so the trial is scored, and fails: what matters here is that it ran.
    expect(state.trials[0]!.ended!.outcome).toBe("scored");
  });

  it("is not scored, and starts no agent, when its engine does not serve the model; the report names the engine", async () => {
    const fake = fakeOpencode();
    const down = await closedBaseURL();
    const localEndpoint = { engine: "sglang" as const, baseURL: down, models: ["m"] };

    const { state } = await evaluate(suiteOf([greetingTaskDir()], { implement: opencode({ localEndpoint }) }, { conditions: ["C0"], repeats: 2 }));

    expect(state.trials).toHaveLength(2);
    for (const trial of state.trials) {
      expect(trial.ended).toMatchObject({ outcome: "unscored", runId: null, attempts: 0, unscored: { reason: "setup_failed", detail: expect.stringContaining(`SGLang at ${down} is unavailable: GET ${down}/models`) } });
    }
    expect(fake.calls().filter((call) => call.argv[0] === "acp")).toEqual([]);
    const report = reportOf(state);
    expect(report.tools[0]!.engines).toEqual([{ engine: "sglang", name: "SGLang", baseURL: down, model: "m", versions: [], unavailableTrials: 2, firstError: expect.stringContaining(`GET ${down}/models`) }]);
    expect(formatReport(report)).toContain(`  on SGLang at ${down}, model m: UNAVAILABLE in 2 trials, not scored (GET ${down}/models`);
  });
});
