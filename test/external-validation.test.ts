import { describe, expect, it } from "vitest";
import { defineWorkflow, mock, validateWorkflow, WorkflowValidationError } from "../src/index.ts";
import type { MergeMethod } from "../src/index.ts";
import { gateStep } from "./helpers/approval.ts";
import { mergeStep, openStep, pushStep } from "./helpers/external.ts";

const agent = (id: string) => ({ id, agent: mock({ attempts: [{}] }), verification: { requiredOutputFields: ["summary"] } });

describe("validating a workflow with external actions", () => {
  it("accepts push, open and merge after an approval gate, and agent steps after them", () => {
    const steps = [agent("implement"), gateStep(), pushStep(), openStep(), mergeStep(), agent("after")];

    expect(validateWorkflow({ name: "ok", steps })).toEqual([]);
    expect(() => defineWorkflow({ name: "ok", steps: [agent("implement"), gateStep(), pushStep()] })).not.toThrow();
  });

  it("rejects an external action without an approval gate before it", () => {
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), pushStep()] })).toEqual([
      'step "push": an external action needs an approval gate before it, with nothing but external actions in between, and step "implement", ' +
        "which is not an approval gate, comes before it: AHP publishes only what a person approved (ADR 0003)",
    ]);
    expect(validateWorkflow({ name: "w", steps: [pushStep()] })[0]).toContain("and nothing comes before it");
  });

  it("rejects an agent step between the gate and the action: it would publish work nobody approved", () => {
    const problems = validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), agent("sneak"), pushStep()] });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('step "push": an external action needs an approval gate before it');
    expect(problems[0]).toContain('step "sneak", which is not an approval gate');
  });

  it("rejects a pull request with no push of its branch after the same gate, and a merge with no pull request opened", () => {
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), openStep()] })).toEqual([
      'step "open": open_pr needs a push_branch of branch "ahp/greeting" to remote "origin" before it, after the same gate: ' +
        "the pull request's branch must be the approved commit, pushed by AHP",
    ]);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep({ branch: "other" }), openStep()] })).toHaveLength(1);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep(), openStep({ remote: "upstream" })] })).toHaveLength(1);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep(), mergeStep()] })[0]).toContain(
      'step "merge": merge_pr needs a open_pr of branch "ahp/greeting"',
    );
  });

  it("rejects deploy, which AHP does not perform in release 1, and an unknown kind", () => {
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), { id: "ship", action: { kind: "deploy" } }] })).toEqual([
      'step "ship": deploy is not an external action AHP performs in release 1 (ADR 0003)',
    ]);
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), { id: "x", action: { kind: "tweet" } }] })).toEqual([
      'step "x": `action.kind` must be one of push_branch, open_pr, merge_pr',
    ]);
  });

  it("rejects branch and remote names git or gh could read as something else, and what an action has no use for", () => {
    const problems = validateWorkflow({
      name: "w",
      steps: [
        agent("implement"),
        gateStep(),
        { id: "push", action: { kind: "push_branch", branch: "--force", remote: "-u", force: true }, agent: { adapter: "mock" } },
      ],
    });

    expect(problems).toEqual([
      'step "push": an external action is performed by AHP, with no coding agent and nothing to verify, so it takes no `agent`',
      'step "push": unknown property `action.force` for push_branch',
      expect.stringContaining('step "push": `action.branch` must be a branch name'),
      expect.stringContaining('step "push": `action.remote` must name a configured git remote'),
    ]);
    for (const branch of ["a..b", "a/.hidden", "x.lock", "HEAD", "a b", "a//b", "/a", "a/", "a."]) {
      expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep({ branch })] }), branch).toHaveLength(1);
    }
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep({ branch: "feature/ahp-1.2_x" })] })).toEqual([]);
  });

  it("rejects a pull request without a title, into its own branch, and a merge with an unknown method", () => {
    const steps = [
      agent("implement"),
      gateStep(),
      pushStep(),
      openStep({ title: " ", base: "ahp/greeting" }),
      mergeStep({ method: "octopus" as MergeMethod }),
    ];

    expect(validateWorkflow({ name: "w", steps })).toEqual([
      'step "open": `action.base` names the pull request\'s own branch',
      'step "open": needs a non-empty `action.title`',
      'step "merge": `action.method` must be one of merge, squash, rebase',
    ]);
  });

  it("rejects a gate after an external action, and a review that would send one back", () => {
    const review = { id: "review", agent: mock({ attempts: [{}] }), review: { sendBackTo: "push" }, verification: {} };

    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep(), gateStep("again")] })[0]).toContain(
      'step "again": follows external action "push"',
    );
    expect(validateWorkflow({ name: "w", steps: [agent("implement"), gateStep(), pushStep(), review] })).toEqual([
      'step "review": `review.sendBackTo` names "push", an external action: it has no coding agent to send back',
    ]);
  });

  it("throws the problems from defineWorkflow", () => {
    expect(() => defineWorkflow({ name: "w", steps: [agent("implement"), pushStep()] })).toThrow(WorkflowValidationError);
  });
});
