// The local-engine suites (inference-evaluation ticket 03): one per engine, the same tasks, conditions, repeats and seed, each on
// the engine and model bench/local.mjs measures. Nothing here runs an engine or an agent.

import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { localTargetsOf, loadTask, validateSuite, workflowFor, type EvaluationSuite } from "../src/evaluation/index.ts";
import { ENGINES } from "../src/inference/index.ts";
import { validateWorkflow } from "../src/sdk/workflow.ts";

const LOCAL = fileURLToPath(new URL("../pilot/local/", import.meta.url));
const fileOf = (engine: string) => `${engine === "tensorrt_llm" ? "tensorrt-llm" : engine}.mjs`;
const load = async <T>(path: string) => ((await import(pathToFileURL(path).href)) as { default: T }).default;

describe("the local-engine pilot suites", () => {
  it("are one per engine, valid, and differ only in the engine OpenCode runs on, which is bench/local.mjs's with its model", async () => {
    const bench = await load<{ engines: { engine: string; baseURL: string; model: string }[] }>(fileURLToPath(new URL("../bench/local.mjs", import.meta.url)));
    const suites = await Promise.all(ENGINES.map((engine) => load<EvaluationSuite>(join(LOCAL, fileOf(engine)))));
    const pilot = await load<EvaluationSuite>(fileURLToPath(new URL("../pilot/suite-a.mjs", import.meta.url)));

    for (const [i, suite] of suites.entries()) {
      const engine = ENGINES[i]!;
      expect(validateSuite(suite)).toEqual([]);
      expect(suite.name).toBe(`pilot-local-${engine}`);
      expect(suite.conditions).toEqual(["C0", "C0V", "C3", "C3c", "C3r"]);
      // The pilot's own tasks, named from this folder.
      expect(suite.tasks.map((task) => resolve(LOCAL, task))).toEqual(pilot.tasks.map((task) => resolve(LOCAL, "..", task)));
      const served = bench.engines.find((entry) => entry.engine === engine)!;
      for (const role of ["plan", "implement", "review"] as const) {
        expect(suite.agents[role]).toEqual({ adapter: "opencode", model: `ahp-local/${served.model}`, options: { localEndpoint: { engine, baseURL: served.baseURL, models: [served.model] } } });
      }
      const { name: _name, agents: _agents, ...shared } = suite;
      const { name: _first, agents: _firstAgents, ...firstShared } = suites[0]!;
      expect(shared).toEqual(firstShared);
    }
  });

  it("build workflows that validate, with the engine as each step's local target", async () => {
    const suite = await load<EvaluationSuite>(join(LOCAL, "vllm.mjs"));
    const { task } = await loadTask(resolve(LOCAL, suite.tasks[0]!));

    for (const condition of suite.conditions!) {
      const workflow = workflowFor(condition, task, suite, { condition, repeat: 1, baselineIndex: null });
      expect(validateWorkflow(workflow)).toEqual([]);
      expect(localTargetsOf(workflow, "opencode")).toEqual([{ engine: "vllm", baseURL: "http://localhost:8001/v1", model: "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ" }]);
    }
  });
});
