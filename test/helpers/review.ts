import { defineWorkflow, mock } from "../../src/index.ts";
import type { MockAttemptScript, RunView, StepDefinition } from "../../src/index.ts";

/** An implementing attempt that passes `VERIFY_GREETING`; `round` shows in the snapshot, so rounds can be told apart. */
export const implemented = (round: number): MockAttemptScript => ({
  edits: [
    { path: "greeting.txt", content: "hello\n" },
    { path: "round.txt", content: `round ${round}\n` },
  ],
  outputFields: { summary: `implemented in round ${round}` },
});

/** A review that asks for changes. */
export const changesRequested = (...findings: string[]): MockAttemptScript => ({
  outputFields: { verdict: "changes_requested", findings },
});

/** A review that approves. It still reports findings: the output fields a review step requires are both required. */
export const approved = (findings = "nothing to change"): MockAttemptScript => ({
  outputFields: { verdict: "approved", findings },
});

/** The step a review sends back: it needs `VERIFY_GREETING` in the repository. */
export const implementStep = (attempts: MockAttemptScript[], step: Partial<StepDefinition> = {}): StepDefinition => ({
  id: "implement",
  agent: mock({ attempts }),
  verification: { command: "node verify.mjs", requiredOutputFields: ["summary"] },
  ...step,
});

/** A review step that sends `implement` back when it asks for changes. It declares no command: structural verification. */
export const reviewStep = (attempts: MockAttemptScript[], step: Partial<StepDefinition> = {}): StepDefinition => ({
  id: "review",
  agent: mock({ attempts }),
  review: { sendBackTo: "implement" },
  verification: {},
  ...step,
});

/** Implement, then review. */
export const reviewedWorkflow = (implement: StepDefinition, review: StepDefinition) =>
  defineWorkflow({ name: "reviewed", steps: [implement, review] });

export const stepOf = (state: RunView, id: string) => state.steps.find((step) => step.id === id)!;
