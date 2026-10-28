import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorReport, ToolReport } from "../src/doctor/index.ts";
import { validateSuite } from "../src/evaluation/index.ts";
import { validateWorkflow } from "../src/sdk/index.ts";
import { openCodeModelsIn, runSetup, tasksUnder, type Choice, type ModelList, type Prompter } from "../src/setup/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ahp-setup-"));
  dirs.push(dir);
  return dir;
};

type Answer = unknown | ((choices: Choice<unknown>[]) => unknown);

/** Answers each question in turn, and keeps what was asked and said. An answer for a menu may pick by the choices. */
function scripted(answers: Answer[]) {
  const asked: { message: string; choices?: Choice<unknown>[] }[] = [];
  const said: string[] = [];
  const next = (message: string, choices?: Choice<unknown>[]) => {
    asked.push({ message, choices });
    if (answers.length === 0) throw new Error(`no scripted answer for "${message}"`);
    const answer = answers.shift();
    return typeof answer === "function" ? (answer as (c: Choice<unknown>[]) => unknown)(choices ?? []) : answer;
  };
  const prompter: Prompter = {
    select: async ({ message, choices }) => next(message, choices as Choice<unknown>[]) as never,
    checkbox: async ({ message, choices }) => next(message, choices as Choice<unknown>[]) as never,
    input: async ({ message, validate }) => {
      const value = next(message) as string;
      const verdict = validate?.(value) ?? true;
      if (verdict !== true) throw new Error(`"${value}" refused for "${message}": ${verdict}`);
      return value;
    },
    confirm: async ({ message }) => next(message) as boolean,
    say: (text) => said.push(text),
  };
  return { prompter, asked, said, left: answers };
}

const tool = (id: ToolReport["id"], changes: Partial<ToolReport> = {}): ToolReport =>
  ({
    id,
    name: id,
    command: id,
    installed: true,
    path: `/bin/${id}`,
    version: "1.0.0",
    problem: null,
    login: { state: "logged_in", detail: "" },
    paidAccess: null,
    adapter: { name: id, levels: {} },
    usable: true,
    ...changes,
  }) as ToolReport;

const report = (tools: ToolReport[]): DoctorReport => ({ tools }) as unknown as DoctorReport;

const everyTool = report([tool("claude-code"), tool("codex"), tool("opencode"), tool("gemini-cli", { installed: false, usable: false })]);

const models = async (id: string): Promise<ModelList> => ({
  choices: [{ value: null, label: "default" }, { value: `${id}-model`, label: `${id}-model` }],
  source: "test",
});

const load = async (path: string) => ((await import(`${pathToFileURL(path).href}?${Date.now()}`)) as { default: unknown }).default;

describe("ahp setup: a workflow", () => {
  it("writes the reference workflow with the tool and model chosen for each step, valid, and does not start it unless asked", async () => {
    const dir = tempDir();
    const { prompter, asked, left } = scripted([
      "workflow",
      "claude-code", "claude-code-model", "high", // plan
      "codex", null, null, // implement: the tool's own model and effort
      "opencode", "\u0000typed", "opencode/typed-free", // review: a name typed in
      "ahp/reset",
      "flow.mjs",
      false,
    ]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    expect(left).toEqual([]);
    expect(result).toEqual({ kind: "workflow", path: join(dir, "flow.mjs"), start: false });
    const workflow = (await load(result.path)) as { steps: { id: string; agent?: unknown; action?: { branch: string } }[] };
    expect(validateWorkflow(workflow)).toEqual([]);
    const agent = (id: string) => workflow.steps.find((step) => step.id === id)!.agent;
    expect(agent("plan")).toEqual({ adapter: "claude-code", model: "claude-code-model", options: { effort: "high" } });
    expect(agent("implement")).toEqual({ adapter: "codex" });
    expect(agent("review")).toEqual({ adapter: "opencode", model: "opencode/typed-free" });
    expect(workflow.steps.find((step) => step.id === "publish")!.action!.branch).toBe("ahp/reset");
    expect(readFileSync(result.path, "utf8")).toContain("Written by `ahp setup`");
    expect(readFileSync(result.path, "utf8")).toContain("plan      claude-code, model claude-code-model, effort high");
    // OpenCode's adapter has no effort option, so none is asked for it.
    expect(asked.filter((question) => question.message.startsWith("Which effort")).map((question) => question.message.split(" ")[3])).toEqual(["plan?", "implement?"]);
    // A tool that cannot be used is shown with the reason and cannot be picked.
    expect(asked[1]!.choices!.find((choice) => choice.value === "gemini-cli")).toMatchObject({ disabled: "not installed" });
  });

  it("never replaces a file: it asks for another name", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ahp.workflow.mjs"), "keep me\n");
    const { prompter, asked } = scripted(["workflow", "mock", "mock", "mock", "ahp/x", "ahp.workflow.mjs", "other.mjs", false]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    expect(readFileSync(join(dir, "ahp.workflow.mjs"), "utf8")).toBe("keep me\n");
    expect(result.path).toBe(join(dir, "other.mjs"));
    expect(asked.some((question) => question.message.includes("already exists"))).toBe(true);
    expect(validateWorkflow(await load(result.path))).toEqual([]);
  });
});

describe("ahp setup: an evaluation", () => {
  const withTasks = () => {
    const dir = tempDir();
    for (const name of ["password-reset", "csv-export"]) {
      mkdirSync(join(dir, "pilot", "tasks", name), { recursive: true });
      writeFileSync(join(dir, "pilot", "tasks", name, "task.json"), "{}");
    }
    return dir;
  };

  it("finds the pilot's tasks, asks for the roles its conditions need, and writes a valid suite", async () => {
    const dir = withTasks();
    expect(tasksUnder(dir)).toEqual(["./pilot/tasks/csv-export", "./pilot/tasks/password-reset"]);
    const { prompter, asked, left } = scripted([
      "evaluation",
      (choices: Choice<unknown>[]) => choices.filter((choice) => choice.checked).map((choice) => choice.value), // the default: password-reset
      ["C0", "C3"],
      "claude-code", null, "low",
      "claude-code", "claude-code-model", null,
      "opencode", "opencode-model",
      "2",
      "3",
      "smoke.mjs",
      true,
    ]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    expect(left).toEqual([]);
    expect(result).toEqual({ kind: "evaluation", path: join(dir, "smoke.mjs"), start: true });
    const suite = await load(result.path);
    expect(validateSuite(suite)).toEqual([]);
    expect(suite).toEqual({
      name: "smoke",
      tasks: ["./pilot/tasks/password-reset"],
      conditions: ["C0", "C3"],
      agents: { plan: { adapter: "claude-code", options: { effort: "low" } }, implement: { adapter: "claude-code", model: "claude-code-model" }, review: { adapter: "opencode", model: "opencode-model" } },
      repeats: 2,
      spendCap: { amount: 3, currency: "USD" },
    });
    // The mock has no script for a task, so it is not offered for an evaluation.
    expect(asked[3]!.choices!.some((choice) => choice.value === "mock")).toBe(false);
  });

  it("asks only for the implement agent when C0 alone runs, re-asks a baseline without C3, and takes no cap when blank", async () => {
    const dir = withTasks();
    const { prompter, said } = scripted(["evaluation", ["./pilot/tasks/csv-export"], ["baseline"], ["C0"], "codex", null, "medium", "1", "", "ahp.suite.mjs", false]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    expect(said.some((text) => text.includes("needs C3"))).toBe(true);
    expect(await load(result.path)).toEqual({ name: "ahp.suite", tasks: ["./pilot/tasks/csv-export"], conditions: ["C0"], agents: { implement: { adapter: "codex", options: { effort: "medium" } } }, repeats: 1 });
  });
});

describe("the models offered", () => {
  it("reads OpenCode's own list, one provider/model per line, ignoring anything else it prints", () => {
    expect(openCodeModelsIn("opencode/big-pickle\r\nopencode/deepseek-v4.1-flash-free\n\nWARN something\nopencode/big-pickle\n")).toEqual([
      "opencode/big-pickle",
      "opencode/deepseek-v4.1-flash-free",
    ]);
  });
});
