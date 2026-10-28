import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, readRun, readRunEvents, type MockAttemptScript } from "../../src/index.ts";
import { runEvaluation, type EvaluationEvent, type EvaluationSuite, type RunEvaluationOptions, type TrialView } from "../../src/evaluation/index.ts";
import { trackForRemoval } from "./repo.ts";

/** Runs an evaluation into a fresh directory and collects the events it records, in order. */
export async function evaluate(suite: EvaluationSuite, options: Partial<RunEvaluationOptions> = {}) {
  const events: EvaluationEvent[] = [];
  const result = await runEvaluation(suite, {
    out: writeTree({}),
    ...options,
    onEvent: (event, state) => {
      events.push(event);
      options.onEvent?.(event, state);
    },
  });
  return { ...result, events, types: events.map((event) => event.type) };
}

export { sha256Of } from "../../src/evaluation/index.ts";

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

/** A mock agent that does nothing useful but says so as a summary. */
export const DOES_NOTHING: MockAttemptScript = { outputFields: { summary: "nothing to do" } };

/** The roles of a suite that only runs C0 need just the implementer. */
export const suiteOf = (tasks: string[], agents: EvaluationSuite["agents"], more: Partial<EvaluationSuite> = {}): EvaluationSuite => ({
  name: "test-suite",
  tasks,
  agents,
  ...more,
});

/** Writes `files` (path → content, `/` separators) into a fresh temporary directory, removed by `removeTempRepos`. */
export function writeTree(files: Record<string, string>): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-eval-test-")));
  trackForRemoval(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

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
