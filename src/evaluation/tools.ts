// The coding-agent tools a trial runs on: which a workflow uses, and the version of each found on this machine, read the way
// `ahp doctor` reads it (the tool's own `--version`, nothing else) and compared with the suite's pin. A tool that reaches a
// local engine (OpenCode's `localEndpoint`) also has that engine checked, by the bench's own check (`checkEngine`).

import { tmpdir } from "node:os";
import { localEndpointProblems, servedModelOf, type LocalEndpoint } from "../adapters/opencode/local.ts";
import { probe } from "../doctor/probe.ts";
import { TOOLS, type ToolDefinition } from "../doctor/tools.ts";
import { checkEngine } from "../inference/check.ts";
import { ENGINE_NAMES } from "../inference/engines.ts";
import type { AgentRef, WorkflowDefinition } from "../protocol/index.ts";
import type { LocalEngineRecord, ToolVersionRecord } from "./events.ts";

/** The tools whose adapters the workflow's agent steps name, once each; the mock and any adapter without a tool are not tools. */
export function toolsUsedBy(workflow: WorkflowDefinition): ToolDefinition[] {
  const adapters = new Set(agentsOf(workflow).map((agent) => agent.adapter));
  return TOOLS.filter((tool) => adapters.has(tool.adapter));
}

const agentsOf = (workflow: WorkflowDefinition): AgentRef[] => workflow.steps.flatMap((step) => ("agent" in step ? [step.agent, ...(step.reroute ? [step.reroute] : [])] : []));

/** A local engine and the model a step requests of it. */
export interface LocalTarget {
  engine: LocalEndpoint["engine"];
  baseURL: string;
  model: string;
}

/**
 * The local engines the workflow's agents of `adapter` reach, once each by engine, URL and model, in the order the steps name
 * them. A step whose model is not one its endpoint lists is left out: its attempt fails before any prompt, and there is no
 * model to check the engine for.
 */
export function localTargetsOf(workflow: WorkflowDefinition, adapter: string): LocalTarget[] {
  const targets = new Map<string, LocalTarget>();
  for (const agent of agentsOf(workflow)) {
    if (agent.adapter !== adapter) continue;
    const endpoint = (agent.options as { localEndpoint?: unknown } | undefined)?.localEndpoint;
    if (endpoint === undefined || localEndpointProblems(endpoint).length > 0) continue;
    const valid = endpoint as LocalEndpoint;
    const model = servedModelOf(valid, agent.model ?? null);
    if (model === null) continue;
    const target = { engine: valid.engine, baseURL: valid.baseURL, model };
    targets.set(JSON.stringify(target), target);
  }
  return [...targets.values()];
}

/** Each local engine checked as the bench checks one: does `/v1/models` list the model, and what version does it say it is. */
export async function recordLocalEngines(targets: readonly LocalTarget[], options: { timeoutMs?: number } = {}): Promise<LocalEngineRecord[]> {
  return Promise.all(
    targets.map(async (target): Promise<LocalEngineRecord> => {
      const check = await checkEngine(target, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
      return { engine: target.engine, name: ENGINE_NAMES[target.engine], baseURL: target.baseURL, model: target.model, available: check.available, version: check.version, error: check.error };
    }),
  );
}

/** The version number in a tool's version line (`2.1.311 (Claude Code)` is `2.1.311`), or the line itself when it has none. */
export const versionNumberOf = (line: string): string => /\d+(?:\.\d+)+[\w.+-]*/.exec(line)?.[0] ?? line.trim();

/**
 * What each tool the workflow uses reports as its version, against the suite's pin for it. A tool that cannot be run, or
 * whose version cannot be read, is recorded with `found` null and the reason, and does not match a pin.
 */
export async function recordToolVersions(workflow: WorkflowDefinition, pins: Readonly<Record<string, string>> | undefined, env: NodeJS.ProcessEnv): Promise<ToolVersionRecord[]> {
  return Promise.all(
    toolsUsedBy(workflow).map(async (tool): Promise<ToolVersionRecord> => {
      const pinned = pins?.[tool.id] ?? null;
      const result = await probe(tool.command, tool.versionArgs, { env, cwd: tmpdir() });
      let found: string | null = null;
      let problem: string | null = null;
      if (result.outcome !== "exited") problem = result.message;
      else if (result.exitCode !== 0) problem = `\`${tool.command} ${tool.versionArgs.join(" ")}\` exited with code ${result.exitCode}`;
      else {
        const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
        if (line) found = versionNumberOf(line);
        else problem = "its version command printed nothing";
      }
      const engines = await recordLocalEngines(localTargetsOf(workflow, tool.adapter));
      return { tool: tool.id, pinned, found, matches: pinned === null ? null : found === pinned, problem, engines };
    }),
  );
}
