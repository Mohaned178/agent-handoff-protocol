import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport, loadTask, readEvaluation, runEvaluation, SuiteInvalidError, TaskInvalidError } from "../src/evaluation/index.ts";
import { LedgerCorruptError, readLedger } from "../src/ledger/index.ts";
import { APPROVES, DOES_NOTHING, evaluate, GREETS, greetingFiles, greetingTaskDir, PLANS, repoOf, runOf, scripted, sha256Of, suiteOf, writeTree } from "./helpers/evaluation.ts";
import { git, removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const IMPLEMENTS = { ...GREETS, outputFields: { ...PLANS.outputFields, summary: "wrote the greeting" } };
// IMPLEMENTS restates what the plan handed on, which C3's implement step must report and C0's single step may.
const both = (task: string) => suiteOf([task], { plan: scripted(PLANS), implement: scripted(IMPLEMENTS), review: scripted(APPROVES) }, { conditions: ["C0", "C3"] });

describe("a task that changes after it was frozen", () => {
  it("stops the evaluation before the next trial, records what changed, and never freezes the task again", async () => {
    const dir = greetingTaskDir();
    const frozen = await loadTask(dir);

    const { types, events, state, report } = await evaluate(both(dir), {
      // The hidden test is edited once the first trial has ended, as someone tuning a task toward a condition would.
      onEvent: (event) => {
        if (event.type === "trial_ended") writeFileSync(join(dir, "hidden", "check-greeting.mjs"), "process.exit(0);\n");
      },
    });

    expect(types).toEqual(["evaluation_created", "task_frozen", "trial_started", "trial_ended", "task_changed", "evaluation_ended"]);
    const changed = events.find((event) => event.type === "task_changed");
    expect(changed).toMatchObject({ taskId: "greeting", frozenHash: frozen.hash, changed: [{ path: "hidden/check-greeting.mjs", change: "modified" }] });
    expect(changed).toMatchObject({ foundHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((changed as { foundHash: string }).foundHash).not.toBe(frozen.hash);
    expect(events.at(-1)).toMatchObject({ type: "evaluation_ended", state: "stopped", reason: "task_changed" });
    // The trial that ran before the change stands; the second never started.
    expect(state.trials.map((trial) => [trial.condition, trial.ended!.outcome])).toEqual([["C0", "scored"]]);
    expect(report.taskChanges).toEqual([expect.objectContaining({ taskId: "greeting", frozenHash: frozen.hash })]);
    expect(formatReport(report)).toContain('TASK CHANGED: "greeting"');
  });

  it("detects a task directory that has gone, or holds something a task may not", async () => {
    const gone = greetingTaskDir();
    const first = await evaluate(both(gone), { onEvent: (event) => event.type === "trial_ended" && rmSync(gone, { recursive: true, force: true }) });
    expect(first.events.find((event) => event.type === "task_changed")).toMatchObject({ foundHash: null, changed: [] });
    expect(first.state).toMatchObject({ state: "stopped", reason: "task_changed" });

    const added = greetingTaskDir();
    const second = await evaluate(both(added), { onEvent: (event) => event.type === "trial_ended" && writeFileSync(join(added, "notes.md"), "tuned\n") });
    expect(second.events.find((event) => event.type === "task_changed")).toMatchObject({ changed: [{ path: "notes.md", change: "added" }] });
  });

  it("runs every trial of a task that does not change, each after its own check against the freeze", async () => {
    const { state } = await evaluate(both(greetingTaskDir()));

    expect(state).toMatchObject({ state: "completed", reason: null });
    expect(state.trials.map((trial) => trial.condition)).toEqual(["C0", "C3"]);
  });
});

describe("cancelling an evaluation", () => {
  it("cancels the trial in hand, without scoring it, and starts no further trial", async () => {
    const controller = new AbortController();

    const { types, state, report } = await evaluate(both(greetingTaskDir()), {
      signal: controller.signal,
      onEvent: (event) => event.type === "trial_started" && controller.abort(),
    });

    expect(types).toEqual(["evaluation_created", "task_frozen", "trial_started", "trial_ended", "evaluation_ended"]);
    expect(state.trials[0]!.ended).toMatchObject({ outcome: "cancelled", runState: "cancelled", score: null, result: null });
    expect(state).toMatchObject({ state: "cancelled" });
    // Not an incident and not a failure: a cancelled trial is in no rate.
    expect(report.conditions[0]).toMatchObject({ trials: 1, scored: 0, cancelled: 1, harnessIncidents: { count: 0 }, unscored: { count: 0 } });
  });

  it("starts no trial at all when it is cancelled before the first, though the tasks are frozen", async () => {
    const controller = new AbortController();
    controller.abort();

    const { types, state } = await evaluate(both(greetingTaskDir()), { signal: controller.signal });

    expect(types).toEqual(["evaluation_created", "task_frozen", "evaluation_ended"]);
    expect(state.state).toBe("cancelled");
  });
});

describe("what a trial keeps", () => {
  it("keeps its configuration, what each agent was sent and printed, the run's ledger, the result's diff and the validators' evidence, each named by path and hash", async () => {
    const { dir, state } = await evaluate(both(greetingTaskDir()));

    const [, c3] = state.trials;
    const artifacts = c3!.ended!.artifacts!;
    const read = (file: { path: string }) => readFileSync(join(dir, ...file.path.split("/")));
    const everything = [artifacts.config, artifacts.runLedger!, artifacts.patch!, artifacts.validation!, ...artifacts.prompts.map((p) => p.file), ...artifacts.transcripts.map((t) => t.file)];
    for (const file of everything) {
      expect(sha256Of(read(file))).toBe(file.sha256);
      expect(read(file).length).toBe(file.bytes);
    }
    // The trial's start event named the same configuration, before the trial ran.
    expect(artifacts.config).toEqual((await readEvaluation(dir)).trials[1]!.ended!.artifacts!.config);
    const config = JSON.parse(read(artifacts.config).toString("utf8"));
    expect(config).toMatchObject({ condition: "C3", task: { id: "greeting" }, workflow: { name: "greeting-C3" } });
    expect(config.workflow.steps.map((step: { id: string }) => step.id)).toEqual(["plan", "implement", "review"]);
    // One prompt and one transcript per attempt, each as that attempt's agent was sent and printed it.
    expect(artifacts.prompts.map((p) => p.attemptId)).toEqual(artifacts.transcripts.map((t) => t.attemptId));
    expect(artifacts.prompts).toHaveLength(3);
    expect(JSON.parse(read(artifacts.prompts[1]!.file).toString("utf8")).edits[0].path).toBe("greeting.txt");
    expect(JSON.parse(read(artifacts.transcripts[0]!.file).toString("utf8")).outputFields.summary).toBe("Write greeting.txt.");
    // The run's ledger is a checked, readable ledger; the patch is the work; the validators' evidence has the test output.
    expect((await readLedger(join(dir, ...artifacts.runLedger!.path.split("/")))).corruption).toBeNull();
    expect(read(artifacts.patch!).toString("utf8")).toContain("+hello");
    expect(JSON.parse(read(artifacts.validation!).toString("utf8"))).toMatchObject({ validatorRuns: 1, tests: { exitCode: 0 } });
  });

  it("keeps the trial's repository and the result's snapshot, so its run can be inspected afterwards, but not the attempts' worktrees", async () => {
    const { dir, state } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"] }));

    const trial = state.trials[0]!;
    expect(existsSync(join(dir, ...trial.repo.split("/"), ".git"))).toBe(true);
    expect(readdirSync(join(dir, "trials"))).toHaveLength(1);
    // The run is still readable, its snapshot still there; what the agent left in its workspace (`node_modules`, say) is not kept.
    const run = await runOf(dir, trial);
    expect(git(repoOf(dir, trial), "cat-file", "-t", trial.ended!.result!.commit)).toBe("commit");
    expect(existsSync(run.steps[0]!.attempts[0]!.workspace)).toBe(false);
    expect(git(repoOf(dir, trial), "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  });
});

describe("a suite or task that cannot be run", () => {
  const problemsOf = async (suite: Parameters<typeof runEvaluation>[0]) => {
    const out = writeTree({});
    const error = await runEvaluation(suite, { out }).then(() => null, (e: unknown) => e);
    // Nothing was written: no evaluation directory, so no ledger.
    expect(readdirSync(out)).toEqual([]);
    return error;
  };

  it("names the task and condition of a workflow that is invalid, before anything is written", async () => {
    const error = await problemsOf(suiteOf([greetingTaskDir()], { implement: () => ({ adapter: "mock", options: { attempts: [] } }) }, { conditions: ["C0"] }));

    expect(error).toBeInstanceOf(SuiteInvalidError);
    expect((error as SuiteInvalidError).problems).toEqual([expect.stringMatching(/^task "greeting", C0: .*non-empty `attempts`/)]);
  });

  it("needs a plan and a review agent for C3, an implementer always, and refuses a task listed twice or named twice", async () => {
    const task = greetingTaskDir();
    const error = await problemsOf(suiteOf([task, task], { implement: scripted(GREETS) }, { conditions: ["C3"] }));
    expect((error as SuiteInvalidError).problems).toEqual(expect.arrayContaining([expect.stringContaining("listed twice"), expect.stringContaining("`agents.plan` is needed"), expect.stringContaining("`agents.review` is needed")]));

    const named = await problemsOf(suiteOf([greetingTaskDir(), greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"] }));
    expect((named as SuiteInvalidError).problems).toEqual(['two tasks are named "greeting"']);

    const noImplementer = await problemsOf(suiteOf([task], {}, { conditions: ["C0"] }));
    expect((noImplementer as SuiteInvalidError).problems).toEqual([expect.stringContaining("`agents.implement` is needed")]);
  });

  it("refuses a task that is invalid, naming its problems, and a condition that does not exist", async () => {
    const error = await problemsOf(suiteOf([writeTree(greetingFiles({ prompt: "" }))], { implement: scripted(GREETS) }, { conditions: ["C0"] }));
    expect(error).toBeInstanceOf(TaskInvalidError);

    const unknown = await problemsOf(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C1" as "C0"] }));
    expect((unknown as SuiteInvalidError).problems).toEqual([expect.stringContaining("`conditions` must be")]);
  });
});

describe("the evaluation's ledger", () => {
  it("is a hash-chained ledger of its own that replays to the state the run ended with, and refuses to once it is tampered with", async () => {
    const { dir, state } = await evaluate(both(greetingTaskDir()));

    expect(existsSync(join(dir, "ledger.lock"))).toBe(false);
    expect(await readEvaluation(dir)).toEqual(state);
    const path = join(dir, "ledger.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const frozen = JSON.parse(lines[1]!);
    frozen.taskHash = "0".repeat(64);
    writeFileSync(path, [lines[0], JSON.stringify(frozen), ...lines.slice(2)].join("\n") + "\n");
    await expect(readEvaluation(dir)).rejects.toThrow(LedgerCorruptError);
  });

  it("says it stopped, with why, when something throws that is not a trial's own failure, and rethrows it", async () => {
    const out = writeTree({});
    let seen = 0;

    await expect(
      runEvaluation(both(greetingTaskDir()), { out, onEvent: (event) => { if (event.type === "trial_started" && seen++ === 0) throw new Error("boom"); } }),
    ).rejects.toThrow("boom");

    const [id] = readdirSync(out);
    expect(await readEvaluation(join(out, id!))).toMatchObject({ state: "stopped", reason: "error: boom", trials: [{ ended: null }] });
  });
});

describe("the report", () => {
  it("states every rate with its counts, the exclusions, and the mock label, and draws no comparison", async () => {
    const lost = { ...GREETS, loseContact: true };
    const implement = (task: { id: string }) => scripted(task.id === "wrong" ? DOES_NOTHING : task.id === "lost" ? lost : GREETS)();
    const suite = suiteOf([greetingTaskDir({ id: "right" }), greetingTaskDir({ id: "wrong" }), greetingTaskDir({ id: "lost" })], { implement }, { conditions: ["C0"] });

    const { dir, report } = await evaluate(suite);

    const text = formatReport(report);
    expect(text).toContain("[mock] These results come from the mock adapter. They are labelled [mock] and are not evidence.");
    expect(text).toContain("verified success: 1 of 2 scored trials (50%)");
    expect(text).toContain("constraint violations: 0 of 2 scored trials of tasks with planted constraints (0%)");
    expect(text).toContain("harness incidents (excluded, not failures): 1");
    expect(text).toContain("lost: attempt ");
    expect(text).toContain("This report draws no comparison between conditions.");
    expect(report.mock).toBe(true);
    // The same report is on disk, as data and as text.
    expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toBe(`${text}\n`);
  });

  it("says there is no rate when nothing was scored, rather than showing zero", async () => {
    const { report } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted({ ...GREETS, loseContact: true }) }, { conditions: ["C0"] }));

    const text = formatReport(report);
    expect(text).toContain("verified success: n/a: no scored trials");
    expect(text).toContain("constraint violations: n/a: no scored trials of tasks with planted constraints");
  });
});
