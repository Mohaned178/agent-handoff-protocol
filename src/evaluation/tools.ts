// The coding-agent tools a trial runs on: which a workflow uses, and the version of each found on this machine, read the way
// `ahp doctor` reads it (the tool's own `--version`, nothing else) and compared with the suite's pin.

import { tmpdir } from "node:os";
import { probe } from "../doctor/probe.ts";
import { TOOLS, type ToolDefinition } from "../doctor/tools.ts";
import type { WorkflowDefinition } from "../protocol/index.ts";
import type { ToolVersionRecord } from "./events.ts";

/** The tools whose adapters the workflow's agent steps name, once each; the mock and any adapter without a tool are not tools. */
export function toolsUsedBy(workflow: WorkflowDefinition): ToolDefinition[] {
  const adapters = new Set(workflow.steps.flatMap((step) => ("agent" in step ? [step.agent.adapter, ...(step.reroute ? [step.reroute.adapter] : [])] : [])));
  return TOOLS.filter((tool) => adapters.has(tool.adapter));
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
      return { tool: tool.id, pinned, found, matches: pinned === null ? null : found === pinned, problem };
    }),
  );
}
