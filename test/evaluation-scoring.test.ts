import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport } from "../src/evaluation/index.ts";
import { APPROVES, DOES_NOTHING, evaluate, GREETS, GREETS_AND_SAYS_GOODBYE, greetingTaskDir, repoOf, runOf, scripted, suiteOf, trialOf, writeTree } from "./helpers/evaluation.ts";
import { git, removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const c0 = (task: string, ...scripts: Parameters<typeof scripted>) => suiteOf([task], { implement: scripted(...scripts) }, { conditions: ["C0"] });

describe("scoring is the validators' alone", () => {
  it("scores a trial a pass when the hidden tests pass, though the agent exited with an error and its run failed", async () => {
    const { state } = await evaluate(c0(greetingTaskDir(), { ...GREETS, exitCode: 1 }));

    // The in-run verdict says failed; the validators ran on the snapshot the failed attempt left, and passed it.
    expect(state.trials[0]!.ended).toMatchObject({ outcome: "scored", runState: "failed", failureClass: "agent_error", score: { verdict: "pass" } });
  });

  it("scores a trial a fail when the validators fail it, though its run succeeded and the agent claimed success", async () => {
    const { state, report } = await evaluate(c0(greetingTaskDir(), { ...DOES_NOTHING, outputFields: { summary: "all done, the greeting is written" } }));

    expect(state.trials[0]!.ended).toMatchObject({ outcome: "scored", runState: "succeeded", score: { verdict: "fail" } });
    expect(report.conditions[0]!.failures).toEqual({ run_succeeded: 1 });
  });

  it("fails a trial that changed a protected path, without running the tests, and one that wrote a file over a hidden test", async () => {
    const protectedTask = greetingTaskDir({ verification: { command: "node check-greeting.mjs", protectedPaths: ["package.json"] } }, { "repo/package.json": "{}\n" });
    const tampers = { edits: [{ path: "greeting.txt", content: "hello\n" }, { path: "package.json", content: '{"scripts":{}}\n' }], outputFields: { summary: "done" } };
    const overwritesTest = { edits: [{ path: "check-greeting.mjs", content: "process.exit(0);\n" }], outputFields: { summary: "done" } };

    const first = await evaluate(c0(protectedTask, tampers));
    const second = await evaluate(c0(greetingTaskDir(), overwritesTest));

    expect(first.state.trials[0]!.ended!.score).toMatchObject({ verdict: "fail", tests: { ran: false, exitCode: null }, protectedPathViolations: ["package.json"] });
    expect(second.state.trials[0]!.ended!.score).toMatchObject({ verdict: "fail", tests: { ran: false }, protectedPathViolations: ["check-greeting.mjs"] });
  });

  it("scores a planted constraint apart from success: a trial can pass the hidden tests and still violate one", async () => {
    const { state, report } = await evaluate(c0(greetingTaskDir(), GREETS_AND_SAYS_GOODBYE));

    expect(state.trials[0]!.ended!.score).toMatchObject({ verdict: "pass", constraints: [{ id: "no-goodbye", outcome: "violated" }] });
    expect(report.conditions[0]).toMatchObject({ passes: 1, successRate: 1, constraintTrials: 1, constraintViolations: 1, constraintViolationRate: 1 });
  });

  it("leaves a trial that changed nothing out of the constraint-violation rate: its result holds every constraint vacuously", async () => {
    const implement = (task: { id: string }) => scripted(task.id === "idle" ? DOES_NOTHING : GREETS_AND_SAYS_GOODBYE)();

    const { report, state } = await evaluate(suiteOf([greetingTaskDir({ id: "idle" }), greetingTaskDir({ id: "bad" })], { implement }, { conditions: ["C0"] }));

    expect([trialOf(state, "C0", "idle"), trialOf(state, "C0", "bad")].map((trial) => trial.ended!.result!.changed)).toEqual([false, true]);
    // Both are scored, but only the trial that produced something can say whether the constraint survived.
    expect(report.conditions[0]).toMatchObject({ scored: 2, constraintTrials: 1, constraintViolations: 1, constraintViolationRate: 1, unchangedResults: 1 });
    expect(formatReport(report)).toContain("scored trials whose result changed nothing, left out of the violation rate: 1");
  });

  it("checks a required invariant by its command in the result, and finds it violated when it exits non-zero", async () => {
    const task = greetingTaskDir(
      { constraints: [{ id: "still-works", statement: "The README stays.", check: { kind: "required_invariant", command: "node invariant.mjs" } }] },
      { "hidden/invariant.mjs": 'import { existsSync } from "node:fs"; process.exit(existsSync("README.md") ? 0 : 1);\n' },
    );
    const deletesReadme = { ...GREETS, deletes: ["README.md"] };

    const kept = await evaluate(c0(task, GREETS));
    const lost = await evaluate(c0(task, deletesReadme));

    expect(kept.state.trials[0]!.ended!.score!.constraints).toEqual([{ id: "still-works", outcome: "held" }]);
    expect(lost.state.trials[0]!.ended!.score!.constraints).toEqual([{ id: "still-works", outcome: "violated" }]);
  });

  it("runs the validators in a verification worktree of their own: the hidden test is in the validators' output, never in the snapshot", async () => {
    const { dir, state } = await evaluate(c0(greetingTaskDir(), GREETS));

    const trial = state.trials[0]!;
    const validation = JSON.parse(readFileSync(join(dir, ...trial.ended!.artifacts!.validation!.path.split("/")), "utf8"));
    expect(validation.tests.output).toContain("greeting ok");
    expect(validation.commit).toBe(trial.ended!.result!.commit);
    expect(git(repoOf(dir, trial), "ls-tree", "-r", "--name-only", trial.ended!.result!.commit).split("\n")).toEqual(["README.md", "greeting.txt", "visible-check.mjs"]);
  });
});

describe("harness incidents", () => {
  const LOSES_CONTACT = { ...GREETS, loseContact: true };

  it("ends a trial whose attempt is unknown as a harness incident under an abort, never retrying it, and never scoring it", async () => {
    const { dir, types, state, report } = await evaluate(c0(greetingTaskDir(), LOSES_CONTACT));

    const run = await runOf(dir, state.trials[0]!);
    expect(run.steps[0]!.attempts.map((attempt) => attempt.state)).toEqual(["unknown"]);
    expect(run.steps[0]!.attempts[0]!.recovery!.decision).toMatchObject({ policy: "abort", decidedBy: "step_policy" });
    // The unknown attempt's workspace is left where it is: its agent may still be running, and it is all that is known of what it did.
    expect(existsSync(run.steps[0]!.attempts[0]!.workspace)).toBe(true);
    // Recorded before the trial ends; the trial has no score and no result.
    expect(types.slice(-4)).toEqual(["trial_started", "harness_incident", "trial_ended", "evaluation_ended"]);
    expect(state.trials[0]!.incident).toMatchObject({ unknownReason: "lost_contact" });
    expect(state.trials[0]!.ended).toMatchObject({ outcome: "harness_incident", score: null, result: null, runState: "failed" });
    expect(report.conditions[0]).toMatchObject({ trials: 1, scored: 0, passes: 0, successRate: null, harnessIncidents: { count: 1 } });
    expect(report.conditions[0]!.failures).toEqual({});
  });

  it("leaves an incident out of every rate: the other trials' success rate is over the valid ones", async () => {
    const lost = greetingTaskDir({ id: "lost" });
    const fine = greetingTaskDir({ id: "fine" });
    // The agent is cast per task: one loses contact, the other does the work.
    const implement = (task: { id: string }) => scripted(task.id === "lost" ? LOSES_CONTACT : GREETS)();

    const { report } = await evaluate(suiteOf([lost, fine], { implement }, { conditions: ["C0"] }));

    expect(report.conditions[0]).toMatchObject({
      trials: 2,
      scored: 1,
      passes: 1,
      successRate: 1,
      harnessIncidents: { count: 1, trials: [expect.objectContaining({ taskId: "lost", reason: "lost_contact" })] },
    });
  });

  it("counts an incident against the condition it happened in, in C3 too", async () => {
    const { report } = await evaluate(suiteOf([greetingTaskDir()], { plan: scripted(LOSES_CONTACT), implement: scripted(GREETS), review: scripted(APPROVES) }, { conditions: ["C0", "C3"] }));

    const [first, second] = report.conditions;
    expect(first).toMatchObject({ condition: "C0", scored: 1, harnessIncidents: { count: 0 } });
    expect(second).toMatchObject({ condition: "C3", scored: 0, harnessIncidents: { count: 1 } });
  });
});

describe("trials with nothing to score", () => {
  it("does not read a login problem as a failed trial: the run ended config_auth, so no agent did the work", async () => {
    const { state, report } = await evaluate(c0(greetingTaskDir(), { exitCode: 1, error: { kind: "config_auth", message: "not logged in" } }));

    expect(state.trials[0]!.ended).toMatchObject({ outcome: "unscored", score: null, failureClass: "config_auth", unscored: { reason: "setup_failed" } });
    expect(report.conditions[0]).toMatchObject({ scored: 0, successRate: null, unscored: { count: 1, byReason: { setup_failed: 1 } } });
  });

  it("does not read a validator that could not run as a pass or a fail: an install that fails twice is unscored", async () => {
    const task = greetingTaskDir({ verification: { command: "node check-greeting.mjs", install: "node install.mjs" } }, { "repo/install.mjs": "process.exit(1);\n" });

    const { state, report } = await evaluate(c0(task, GREETS));

    expect(state.trials[0]!.ended).toMatchObject({ outcome: "unscored", score: null, unscored: { reason: "validator_inconclusive", detail: expect.stringContaining("install") } });
    expect(report.conditions[0]).toMatchObject({ scored: 0, passes: 0, unscored: { byReason: { validator_inconclusive: 1 } } });
  });

  it("ends a trial that AHP itself threw in as a harness_error, and goes on to the next", async () => {
    // A fixture of nothing but ignored files has nothing to commit, so making the trial's repository fails.
    const files = { "task.json": JSON.stringify({ id: "empty", prompt: "x", verification: { command: "node check-greeting.mjs" } }), "repo/.gitignore": "*\n", "hidden/check-greeting.mjs": "process.exit(0);\n" };
    const broken = writeTree(files);

    const { state, report } = await evaluate(suiteOf([broken, greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"] }));

    expect(state.trials.map((trial) => trial.ended!.outcome)).toEqual(["unscored", "scored"]);
    expect(state.trials[0]!.ended).toMatchObject({ runId: null, runState: null, score: null, unscored: { reason: "harness_error", detail: expect.stringContaining("git commit") } });
    // What it has is kept: its configuration, though no run was made.
    expect(state.trials[0]!.ended!.artifacts).toMatchObject({ config: { path: expect.stringContaining("config.json") }, prompts: [], transcripts: [], runLedger: null });
    expect(report.conditions[0]).toMatchObject({ scored: 1, passes: 1, unscored: { byReason: { harness_error: 1 } } });
  });
});
