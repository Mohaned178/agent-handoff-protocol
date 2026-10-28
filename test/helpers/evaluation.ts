import { createHash } from "node:crypto";
import { join } from "node:path";
import { mock, readRun, readRunEvents, type MockAttemptScript } from "../../src/index.ts";
import { runEvaluation, type EvaluationEvent, type EvaluationSuite, type RunEvaluationOptions, type TrialView } from "../../src/evaluation/index.ts";
import { writeTree } from "./repo.ts";

export { writeTree };

/**
 * Runs an evaluation into a fresh directory and collects the events it records, in order. The seed is fixed unless a test
 * gives one, so a test that fails fails again in the same order; tests still read trials by condition, never by position.
 */
export async function evaluate(suite: EvaluationSuite, options: Partial<RunEvaluationOptions> = {}) {
  const events: EvaluationEvent[] = [];
  const result = await runEvaluation(suite, {
    out: writeTree({}),
    seed: 1,
    ...options,
    onEvent: (event, state) => {
      events.push(event);
      options.onEvent?.(event, state);
    },
  });
  return { ...result, events, types: events.map((event) => event.type) };
}

/** SHA-256 by plain `crypto`, so a test checking a hash the code produced does not use the code to say what it should be. */
export const sha256Of = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The one trial of `condition` (on `taskId`, when given): trials start in a shuffled order, so a test never reads one by position. */
export function trialOf(state: { trials: TrialView[] }, condition: string, taskId?: string): TrialView {
  const found = state.trials.filter((trial) => trial.condition === condition && (taskId === undefined || trial.taskId === taskId));
  if (found.length !== 1) throw new Error(`expected one ${condition} trial${taskId ? ` of ${taskId}` : ""}, found ${found.length}`);
  return found[0]!;
}

/** A trial's own repository, inside the evaluation's directory. */
export const repoOf = (dir: string, trial: Pick<TrialView, "repo">) => join(dir, ...trial.repo.split("/"));

/** The run a trial ran, read from the trial's own repository. */
export const runOf = (dir: string, trial: Pick<TrialView, "repo" | "ended">) => readRun({ repo: repoOf(dir, trial), runId: trial.ended!.runId! });

/** The events of the run a trial ran. */
export const runEventsOf = (dir: string, trial: Pick<TrialView, "repo" | "ended">) => readRunEvents({ repo: repoOf(dir, trial), runId: trial.ended!.runId! });

/** A mock agent whose attempts are `scripts`, in attempt order, for a role of an evaluation suite. */
export const scripted = (...scripts: MockAttemptScript[]) => () => mock({ attempts: scripts });

/** The mock agent that makes the greeting task's hidden test pass, and reports a summary. */
export const GREETS: MockAttemptScript = { edits: [{ path: "greeting.txt", content: "hello\n" }], outputFields: { summary: "wrote the greeting" } };

/** A mock agent that does the work but breaks the planted constraint, writing the forbidden word into a note. */
export const GREETS_AND_SAYS_GOODBYE: MockAttemptScript = {
  edits: [
    { path: "greeting.txt", content: "hello\n" },
    { path: "NOTES.md", content: "Goodbye for now.\n" },
  ],
  outputFields: { summary: "wrote the greeting" },
};

/** The plan step's report: what C3's first step hands on. */
export const PLANS: MockAttemptScript = {
  outputFields: {
    summary: "Write greeting.txt.",
    decisions: ["the greeting goes in greeting.txt"],
    constraints: ["Never write the word goodbye anywhere in the repository."],
  },
};

/** A review that approves, and one that asks for changes. */
export const APPROVES: MockAttemptScript = { outputFields: { verdict: "approved", findings: ["nothing to change"] } };
export const REQUESTS_CHANGES: MockAttemptScript = { outputFields: { verdict: "changes_requested", findings: ["the greeting is not what was asked for"] } };

/** What C3's implement step reports: the plan's fields, restated, which C0's single step may report too. */
export const IMPLEMENTS: MockAttemptScript = { ...GREETS, outputFields: { ...PLANS.outputFields, summary: "wrote the greeting" } };

/** A mock agent that does nothing useful but says so as a summary. */
export const DOES_NOTHING: MockAttemptScript = { outputFields: { summary: "nothing to do" } };

/** The roles of a suite that only runs C0 need just the implementer. */
export const suiteOf = (tasks: string[], agents: EvaluationSuite["agents"], more: Partial<EvaluationSuite> = {}): EvaluationSuite => ({
  name: "test-suite",
  tasks,
  agents,
  ...more,
});

/** The hidden test of the greeting task: passes when `greeting.txt` holds `hello`. */
export const HIDDEN_GREETING_TEST = `
import { existsSync, readFileSync } from "node:fs";
const ok = existsSync("greeting.txt") && readFileSync("greeting.txt", "utf8").trim() === "hello";
console.log(ok ? "greeting ok" : "greeting missing or wrong");
process.exit(ok ? 0 : 1);
`;

/** The `task.json` of the greeting task, with `changes` applied over it. */
export function greetingSpec(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "greeting",
    prompt: "Create greeting.txt containing the word hello.",
    constraints: [
      {
        id: "no-goodbye",
        statement: "Never write the word goodbye anywhere in the repository.",
        check: { kind: "forbidden_pattern", pattern: "goodbye", flags: "i" },
      },
    ],
    verification: { command: "node check-greeting.mjs" },
    ...changes,
  };
}

/** The files of the greeting task: a fixture with a README, one hidden test, and a `task.json`. */
export function greetingFiles(changes: Record<string, unknown> = {}, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "task.json": JSON.stringify(greetingSpec(changes), null, 2),
    "repo/README.md": "# greeting\n",
    "hidden/check-greeting.mjs": HIDDEN_GREETING_TEST,
    ...extra,
  };
}

/** A task directory for the greeting task. */
export const greetingTaskDir = (changes: Record<string, unknown> = {}, extra: Record<string, string> = {}) => writeTree(greetingFiles(changes, extra));
