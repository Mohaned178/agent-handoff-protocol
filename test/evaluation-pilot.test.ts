// The pilot suite (ticket 23, `pilot/`): its tasks discriminate, its constraints are checked, and its suites freeze and run end to
// end. Everything here is the mock adapter's: scripted agents that make the reference edits are the pilot's test of itself,
// never a result about any coding agent.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mock, type MockAttemptScript } from "../src/index.ts";
import { loadTask, validateSuite, type EvaluationSuite, type EvaluationTask, type TrialSlot } from "../src/evaluation/index.ts";
import { evaluate, trialOf } from "./helpers/evaluation.ts";
import { removeTempRepos } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const PILOT = fileURLToPath(new URL("../pilot/", import.meta.url));
const TASKS_DIR = join(PILOT, "tasks");
const TASK_IDS = readdirSync(TASKS_DIR).sort();

interface Edit {
  path: string;
  content: string;
}

/** Every file under `dir`, by path relative to it with `/` separators. */
function filesUnder(dir: string, base = dir): Edit[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path, base) : [{ path: path.slice(base.length + 1).replaceAll("\\", "/"), content: readFileSync(path, "utf8") }];
  });
}

/** `edits` laid over `base`: a path in both takes the later content. */
const overlay = (base: Edit[], edits: Edit[]): Edit[] => [...new Map([...base, ...edits].map((edit) => [edit.path, edit])).values()];

/** What a task's reference material holds: the edits that solve it, and for each constraint, edits that break only it. */
function referenceOf(id: string) {
  const dir = join(PILOT, "reference", id);
  const violationsDir = join(dir, "violations");
  return {
    solution: filesUnder(join(dir, "solution")),
    violations: readdirSync(violationsDir).sort().map((constraint) => ({ constraint, edits: filesUnder(join(violationsDir, constraint)) })),
  };
}

const taskDir = (id: string) => join(TASKS_DIR, id);
const loadedTask = async (id: string) => (await loadTask(taskDir(id))).task;

async function pilotSuite(name: "suite-a" | "suite-b"): Promise<EvaluationSuite> {
  return ((await import(pathToFileURL(join(PILOT, `${name}.mjs`)).href)) as { default: EvaluationSuite }).default;
}

describe("the pilot's tasks", () => {
  it("are five to eight, each a valid task with a planted constraint, a seeded defect and hidden tests", async () => {
    expect(TASK_IDS.length).toBeGreaterThanOrEqual(5);
    expect(TASK_IDS.length).toBeLessThanOrEqual(8);
    for (const id of TASK_IDS) {
      const { task, hiddenTestsHash } = await loadTask(taskDir(id));
      expect(task.id).toBe(id);
      expect(task.constraints.length, `${id} constraints`).toBeGreaterThan(0);
      expect(task.seededDefects.length, `${id} seeded defects`).toBeGreaterThan(0);
      expect(task.hiddenTests.length, `${id} hidden tests`).toBeGreaterThan(0);
      expect(hiddenTestsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(task.verification.protectedPaths, `${id} protects package.json`).toContain("package.json");
      // No install: the network stance is deny, and a fixture has no dependencies.
      expect(task.verification.install).toBeUndefined();
      expect(task.network.stance).toBe("deny");
    }
  });

  it("keep every planted constraint and seeded defect out of the fixture, where later steps could read it", async () => {
    for (const id of TASK_IDS) {
      const task = await loadedTask(id);
      const fixture = [...task.fixture].map(([path, bytes]) => ({ path, text: bytes.toString("utf8") }));
      for (const { id: constraintId, statement } of task.constraints) {
        expect(task.prompt, `${id}/${constraintId} is stated in the prompt`).not.toContain(statement);
        expect(fixture.filter(({ text }) => text.includes(statement) || text.includes(constraintId)).map(({ path }) => path), `${id}/${constraintId}`).toEqual([]);
      }
      for (const defect of task.seededDefects) {
        expect(fixture.filter(({ text }) => text.includes(defect.description) || text.includes(defect.id)).map(({ path }) => path), `${id}/${defect.id}`).toEqual([]);
      }
    }
  });

  it("have a reference solution, and a violation for every planted constraint, that is a constraint of the task", async () => {
    for (const id of TASK_IDS) {
      const task = await loadedTask(id);
      const { solution, violations } = referenceOf(id);
      expect(solution.length, `${id} solution`).toBeGreaterThan(0);
      expect(violations.map((violation) => violation.constraint).sort(), id).toEqual(task.constraints.map((constraint) => constraint.id).sort());
    }
  });
});

describe("each task, scored by the validators on the mock adapter's reference edits", () => {
  for (const id of TASK_IDS) {
    it(`${id}: the untouched fixture fails its hidden tests, the solution passes them and breaks no constraint, and each violation passes but breaks its constraint`, async () => {
      const task = await loadedTask(id);
      const { solution, violations } = referenceOf(id);
      const variants: { name: string; edits: Edit[]; violated: string | null }[] = [
        { name: "fixture", edits: [], violated: null },
        { name: "solution", edits: solution, violated: null },
        ...violations.map(({ constraint, edits }) => ({ name: `violation of ${constraint}`, edits: overlay(solution, edits), violated: constraint })),
      ];
      const suite: EvaluationSuite = {
        name: `check-${id}`,
        tasks: [taskDir(id)],
        conditions: ["C0"],
        repeats: variants.length,
        agents: { implement: (_task: EvaluationTask, slot: TrialSlot) => mock({ attempts: [{ edits: variants[slot.repeat - 1]!.edits, outputFields: { summary: "done" } }] }) },
      };

      const { state, dir } = await evaluate(suite);

      expect(state.trials).toHaveLength(variants.length);
      for (const trial of state.trials) {
        const variant = variants[trial.repeat - 1]!;
        const ended = trial.ended!;
        expect(ended.outcome, variant.name).toBe("scored");
        const score = ended.score!;
        const evidence = JSON.parse(readFileSync(join(dir, ...ended.artifacts!.validation!.path.split("/")), "utf8")) as { tests: { exitCode: number; signal: string | null; output: string } };
        if (variant.name === "fixture") {
          // Failing because its tests fail, not because the command is missing: the runner's own count is in the output.
          expect(score.verdict).toBe("fail");
          expect(score.tests).toMatchObject({ ran: true, exitCode: 1 });
          expect(evidence.tests.output).toMatch(/fail [1-9]\d*/);
          expect(evidence.tests.signal).toBeNull();
        } else {
          expect(score.verdict, variant.name).toBe("pass");
          expect(evidence.tests.output, variant.name).toMatch(/fail 0/);
        }
        expect(score.protectedPathViolations, variant.name).toEqual([]);
        expect(
          Object.fromEntries(score.constraints.map((constraint) => [constraint.id, constraint.outcome])),
          variant.name,
        ).toEqual(Object.fromEntries(task.constraints.map((constraint) => [constraint.id, constraint.id === variant.violated ? "violated" : "held"])));
      }
    });
  }
});

describe("the pilot suites", () => {
  it("are valid, give each task 3 repeats of every condition, and cast the same three tools in different roles", async () => {
    const [a, b] = [await pilotSuite("suite-a"), await pilotSuite("suite-b")];

    for (const suite of [a, b]) {
      expect(validateSuite(suite)).toEqual([]);
      expect(suite.repeats).toBe(3);
      expect(suite.conditions).toBeUndefined(); // every condition, the matched-budget baseline included
      expect(suite.tasks.map((path) => path.replace("./tasks/", "")).sort()).toEqual(TASK_IDS);
    }
    const adapterOf = (suite: EvaluationSuite, role: "plan" | "implement" | "review") => (suite.agents[role] as { adapter: string }).adapter;
    for (const role of ["plan", "implement", "review"] as const) {
      expect(adapterOf(a, role), role).not.toBe(adapterOf(b, role));
      expect(["claude-code", "codex", "opencode"]).toContain(adapterOf(a, role));
    }
    expect(["plan", "implement", "review"].map((role) => adapterOf(a, role as "plan")).sort()).toEqual(["claude-code", "codex", "opencode"]);
    expect(["plan", "implement", "review"].map((role) => adapterOf(b, role as "plan")).sort()).toEqual(["claude-code", "codex", "opencode"]);
  });

  it("freeze, and schedule 3 repeats of 4 conditions on each task, once their workflows validate against the registered adapters", async () => {
    // Cancelled before the first trial: the suite is loaded, its tasks frozen, every workflow validated and the order recorded,
    // and no coding agent is started.
    const cancelled = new AbortController();
    cancelled.abort();

    for (const name of ["suite-a", "suite-b"] as const) {
      const { events, state } = await evaluate(await pilotSuite(name), { baseDir: PILOT, signal: cancelled.signal });

      expect(state.state).toBe("cancelled");
      expect(events.filter((event) => event.type === "task_frozen").map((event) => (event as { taskId: string }).taskId).sort()).toEqual(TASK_IDS);
      const scheduled = events.find((event) => event.type === "trials_scheduled") as { order: { taskId: string; condition: string; repeat: number }[] };
      expect(scheduled.order).toHaveLength(TASK_IDS.length * 4 * 3);
      for (const id of TASK_IDS) {
        for (const condition of ["C0", "C1", "C2", "C3"]) {
          expect(scheduled.order.filter((slot) => slot.taskId === id && slot.condition === condition).map((slot) => slot.repeat).sort(), `${id} ${condition}`).toEqual([1, 2, 3]);
        }
      }
    }
  });

  for (const id of TASK_IDS) {
    it(`run ${id} end to end under every condition on scripted mock agents, each scored by the validators as a pass`, async () => {
      const { solution } = referenceOf(id);
      const reports = (task: EvaluationTask) => ({
        summary: "done",
        decisions: ["follow the task"],
        constraints: task.constraints.map((constraint) => constraint.statement),
        output: "done",
      });
      const script = (...scripts: MockAttemptScript[]) => mock({ attempts: scripts });
      const suite: EvaluationSuite = {
        ...(await pilotSuite("suite-a")),
        tasks: [taskDir(id)],
        repeats: 1,
        agents: {
          plan: (task) => script({ outputFields: reports(task) }),
          implement: (task) => script({ edits: solution, outputFields: reports(task) }),
          review: () => script({ outputFields: { verdict: "approved", findings: ["nothing to change"], output: "approved" } }),
        },
      };

      const { state, report } = await evaluate(suite);

      expect(state.state).toBe("completed");
      expect(state.mock).toBe(true);
      // C0, C1, C2, C3, and the matched-budget baseline's one trial per attempt C3 made: plan, implement and review.
      expect(state.trials.map((trial) => trial.condition).sort()).toEqual(["C0", "C1", "C2", "C3", "baseline", "baseline", "baseline"]);
      for (const trial of state.trials) {
        expect(trial.ended, `${trial.condition}`).toMatchObject({ outcome: "scored", score: { verdict: "pass" } });
        expect(trial.ended!.score!.constraints.every((constraint) => constraint.outcome === "held"), trial.condition).toBe(true);
      }
      expect(report.conditions.map((condition) => [condition.condition, condition.passes, condition.scored])).toEqual([
        ["C0", 1, 1],
        ["C1", 1, 1],
        ["C2", 1, 1],
        ["C3", 1, 1],
      ]);
      expect(trialOf(state, "C3").ended!.runState).toBe("succeeded");
    });
  }
});
