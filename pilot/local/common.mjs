// What the four local-engine suites share (inference-evaluation ticket 03): the pilot's tasks, the conditions, the repeats and
// the seed, so the only thing that differs between them is the engine OpenCode runs on. Each engine is the one bench/local.mjs
// measures, with the same model, so `ahp bench report <bench-dir>... --eval <eval-dir>...` puts its verified success beside its
// speed. See docs/pilot.md, "On a local engine".
//
// Run one engine's suite at a time (one fits 8 GB), after starting that engine from bench/engines/, with the shared seed:
//
//   ahp eval pilot/local/vllm.mjs --seed 20261101 --out pilot/results/<date>/vllm
//
// A trial whose engine does not serve the model when it starts is not scored (`setup_failed`) and starts no agent.

import bench from "../../bench/local.mjs";
import { TASKS as PILOT_TASKS } from "../common.mjs";

/** The pilot's six tasks, relative to this folder. */
export const TASKS = PILOT_TASKS.map((task) => task.replace(/^\.\//, "../"));

/**
 * C0 (one agent), C0V (one agent with the acceptance check and retry) and C3 (full AHP). C3c and C3r join once tickets 05 and
 * 06 land, so compression and reflection are measured on free local models too.
 */
export const CONDITIONS = ["C0", "C0V", "C3"];

/**
 * Trials per task and condition. Not yet sized: the local-engine spike (docs/spikes/2026-11-xx-local-engines.md) gives the time
 * per attempt, and one engine's suite should finish overnight. 6 tasks × 3 conditions is 18 trials a repeat, of 1 (C0), up to 3
 * (C0V) and 3 to 9 (C3) attempts; with t minutes per attempt, a 10-hour night holds about 600 / (18 × 4 × t) repeats.
 */
export const REPEATS = 1;

/** The seed of the trial order, the same for every engine: give it as `--seed` (a suite file has no seed of its own). */
export const SEED = 20261101;

/** The suite of one engine of bench/local.mjs: OpenCode, on that engine's model, in every role. */
export function suiteFor(engine) {
  const entry = bench.engines.find((candidate) => candidate.engine === engine);
  if (!entry) throw new Error(`bench/local.mjs lists no engine ${engine}`);
  const agent = {
    adapter: "opencode",
    model: `ahp-local/${entry.model}`,
    options: { localEndpoint: { engine: entry.engine, baseURL: entry.baseURL, models: [entry.model] } },
  };
  return {
    name: `pilot-local-${engine}`,
    tasks: TASKS,
    conditions: CONDITIONS,
    repeats: REPEATS,
    agents: { plan: agent, implement: agent, review: agent },
  };
}
