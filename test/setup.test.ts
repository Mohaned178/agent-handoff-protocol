import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorReport, ToolReport } from "../src/doctor/index.ts";
import { validateSuite } from "../src/evaluation/index.ts";
import { validateWorkflow } from "../src/sdk/index.ts";
import { offeredByOpenCode, openCodeModelsIn, pathsIn, runSetup, slugOf, tasksUnder, type Choice, type ModelList, type Prompter } from "../src/setup/index.ts";

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
  const asked: { message: string; choices?: Choice<unknown>[]; default?: string }[] = [];
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
    input: async ({ message, validate, default: fallback }) => {
      const value = next(message) as string;
      asked.at(-1)!.default = fallback;
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
      "workflow", "example",
      "claude-code", "claude-code-model", "high", // plan
      "codex", null, null, // implement: the tool's own model and effort
      "opencode", [], "\u0000typed", "opencode/typed-free", // review: free models only, and a name typed in
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
    expect(asked[2]!.choices!.find((choice) => choice.value === "gemini-cli")).toMatchObject({ disabled: "not installed" });
  });

  it("never replaces a file: it asks for another name", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ahp.workflow.mjs"), "keep me\n");
    const { prompter, asked } = scripted(["workflow", "example", "mock", "mock", "mock", "ahp/x", "ahp.workflow.mjs", "other.mjs", false]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    expect(readFileSync(join(dir, "ahp.workflow.mjs"), "utf8")).toBe("keep me\n");
    expect(result.path).toBe(join(dir, "other.mjs"));
    expect(asked.some((question) => question.message.includes("already exists"))).toBe(true);
    expect(validateWorkflow(await load(result.path))).toEqual([]);
  });
});

describe("ahp setup: a task of your own", () => {
  type Step = { id: string; agent?: { adapter: string }; instructions?: string; verification?: Record<string, unknown>; capabilities?: unknown; review?: unknown; action?: { branch: string } };

  it("writes plan, implement verified by your command, review, gate and push, with the paths you allow, and offers no mock", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const { prompter, asked, left } = scripted([
      "workflow", "own",
      "Add a /health endpoint that returns 200 and the version",
      "npm test",
      "npm ci",
      " src/, .\\test\\api ,src ",
      "add-health-endpoint",
      "claude-code", null, null,
      "codex", null, null,
      "codex", null, null,
      "ahp/health",
      "flow.mjs",
      false,
    ]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    expect(left).toEqual([]);
    const workflow = (await load(result.path)) as { name: string; steps: Step[] };
    expect(validateWorkflow(workflow)).toEqual([]);
    expect(workflow.name).toBe("add-health-endpoint");
    expect(workflow.steps.map((step) => step.id)).toEqual(["plan", "implement", "review", "approve", "publish"]);
    const [plan, implement, review, , publish] = workflow.steps;
    expect(plan!.instructions).toContain("Add a /health endpoint that returns 200 and the version");
    expect(plan!.capabilities).toEqual([{ kind: "read_only" }]);
    expect(implement!.verification).toEqual({ command: "npm test", install: "npm ci", requiredOutputFields: ["summary"] });
    expect(implement!.capabilities).toEqual([{ kind: "write_scope", paths: ["src", "test/api"] }]);
    expect(implement!.instructions).toContain("The work is done when `npm test` passes. Change only src, test/api.");
    expect(review!.review).toEqual({ sendBackTo: "implement" });
    expect(publish!.action!.branch).toBe("ahp/health");
    expect(readFileSync(result.path, "utf8")).toContain("// add-health-endpoint: plan, implement (done when `npm test` passes)");
    // The defaults come from the repository: its test script and its lock file.
    const question = (start: string) => asked.find((q) => q.message.startsWith(start))!;
    expect(question("Who plans")!.choices!.some((choice) => choice.value === "mock")).toBe(false);
    expect([question("Command that checks").default, question("Command that installs").default]).toEqual(["npm test", "npm ci"]);
  });

  it("allows anywhere when no paths are given and leaves out an install that is blank", async () => {
    const dir = tempDir();
    const { prompter } = scripted(["workflow", "own", "Fix the typo in the README", "python -m pytest", "", "", "fix-typo", "codex", null, null, "codex", null, null, "codex", null, null, "ahp/fix-typo", "flow.mjs", false]);

    const result = await runSetup({ prompter, dir, report: everyTool, models });

    const implement = ((await load(result.path)) as { steps: Step[] }).steps[1]!;
    expect(implement.verification).toEqual({ command: "python -m pytest", requiredOutputFields: ["summary"] });
    expect(implement.capabilities).toBeUndefined();
  });

  it("refuses paths outside the repository and names it suggests from the task", async () => {
    const dir = tempDir();
    const { prompter } = scripted(["workflow", "own", "Do it", "npm test", "", "../elsewhere"]);

    await expect(runSetup({ prompter, dir, report: everyTool, models })).rejects.toThrow(/paths inside the repository, relative to its root, with no "\.\.": not \.\.\/elsewhere/);
    expect(slugOf("Add a /health endpoint, quickly!")).toBe("add-a-health-endpoint-quickly");
    expect(slugOf("!!!")).toBe("task");
    expect(pathsIn(" a/ , ./b\\c,a ")).toEqual(["a", "b/c"]);
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
      "opencode", ["providers"], "opencode-model",
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
  it("asks once what OpenCode access the person has and offers Zen's free models plus only the models of what they named", async () => {
    const dir = tempDir();
    const openCodeModels = async (): Promise<ModelList> => ({
      choices: [null, "opencode/glm-5.3-flash-free", "opencode/claude-sonnet-5-5", "opencode-go/kimi-k3", "openai/o3"].map((value) => ({ value, label: value ?? "default" })),
      source: "test",
    });
    const offered = (choices: Choice<unknown>[]) => choices.map((choice) => choice.value).filter((value) => value !== "\u0000typed");
    const { prompter, asked, left } = scripted([
      "workflow", "example",
      "opencode", ["go"], "opencode-go/kimi-k3", // plan
      "opencode", "opencode/glm-5.3-flash-free", // implement: not asked again
      "mock",
      "ahp/x",
      "flow.mjs",
      false,
    ]);

    const result = await runSetup({ prompter, dir, report: everyTool, models: openCodeModels });

    expect(left).toEqual([]);
    expect(asked.filter((question) => question.message.startsWith("Which OpenCode access"))).toHaveLength(1);
    const modelQuestions = asked.filter((question) => question.message.startsWith("Which model"));
    expect(modelQuestions.map((question) => offered(question.choices!))).toEqual([
      [null, "opencode/glm-5.3-flash-free", "opencode-go/kimi-k3"],
      [null, "opencode/glm-5.3-flash-free", "opencode-go/kimi-k3"],
    ]);
    const workflow = (await load(result.path)) as { steps: { id: string; agent?: unknown }[] };
    expect(workflow.steps.find((step) => step.id === "plan")!.agent).toEqual({ adapter: "opencode", model: "opencode-go/kimi-k3" });
  });

  it("offers each provider's models by the access named", () => {
    const names = ["opencode/big-pickle", "opencode/glm-5.3-flash-free", "opencode-go/kimi-k3", "openai/o3"];
    expect(names.filter((name) => offeredByOpenCode(name, []))).toEqual(["opencode/glm-5.3-flash-free"]);
    expect(names.filter((name) => offeredByOpenCode(name, ["zen"]))).toEqual(["opencode/big-pickle", "opencode/glm-5.3-flash-free"]);
    expect(names.filter((name) => offeredByOpenCode(name, ["go", "providers"]))).toEqual(["opencode/glm-5.3-flash-free", "opencode-go/kimi-k3", "openai/o3"]);
  });

  it("reads OpenCode's own list, one provider/model per line, ignoring anything else it prints", () => {
    expect(openCodeModelsIn("opencode/big-pickle\r\nopencode/deepseek-v4.1-flash-free\n\nWARN something\nopencode/big-pickle\n")).toEqual([
      "opencode/big-pickle",
      "opencode/deepseek-v4.1-flash-free",
    ]);
  });
});
