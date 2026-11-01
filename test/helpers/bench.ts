// Shared by the bench's tests: a tiny prompt set with real tests, tool-call cases, and fake engines that answer them rightly or
// wrongly. Nothing here is a measurement of any engine.

import { join } from "node:path";
import type { BenchEngine, BenchEvent, BenchEventBody, BenchFile, BenchView } from "../../src/inference/index.ts";
import { runBench } from "../../src/inference/index.ts";
import { readCheckedLedger } from "../../src/ledger/index.ts";
import type { FakeChat, FakeEngine, FakeEngineScript } from "./fake-engine.ts";
import { startFakeEngine } from "./fake-engine.ts";
import { installFakeDocker, installFakeNvidiaSmi } from "./fake-gpu.ts";
import { fakeToolsDir, pathWithFakes } from "./fake-tools.ts";
import { writeTree } from "./repo.ts";

const FENCE = "```";

/** id → [function, what `fn(6, 3)` must give, the expression a correct answer returns]. */
export const FUNCTIONS: Record<string, [string, number, string]> = {
  add: ["add", 9, "a + b"],
  sub: ["sub", 3, "a - b"],
  mul: ["mul", 18, "a * b"],
};

const testOf = (fn: string, expected: number) =>
  `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ${fn} } from "./solution.mjs";\ntest("${fn}", () => assert.equal(${fn}(6, 3), ${expected}));\n`;

/**
 * The files of three prompts with a test each, under `prefix`; `extra` files are added last, so they replace a file of the same
 * name. The prompt text carries `ID:<id>`, which the fake engines answer by.
 */
export function promptFiles(extra: Record<string, string> = {}, prefix = ""): Record<string, string> {
  const files: Record<string, string> = { [`${prefix}README.md`]: "not a prompt\n" };
  for (const [id, [fn, expected]] of Object.entries(FUNCTIONS)) {
    files[`${prefix}${id}/prompt.md`] = `Write ${fn}(a, b). ID:${id}\n`;
    files[`${prefix}${id}/test.mjs`] = testOf(fn, expected);
  }
  return { ...files, ...Object.fromEntries(Object.entries(extra).map(([path, text]) => [`${prefix}${path}`, text])) };
}

export const promptsDir = (extra: Record<string, string> = {}): string => writeTree(promptFiles(extra));

const weather = { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const readFile = { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };

export const TOOL_CASES: Record<string, { prompt: string; tools: unknown[]; expect: { name: string; arguments: Record<string, unknown> } }> = {
  weather: { prompt: "Weather in Lisbon? CASE:weather", tools: [weather, readFile], expect: { name: "get_weather", arguments: { city: "Lisbon" } } },
  files: { prompt: "Read src/a.js. CASE:files", tools: [readFile, weather], expect: { name: "read_file", arguments: { path: "src/a.js" } } },
};

export const toolCaseFiles = (prefix = ""): Record<string, string> => Object.fromEntries(Object.entries(TOOL_CASES).map(([id, c]) => [`${prefix}${id}.json`, JSON.stringify(c)]));

export const toolCasesDir = (): string => writeTree(toolCaseFiles());

/** Which prompt or tool-call case a request is for, from the `ID:` or `CASE:` in its message. */
export const askedOf = (body: Record<string, unknown>): { kind: "prompt" | "case"; id: string } => {
  const text = String((body.messages as { content: string }[])[0]!.content);
  const found = /CASE:(\w+)/.exec(text);
  return found ? { kind: "case", id: found[1]! } : { kind: "prompt", id: /ID:([\w-]+)/.exec(text)?.[1] ?? "" };
};

export interface Behaviour {
  /** Prompt ids answered with a wrong solution. */
  wrong?: string[];
  /** Prompt ids answered with text and no code block. */
  noCode?: string[];
  /** Tool-call case ids answered with another tool. */
  wrongTool?: string[];
  /** Tool-call case ids answered with text and no call. */
  noCall?: string[];
  /** Ids answered with this HTTP status. */
  fail?: Record<string, number>;
  /** Added before every first chunk. */
  delayMs?: number;
}

/** What a fake engine answers: right by default, wrong where `behaviour` says. */
export function answerOf(body: Record<string, unknown>, behaviour: Behaviour = {}): FakeChat {
  const asked = askedOf(body);
  const status = behaviour.fail?.[asked.id];
  if (status !== undefined) return { status, body: "scripted failure" };
  const delayMs = behaviour.delayMs ?? 0;
  if (asked.kind === "case") {
    const expected = TOOL_CASES[asked.id]!.expect;
    if (behaviour.noCall?.includes(asked.id)) return { chunks: [{ delayMs, content: "I would look it up." }], usage: { prompt_tokens: 20, completion_tokens: 5 } };
    const name = behaviour.wrongTool?.includes(asked.id) ? "other_tool" : expected.name;
    const args = JSON.stringify(expected.arguments);
    return { chunks: [{ delayMs, toolCall: { id: "call_1", name, arguments: args.slice(0, 5) } }, { delayMs, toolCall: { arguments: args.slice(5) } }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
  }
  const [fn, , expression] = FUNCTIONS[asked.id] ?? ["f", 0, "0"];
  if (behaviour.noCode?.includes(asked.id)) return { chunks: [{ delayMs, content: "Use a loop." }], usage: { prompt_tokens: 20, completion_tokens: 4 } };
  const body_ = behaviour.wrong?.includes(asked.id) ? "return 0;" : `return ${expression};`;
  return { chunks: [{ delayMs, content: `${FENCE}js\nexport function ${fn}(a, b) { ${body_} }\n${FENCE}\n` }], usage: { prompt_tokens: 20, completion_tokens: 12 } };
}

const engines: FakeEngine[] = [];
export async function fakeEngine(script: FakeEngineScript): Promise<FakeEngine> {
  const engine = await startFakeEngine(script);
  engines.push(engine);
  return engine;
}
export async function closeEngines(): Promise<void> {
  for (const engine of engines.splice(0)) await engine.close();
}

/** Fake `nvidia-smi` and `docker` on PATH unless left out; nothing else is found there, so a real `nvidia-smi` never runs. */
export async function toolsEnv(tools: { gpu?: boolean; docker?: boolean } = {}): Promise<NodeJS.ProcessEnv> {
  const { dir, log } = fakeToolsDir();
  if (tools.gpu ?? true) installFakeNvidiaSmi(dir, log);
  if (tools.docker ?? true) installFakeDocker(dir, log);
  return pathWithFakes(dir);
}

export const engineAt = (engine: BenchEngine["engine"], baseURL: string, extra: Partial<BenchEngine> = {}): BenchEngine => ({ engine, baseURL, model: "fake-model", quantization: "awq", ...extra });

export function benchOf(entries: BenchEngine[], prompts: string, extra: Partial<BenchFile> = {}): BenchFile {
  return { name: "test bench", engines: entries, prompts, concurrency: [1, 2], repeats: 1, maxTokens: 64, warmup: 0, timeoutMs: 10_000, ...extra };
}

/** Runs a bench into a fresh directory and reads its ledger back. */
export async function bench(file: BenchFile, options: { env?: NodeJS.ProcessEnv; seed?: number; engine?: BenchEngine["engine"]; signal?: AbortSignal; baseDir?: string; onEvent?: (event: BenchEvent, view: Readonly<BenchView>) => void } = {}) {
  const out = writeTree({});
  const result = await runBench(file, { out, env: options.env ?? (await toolsEnv()), seed: options.seed ?? 7, sampleIntervalMs: 50, engine: options.engine, signal: options.signal, baseDir: options.baseDir, onEvent: options.onEvent });
  const { events } = await readCheckedLedger<BenchEventBody>(join(result.dir, "ledger.jsonl"));
  return { ...result, out, events };
}

export const endedOf = (events: readonly BenchEvent[], workload: string) => events.filter((event) => event.type === "workload_ended" && event.workload === workload) as Extract<BenchEvent, { type: "workload_ended" }>[];
