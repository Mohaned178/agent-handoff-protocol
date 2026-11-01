import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractCode,
  failureDetail,
  loadPrompts,
  loadToolCases,
  QUALITY_OUTCOMES,
  requestsOf,
  scheduleOf,
  scoreQuality,
  scoreToolCall,
  settingsOf,
  TOOL_OUTCOMES,
  validateBench,
  validateToolCase,
  workersOf,
  type BenchFile,
  type StreamedToolCall,
} from "../src/inference/index.ts";
import { removeTempRepos, writeTree } from "./helpers/repo.ts";

afterEach(removeTempRepos);

const FENCE = "```";
const fenced = (code: string, lang = "js") => `Here you go:\n${FENCE}${lang}\n${code}${FENCE}\nHope that helps.\n`;

describe("the closed lists", () => {
  it("name every outcome a scored answer can have", () => {
    expect(QUALITY_OUTCOMES).toEqual(["pass", "fail", "no_code", "timed_out"]);
    expect(TOOL_OUTCOMES).toEqual(["valid_call", "wrong_tool", "bad_arguments", "no_call", "malformed"]);
  });
});

describe("which code block of an answer is tested", () => {
  const table: [string, string, string | null][] = [
    ["a js block", fenced("export const a = 1;\n"), "export const a = 1;\n"],
    ["a block with no language", fenced("export const a = 1;\n", ""), "export const a = 1;\n"],
    ["javascript, mjs and node count as JavaScript", fenced("let b;\n", "javascript"), "let b;\n"],
    ["the language is not case sensitive", fenced("let c;\n", "JS"), "let c;\n"],
    ["a Python block is not code to test", fenced("print(1)\n", "python"), null],
    ["a JSON block before a js block is skipped", `${fenced('{"a":1}\n', "json")}\n${fenced("let d;\n")}`, "let d;\n"],
    ["the first of two JavaScript blocks", `${fenced("let first;\n")}\n${fenced("let second;\n")}`, "let first;\n"],
    ["text only", "Sure, I would write a function that adds.", null],
    ["an empty string", "", null],
    ["Windows line endings", `${FENCE}js\r\nlet e;\r\n${FENCE}\r\n`, "let e;\n"],
    ["a block the answer never closes is taken as far as it goes", `${FENCE}js\nexport function f() {\n  return 1`, "export function f() {\n  return 1\n"],
    ["a fence with extra words after the language", `${FENCE}js title="solution.mjs"\nlet f;\n${FENCE}\n`, "let f;\n"],
  ];
  it.each(table)("%s", (_name, text, expected) => {
    expect(extractCode(text)?.code ?? null).toBe(expected);
  });

  it("says whether the block was closed", () => {
    expect(extractCode(fenced("x\n"))?.closed).toBe(true);
    expect(extractCode(`${FENCE}js\nx`)?.closed).toBe(false);
  });
});

const call = (name: string | null, args: string, id = "call_1"): StreamedToolCall => ({ id, name, arguments: args });
const expectCall = { name: "get_weather", arguments: { city: "Lisbon", unit: "celsius" } };

describe("scoring a tool call", () => {
  const table: [string, StreamedToolCall[], string, string | null][] = [
    ["the expected call", [call("get_weather", '{"city":"Lisbon","unit":"celsius"}')], "valid_call", null],
    ["extra arguments are allowed", [call("get_weather", '{"city":"Lisbon","unit":"celsius","days":3}')], "valid_call", null],
    ["no call at all", [], "no_call", null],
    ["another tool", [call("read_file", '{"path":"a"}')], "wrong_tool", "called read_file, expected get_weather"],
    ["an argument missing", [call("get_weather", '{"city":"Lisbon"}')], "bad_arguments", "argument unit is missing"],
    ["an argument with another value", [call("get_weather", '{"city":"Porto","unit":"celsius"}')], "bad_arguments", 'city is "Porto", expected "Lisbon"'],
    ["a value of another type", [call("get_weather", '{"city":"Lisbon","unit":1}')], "bad_arguments", "unit is 1"],
    ["arguments that are not JSON", [call("get_weather", '{"city":"Lisbon",')], "malformed", "arguments are not JSON"],
    ["arguments that are JSON but not an object", [call("get_weather", '["Lisbon"]')], "malformed", "not a JSON object"],
    ["a call with no name", [call(null, "{}")], "malformed", "no name"],
    ["a wrong tool with unreadable arguments is malformed: the call is not readable as a call", [call("read_file", "{")], "malformed", "arguments are not JSON"],
    ["the first call is the one scored", [call("get_weather", '{"city":"Lisbon","unit":"celsius"}'), call("read_file", '{"path":"a"}', "call_2")], "valid_call", "2 calls; the first is scored"],
    ["a wrong first call is not rescued by a later right one", [call("read_file", '{"path":"a"}'), call("get_weather", '{"city":"Lisbon","unit":"celsius"}', "call_2")], "wrong_tool", "2 calls"],
  ];
  it.each(table)("%s", (_name, calls, outcome, detail) => {
    const scored = scoreToolCall(calls, expectCall);
    expect(scored.outcome).toBe(outcome);
    if (detail === null) expect(scored.detail).toBeNull();
    else expect(scored.detail).toContain(detail);
  });

  it("treats an empty arguments text as no arguments, which matter only if some are expected", () => {
    expect(scoreToolCall([call("run_tests", "")], { name: "run_tests", arguments: {} }).outcome).toBe("valid_call");
    expect(scoreToolCall([call("run_tests", "")], { name: "run_tests", arguments: { pattern: "auth" } }).outcome).toBe("bad_arguments");
  });

  it("compares nested values deeply", () => {
    const expected = { name: "create_issue", arguments: { title: "t", labels: ["bug", "safari"] } };
    expect(scoreToolCall([call("create_issue", '{"title":"t","labels":["bug","safari"]}')], expected).outcome).toBe("valid_call");
    expect(scoreToolCall([call("create_issue", '{"title":"t","labels":["safari","bug"]}')], expected).outcome).toBe("bad_arguments");
  });

  it("keeps a long detail to 300 characters", () => {
    const scored = scoreToolCall([call("get_weather", `{"city":"${"x".repeat(1000)}","unit":"celsius"}`)], expectCall);
    expect(scored.detail!.length).toBeLessThanOrEqual(300);
  });
});

describe("tool-call cases", () => {
  const weather = { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } };
  const valid = { prompt: "weather?", tools: [weather], expect: { name: "get_weather", arguments: { city: "x" } } };

  it("accepts a case, and refuses the shapes that cannot be scored", () => {
    expect(validateToolCase(valid)).toEqual([]);
    expect(validateToolCase({ ...valid, prompt: "" })).toEqual([expect.stringContaining("`prompt`")]);
    expect(validateToolCase({ ...valid, tools: [] })).toEqual([expect.stringContaining("`tools`")]);
    expect(validateToolCase({ ...valid, extra: 1 })).toEqual([expect.stringContaining("unknown property `extra`")]);
    expect(validateToolCase({ ...valid, expect: { name: "nope", arguments: {} } })).toEqual([expect.stringContaining("is not the name of any of the case's tools")]);
    expect(validateToolCase({ ...valid, expect: { name: "get_weather" } })).toEqual([expect.stringContaining("`expect.arguments`")]);
  });

  it("reads every <id>.json sorted, with the hash of its bytes, and names each problem", async () => {
    const dir = writeTree({ "b.json": JSON.stringify(valid), "a.json": JSON.stringify(valid), "bad.json": "{ nope", "worse.json": JSON.stringify({ prompt: "" }), "notes.txt": "ignored" });
    const { cases, problems } = await loadToolCases(dir);
    expect(cases.map((c) => c.id)).toEqual(["a", "b"]);
    expect(cases[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("tool-call case bad: bad.json is not JSON"), expect.stringContaining("tool-call case worse:")]));
  });

  it("is a problem to have no case, or no directory", async () => {
    expect((await loadToolCases(writeTree({ "README.md": "x" }))).problems).toEqual([expect.stringContaining("holds no <id>.json")]);
    expect((await loadToolCases(join(writeTree({}), "missing"))).problems).toEqual([expect.stringContaining("cannot read the tool-call cases directory")]);
  });
});

describe("scoring code by its tests", () => {
  const test = `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "./solution.mjs";\ntest("adds", () => assert.equal(add(2, 3), 5));\n`;

  it("passes an answer whose code passes the test", async () => {
    const result = await scoreQuality(fenced("export function add(a, b) { return a + b; }\n"), test);
    expect(result.problem).toBeNull();
    expect(result.score).toMatchObject({ outcome: "pass", detail: null });
    expect(result.score!.codeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails an answer whose code fails the test, with the first failing line", async () => {
    const result = await scoreQuality(fenced("export function add(a, b) { return a - b; }\n"), test);
    expect(result.score?.outcome).toBe("fail");
    expect(result.score?.detail).toContain("not ok");
    expect(result.score?.detail?.length).toBeLessThanOrEqual(300);
  });

  it("fails code that does not even load", async () => {
    expect((await scoreQuality(fenced("export function add(a, b) { return a + ; }\n"), test)).score?.outcome).toBe("fail");
    expect((await scoreQuality(fenced("module.exports = { add: (a, b) => a + b };\n"), test)).score?.outcome).toBe("fail");
  });

  it("is no_code for an answer with no JavaScript block, and runs nothing", async () => {
    const result = await scoreQuality("I would use a for loop.", test);
    expect(result.score).toEqual({ outcome: "no_code", detail: null, codeSha256: null });
  });

  it("is timed_out when the tests outlive the limit, and stops them", async () => {
    const started = Date.now();
    const result = await scoreQuality(fenced("export function add() { return 0; }\nawait new Promise(() => setInterval(() => {}, 1000));\n"), test, { timeoutMs: 400 });
    expect(result.score?.outcome).toBe("timed_out");
    expect(result.score?.detail).toContain("400 ms");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("runs an unclosed block and says so when the engine cut the answer off", async () => {
    const result = await scoreQuality(`${FENCE}js\nexport function add(a, b) {\n  return a +`, test, { finishReason: "length" });
    expect(result.score?.outcome).toBe("fail");
    expect(result.score?.detail).toContain("cut off at max_tokens");
  });

  it("an answer that passes although it was cut after its code keeps the note", async () => {
    const result = await scoreQuality(`${FENCE}js\nexport function add(a, b) { return a + b; }\n`, test, { finishReason: "length" });
    expect(result.score).toMatchObject({ outcome: "pass", detail: expect.stringContaining("cut off") });
  });

  it("gives a problem, not a verdict, when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await scoreQuality(fenced("export function add(a, b) { return a + b; }\n"), test, { signal: controller.signal });
    expect(result).toEqual({ score: null, problem: "cancelled while the tests ran" });
  });

  it("reads the failing line from node's TAP output, or the last line when there is none", () => {
    expect(failureDetail("TAP version 13\nnot ok 1 - adds\n  ---\n  error: 'boom'\n  ...\n")).toBe("not ok 1 - adds | error: 'boom'");
    expect(failureDetail("something\nlast line\n")).toBe("last line");
    expect(failureDetail("")).toBeNull();
  });
});

describe("the workloads that are not throughput send each id once, one at a time", () => {
  const unit = (workload: "latency" | "throughput" | "quality" | "tools", concurrency: number) => ({ workload, concurrency, prompts: ["a", "b", "c"] });

  it("cycles only throughput", () => {
    expect(requestsOf(unit("throughput", 2))).toHaveLength(8);
    for (const workload of ["latency", "quality", "tools"] as const) expect(requestsOf(unit(workload, 4))).toEqual(["a", "b", "c"]);
  });

  it("gives only throughput more than one worker", () => {
    expect(workersOf(unit("throughput", 4))).toBe(4);
    for (const workload of ["latency", "quality", "tools"] as const) expect(workersOf(unit(workload, 4))).toBe(1);
  });

  it("schedules quality and tools once per repeat at concurrency 1, tools over the cases and the others over the prompts", () => {
    const settings = settingsOf({ name: "n", engines: [], prompts: "p", workloads: ["latency", "throughput", "quality", "tools"], concurrency: [1, 2, 4], repeats: 2 } as BenchFile, 50);
    const schedule = scheduleOf(["vllm"], settings, { prompts: ["p1", "p2"], tools: ["t1", "t2", "t3"] }, 7);
    const of = (workload: string) => schedule.filter((unit) => unit.workload === workload);
    expect(of("quality")).toHaveLength(2);
    expect(of("tools")).toHaveLength(2);
    expect(of("throughput")).toHaveLength(6);
    for (const unit of [...of("quality"), ...of("tools"), ...of("latency")]) expect(unit.concurrency).toBe(1);
    for (const unit of of("tools")) expect([...unit.prompts].sort()).toEqual(["t1", "t2", "t3"]);
    for (const unit of of("quality")) expect([...unit.prompts].sort()).toEqual(["p1", "p2"]);
  });

  it("leaves the order of a bench with only latency and throughput what it was", () => {
    const settings = settingsOf({ name: "n", engines: [], prompts: "p" }, 50);
    expect(settings.workloads).toEqual(["latency", "throughput"]);
    const a = scheduleOf(["vllm", "sglang"], settings, { prompts: ["p1", "p2"], tools: [] }, 7);
    const b = scheduleOf(["vllm", "sglang"], settings, { prompts: ["p1", "p2"], tools: ["ignored"] }, 7);
    expect(b).toEqual(a);
  });
});

describe("the bench file with the new workloads", () => {
  const engines = [{ engine: "vllm", baseURL: "http://localhost:8001/v1", model: "m", quantization: "awq" }];
  it("names quality and tools as workloads, and needs a tools directory for the second", () => {
    expect(validateBench({ name: "b", engines, prompts: "p", workloads: ["quality"] })).toEqual([]);
    expect(validateBench({ name: "b", engines, prompts: "p", workloads: ["tools"], tools: "t" })).toEqual([]);
    expect(validateBench({ name: "b", engines, prompts: "p", workloads: ["tools"] })).toEqual([expect.stringContaining("the `tools` workload needs `tools`")]);
    expect(validateBench({ name: "b", engines, prompts: "p", tools: "" })).toEqual([expect.stringContaining("`tools` must be")]);
  });
});

describe("reading a prompt's test", () => {
  it("reads test.mjs beside prompt.md with its hash, and null where there is none", async () => {
    const dir = writeTree({ "a/prompt.md": "Write a.\n", "a/test.mjs": "// test a\n", "b/prompt.md": "Write b.\n" });
    const { prompts, problems } = await loadPrompts(dir);
    expect(problems).toEqual([]);
    expect(prompts.map((p) => [p.id, p.test?.text ?? null])).toEqual([["a", "// test a\n"], ["b", null]]);
    expect(prompts[0]!.test!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// The shipped bench: the maintainer's real run is the first time the engines see it, so everything that can be checked
// without a GPU is checked here.
describe("the shipped bench (bench/)", () => {
  const root = fileURLToPath(new URL("../bench/", import.meta.url));

  it("has a local bench file that is valid and finds every prompt and tool case it names", async () => {
    const local = ((await import(pathToFileURL(join(root, "local.mjs")).href)) as { default: BenchFile }).default;
    expect(validateBench(local)).toEqual([]);
    expect(local.engines.map((e) => e.engine)).toEqual(["ollama", "vllm", "sglang", "tensorrt_llm"]);
    expect(local.workloads).toEqual(["latency", "throughput", "quality", "tools"]);
    const prompts = await loadPrompts(join(root, local.prompts));
    const cases = await loadToolCases(join(root, local.tools!));
    expect([...prompts.problems, ...cases.problems]).toEqual([]);
    expect(prompts.prompts.every((prompt) => prompt.test !== null)).toBe(true);
    expect(prompts.prompts.length).toBeGreaterThanOrEqual(6);
    expect(cases.cases.length).toBeGreaterThanOrEqual(4);
    expect(dirname(root)).not.toBe(root);
  });

  it("names the ports and containers of bench/engines/", async () => {
    const local = ((await import(pathToFileURL(join(root, "local.mjs")).href)) as { default: BenchFile }).default;
    const ports = Object.fromEntries(local.engines.map((e) => [e.engine, new URL(e.baseURL).port]));
    expect(ports).toEqual({ ollama: "11434", vllm: "8001", sglang: "8002", tensorrt_llm: "8003" });
    for (const entry of local.engines.filter((e) => e.container)) expect(readFileSync(join(root, "engines", `${entry.engine === "tensorrt_llm" ? "tensorrt-llm" : entry.engine}.yml`), "utf8")).toContain(`container_name: ${entry.container}`);
  });

  const ids = readdirSync(join(root, "prompts"));
  it.each(ids)("prompt %s: its reference solution passes its tests, and a stub that exports nothing useful fails", async (id) => {
    const test = readFileSync(join(root, "prompts", id, "test.mjs"), "utf8");
    const reference = readFileSync(join(root, "reference", id, "solution.mjs"), "utf8");
    const passed = await scoreQuality(fenced(reference), test);
    expect(passed.problem).toBeNull();
    expect(passed.score?.outcome, passed.score?.detail ?? "").toBe("pass");
    const name = /export (?:function|class) (\w+)/.exec(reference)![1]!;
    const stubbed = await scoreQuality(fenced(`export function ${name}() { return undefined; }\n`), test);
    expect(stubbed.score?.outcome).toBe("fail");
    expect(readFileSync(join(root, "prompts", id, "prompt.md"), "utf8")).toContain(`exports \`${name}\``);
  });

  it("has tool cases a correct call scores valid_call on, and an empty answer no_call on", async () => {
    const { cases } = await loadToolCases(join(root, "tools"));
    for (const c of cases) {
      expect(scoreToolCall([call(c.expect.name, JSON.stringify(c.expect.arguments))], c.expect).outcome, c.id).toBe("valid_call");
      expect(scoreToolCall([], c.expect).outcome, c.id).toBe("no_call");
    }
  });
});
