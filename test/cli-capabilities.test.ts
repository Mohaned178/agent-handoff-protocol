import { afterEach, describe, expect, it } from "vitest";
import { ahp } from "./helpers/cli.ts";
import { createTempRepo, removeTempRepos, VERIFY_GREETING } from "./helpers/repo.ts";

afterEach(removeTempRepos);

/** A one-step workflow file whose mock agent writes the greeting, with `step` merged into the step. */
function workflowFile(attempt: Record<string, unknown>, step: Record<string, unknown> = {}): string {
  return `export default {
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: { adapter: "mock", model: "model-a", options: { attempts: [${JSON.stringify({ edits: [{ path: "greeting.txt", content: "hello\n" }], ...attempt })}] } },
      verification: { command: "node verify.mjs" },
      retry: { budget: 0 },
      ...${JSON.stringify(step)},
    },
  ],
};
`;
}

const runAndInspect = (workflow: string) => {
  const repo = createTempRepo({ "verify.mjs": VERIFY_GREETING, "workflow.mjs": workflow });
  const run = ahp(["run", "workflow.mjs"], repo);
  const runId = /run (run_[a-z0-9]+): /.exec(run.stdout)?.[1];
  expect(runId, run.stdout + run.stderr).toBeDefined();
  return { run, inspect: ahp(["inspect", runId!, "--repo", repo], repo) };
};

describe("ahp inspect on capabilities, models and usage", () => {
  it("shows, per attempt, the declared level of every capability, with what each level means", () => {
    const { inspect } = runAndInspect(
      workflowFile({}, { capabilities: [{ kind: "write_scope", paths: ["greeting.txt"] }], network: { stance: "package_registries" } }),
    );

    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(
      `capabilities as the adapter declares them for ${process.platform} ` +
        "(enforced_by_tool: the tool itself blocks it; cooperative: the agent is only asked, and nothing stops it; none: not applied):",
    );
    expect(inspect.stdout).toContain("write_scope under greeting.txt: cooperative (required at least cooperative)");
    expect(inspect.stdout).toContain("no_external_actions: cooperative (required at least none)");
    expect(inspect.stdout).toContain(
      "network package_registries: none (required at least none); the agent's own tool use only, never its connection to its model provider",
    );
  });

  it("shows the requested and the reported model, and the usage with its source", () => {
    const { inspect } = runAndInspect(workflowFile({ reportedModel: "model-b", usage: { inputTokens: 1200, outputTokens: 300 } }));

    expect(inspect.stdout).toContain("requested model: model-a");
    expect(inspect.stdout).toContain("reported model: model-b (not the requested model)");
    expect(inspect.stdout).toContain("usage: 1200 input tokens, 300 output tokens (source: mock script (scripted, not measured))");
  });

  it("says the model is unknown and no usage was reported when the tool gave none, and shows no number", () => {
    const { inspect } = runAndInspect(workflowFile({}));

    expect(inspect.stdout).toContain("reported model: unknown (the tool did not report one)");
    expect(inspect.stdout).toContain("usage: none recorded: the adapter reported none it could vouch for (nothing is estimated)");
    expect(inspect.stdout).not.toMatch(/\d+ (input|output|total) tokens/);
  });

  it("shows a rejected request with its code, where it is, and that no agent ran", () => {
    const { run, inspect } = runAndInspect(workflowFile({}, { capabilities: [{ kind: "read_only", require: "enforced_by_tool" }] }));

    expect(run.code).not.toBe(0);
    expect(inspect.stdout).toContain("rejected (capability_unsatisfiable) at /capabilities/0:");
    expect(inspect.stdout).toContain(`adapter "mock" applies read_only at most at "cooperative" on ${process.platform}`);
    expect(inspect.stdout).not.toContain("attempt att_");
  });
});
