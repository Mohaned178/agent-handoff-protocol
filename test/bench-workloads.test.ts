import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchInvalidError, NOT_SCORED_CANCELLED, replayBench, reportOf, runBench, scoreWorkload } from "../src/inference/index.ts";
import { answerOf, askedOf, bench, benchOf, closeEngines, endedOf, engineAt, fakeEngine, promptsDir, toolCasesDir, toolsEnv, type Behaviour } from "./helpers/bench.ts";
import { removeTempRepos, writeTree } from "./helpers/repo.ts";

afterEach(async () => {
  await closeEngines();
  removeTempRepos();
});

const run = async (behaviour: Behaviour = {}, extra: Parameters<typeof benchOf>[2] = {}) => {
  const engine = await fakeEngine({ chat: (body) => answerOf(body, behaviour) });
  const prompts = promptsDir();
  const tools = toolCasesDir();
  const result = await bench(benchOf([engineAt("vllm", engine.baseURL)], prompts, { tools, workloads: ["quality", "tools"], ...extra }));
  return { engine, ...result };
};

const scoresOf = (ended: ReturnType<typeof endedOf>[number]) => Object.fromEntries(ended.requests.map((request) => [request.promptId, request.score?.outcome ?? null]));

describe("the quality and tools workloads", () => {
  it("send each prompt and each tool-call case once, one at a time, and score the answers", async () => {
    const { engine, events } = await run({ delayMs: 20 }, { repeats: 2, concurrency: [1, 4] });

    const quality = endedOf(events, "quality");
    const tools = endedOf(events, "tools");
    expect(quality).toHaveLength(2);
    expect(tools).toHaveLength(2);
    for (const ended of quality) {
      expect(ended.concurrency).toBe(1);
      expect(ended.requests).toHaveLength(3);
      expect(scoresOf(ended)).toEqual({ add: "pass", sub: "pass", mul: "pass" });
      for (const request of ended.requests) expect(request.score?.codeSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const ended of tools) {
      expect(ended.requests).toHaveLength(2);
      expect(scoresOf(ended)).toEqual({ weather: "valid_call", files: "valid_call" });
    }
    // Two repeats of three prompts and two cases, never more than one request in flight, whatever the sweep says.
    expect(engine.chatBodies).toHaveLength(2 * (3 + 2));
    expect(engine.maxInFlight()).toBe(1);
  });

  it("send the case's tools and prompt for a tools request, and no tools for a quality one", async () => {
    const { engine } = await run();
    const asked = engine.chatBodies.map((body) => ({ asked: askedOf(body), tools: body.tools }));
    for (const entry of asked.filter((a) => a.asked.kind === "case")) expect((entry.tools as unknown[]).length).toBe(2);
    for (const entry of asked.filter((a) => a.asked.kind === "prompt")) expect(entry.tools).toBeUndefined();
  });

  it("score a wrong solution fail, an answer with no code no_code, a wrong tool wrong_tool and a text answer no_call", async () => {
    const { events } = await run({ wrong: ["sub"], noCode: ["mul"], wrongTool: ["weather"], noCall: ["files"] });
    expect(scoresOf(endedOf(events, "quality")[0]!)).toEqual({ add: "pass", sub: "fail", mul: "no_code" });
    expect(scoresOf(endedOf(events, "tools")[0]!)).toEqual({ weather: "wrong_tool", files: "no_call" });
    const failed = endedOf(events, "quality")[0]!.requests.find((request) => request.promptId === "sub")!;
    expect(failed.score?.detail).toContain("not ok");
  });

  it("score nothing for a request that errored: an engine error is not a failed answer", async () => {
    const { events } = await run({ fail: { sub: 500, weather: 503 } });
    const quality = endedOf(events, "quality")[0]!;
    const sub = quality.requests.find((request) => request.promptId === "sub")!;
    expect(sub.error).toContain("HTTP 500");
    expect(sub.score).toBeNull();
    expect(sub.scoreProblem).toBeNull();
    expect(scoresOf(quality)).toEqual({ add: "pass", sub: null, mul: "pass" });
    const weather = endedOf(events, "tools")[0]!.requests.find((request) => request.promptId === "weather")!;
    expect(weather.error).toContain("HTTP 503");
    expect(weather.score).toBeNull();
  });

  it("run the tests after the workload's resources stopped being sampled", async () => {
    const { events } = await run({ delayMs: 5 });
    const ended = endedOf(events, "quality")[0]!;
    // The wall time is the requests', not the tests': every test run is a node process of its own.
    expect(ended.wallMs).toBeLessThan(ended.requests.length * 1000);
    expect(ended.resources.host.samples).toBeGreaterThan(0);
  });

  it("record the hashes of the tests and the cases, so benches can be told to be the same", async () => {
    const { events } = await run();
    const created = events[0]!;
    if (created.type !== "bench_created") throw new Error("first event");
    expect(created.prompts.map((prompt) => prompt.testSha256)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(created.toolCases!.map((c) => c.id)).toEqual(["files", "weather"]);
    expect(replayBench(events).toolCases).toEqual(created.toolCases);
  });

  it("write report.json and report.txt beside the ledger", async () => {
    const { dir } = await run();
    expect(existsSync(join(dir, "report.json"))).toBe(true);
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toContain("quality: pass 3/3 (100.0%)");
    expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).engines[0].tools.passes).toBe(2);
  });
});

describe("a bench that cannot score what it is asked to", () => {
  const engines = [engineAt("vllm", "http://localhost:1/v1")];

  it("refuses the quality workload when a prompt has no test, naming it, and writes nothing", async () => {
    const out = writeTree({});
    const prompts = promptsDir({ "extra/prompt.md": "A prompt without a test.\n" });
    await expect(runBench(benchOf(engines, prompts, { workloads: ["quality"] }), { out })).rejects.toThrow(/the quality workload tests every prompt, and these have no test\.mjs: extra/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("does not need tests for the workloads that only time the prompts", async () => {
    const out = writeTree({});
    const engine = await fakeEngine({ chat: (body) => answerOf(body) });
    const prompts = promptsDir({ "extra/prompt.md": "A prompt without a test.\n" });
    const result = await runBench(benchOf([engineAt("vllm", engine.baseURL)], prompts, { workloads: ["latency"] }), { out, env: await toolsEnv({ docker: false }), sampleIntervalMs: 50 });
    expect(result.state.state).toBe("completed");
  });

  it("refuses the tools workload with no tools directory, a missing one, or an invalid case, before anything is written", async () => {
    const out = writeTree({});
    const prompts = promptsDir();
    await expect(runBench(benchOf(engines, prompts, { workloads: ["tools"] }), { out })).rejects.toThrow(BenchInvalidError);
    await expect(runBench(benchOf(engines, prompts, { workloads: ["tools"], tools: join(writeTree({}), "missing") }), { out })).rejects.toThrow(/cannot read the tool-call cases directory/);
    const bad = writeTree({ "broken.json": '{"prompt":"p","tools":[],"expect":{"name":"x","arguments":{}}}' });
    await expect(runBench(benchOf(engines, prompts, { workloads: ["tools"], tools: bad }), { out })).rejects.toThrow(/tool-call case broken: `tools` must be a non-empty array/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("resolves the tools directory against the bench file's directory", async () => {
    const out = writeTree({});
    const engine = await fakeEngine({ chat: (body) => answerOf(body) });
    const base = writeTree({ "cases/weather.json": JSON.stringify({ prompt: "Weather? CASE:weather", tools: [{ type: "function", function: { name: "get_weather" } }], expect: { name: "get_weather", arguments: { city: "Lisbon" } } }) });
    const result = await runBench(benchOf([engineAt("vllm", engine.baseURL)], promptsDir(), { workloads: ["tools"], tools: "cases" }), { out, baseDir: base, env: await toolsEnv({ docker: false }), sampleIntervalMs: 50 });
    expect(result.state.workloads[0]!.ended!.requests[0]!.score?.outcome).toBe("valid_call");
  });
});

describe("a ledger written before scoring existed", () => {
  it("still replays: a prompt with no testSha256 has none, a bench with no cases has none, a request with no score has none", async () => {
    const engine = await fakeEngine({ chat: (body) => answerOf(body) });
    const { events } = await bench(benchOf([engineAt("vllm", engine.baseURL)], promptsDir(), { workloads: ["latency"] }));
    const stripped = events.map((event) => {
      if (event.type === "bench_created") {
        const { toolCases: _toolCases, ...rest } = event;
        return { ...rest, prompts: event.prompts.map(({ id, sha256 }) => ({ id, sha256 })) };
      }
      if (event.type === "workload_ended") return { ...event, requests: event.requests.map(({ score: _score, scoreProblem: _problem, ...request }) => request) };
      return event;
    });
    const view = replayBench(stripped as never);
    expect(view.prompts.every((prompt) => prompt.testSha256 === null)).toBe(true);
    expect(view.toolCases).toEqual([]);
  });
});

describe("a cancel while the answers are being scored", () => {
  const record = (promptId: string, error: string | null = null) => ({ promptId, error, status: 200, ttftMs: 1, interChunkMs: [], latencyMs: 1, contentChunks: 1, usage: null, finishReason: "stop", startMs: 0, endMs: 1 }) as never;
  const answer = { content: "```js\nexport function add(a, b) { return a + b; }\n```\n", toolCalls: [] };
  const prompts = new Map([["add", { id: "add", text: "", sha256: "", test: { text: "// no test", sha256: "" } }]]) as never;

  it("leaves the unscored answers with a problem, not a score, and says the workload was cut short", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await scoreWorkload({ workload: "quality" }, [record("add"), record("add")], [answer, answer], { prompts, signal: controller.signal });

    expect(result.cutShort).toBe(true);
    expect(result.requests.map((request) => [request.score, request.scoreProblem])).toEqual([[null, NOT_SCORED_CANCELLED], [null, NOT_SCORED_CANCELLED]]);
  });

  it("is not cut short when the only requests left are ones that had errored: there was nothing to score", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await scoreWorkload({ workload: "quality" }, [record("add", "HTTP 500: x")], [answer], { prompts, signal: controller.signal });
    expect(result.cutShort).toBe(false);
  });

  it("returns the other workloads as they are", async () => {
    const result = await scoreWorkload({ workload: "latency" }, [record("add")], [answer], { prompts });
    expect(result).toMatchObject({ cutShort: false });
    expect(result.requests[0]).not.toHaveProperty("score");
  });

  it("records the workload cancelled, so its partial scores are not a finished workload's", async () => {
    const controller = new AbortController();
    let asked = 0;
    // The last of the three requests is answered at once; the abort comes while its (and the others') tests run.
    const engine = await fakeEngine({
      chat: (body) => {
        if (++asked === 3) setTimeout(() => controller.abort(), 150);
        return answerOf(body);
      },
    });

    const { events, state } = await bench(benchOf([engineAt("vllm", engine.baseURL)], promptsDir(), { workloads: ["quality"] }), { signal: controller.signal });

    const ended = endedOf(events, "quality");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.cancelled).toBe(true);
    // Every request ran to the end: it was the scoring that was cut short.
    expect(ended[0]!.requests.every((request) => request.error === null)).toBe(true);
    expect(ended[0]!.requests.some((request) => request.score === null && request.scoreProblem !== null)).toBe(true);
    expect(state.state).toBe("cancelled");
    const report = reportOf([state]);
    expect(report.engines[0]!.quality).toBeNull();
    expect(report.engines[0]!.workloads).toMatchObject({ ended: 0, cancelled: 1 });
  });
});
