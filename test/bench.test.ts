import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCheckedLedger } from "../src/ledger/index.ts";
import {
  BenchInvalidError,
  BenchLedgerInconsistentError,
  bytesOf,
  checkEngine,
  ENGINES,
  readBench,
  replayBench,
  runBench,
  streamChat,
  summarizeWorkload,
  validateBench,
  type BenchEvent,
  type BenchEventBody,
  type BenchFile,
  type BenchView,
} from "../src/inference/index.ts";
import { closedBaseURL, startFakeEngine, streamed, type FakeEngine, type FakeEngineScript } from "./helpers/fake-engine.ts";
import { FAKE_GPU, installFakeDocker, installFakeNvidiaSmi } from "./helpers/fake-gpu.ts";
import { fakeToolsDir, pathWithFakes } from "./helpers/fake-tools.ts";
import { removeTempRepos, writeTree } from "./helpers/repo.ts";

const engines: FakeEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  removeTempRepos();
});

async function fakeEngine(script: FakeEngineScript): Promise<FakeEngine> {
  const engine = await startFakeEngine(script);
  engines.push(engine);
  return engine;
}

/** Three prompts, `alpha`, `beta` and `gamma`, in a directory of their own. */
const promptsDir = () => writeTree({ "alpha/prompt.md": "Write add(a, b).\n", "beta/prompt.md": "Write sub(a, b).\n", "gamma/prompt.md": "Write mul(a, b).\n", "README.md": "not a prompt\n" });

/** Fake tools on PATH: `nvidia-smi` and `docker` unless left out. Nothing else is found there, a real `nvidia-smi` included. */
async function toolsEnv(tools: { gpu?: boolean; docker?: boolean } = {}): Promise<NodeJS.ProcessEnv> {
  const { dir, log } = fakeToolsDir();
  if (tools.gpu ?? true) installFakeNvidiaSmi(dir, log);
  if (tools.docker ?? true) installFakeDocker(dir, log);
  return pathWithFakes(dir);
}

function benchOf(entries: BenchFile["engines"], prompts: string, extra: Partial<BenchFile> = {}): BenchFile {
  return { name: "test bench", engines: entries, prompts, concurrency: [1, 2], repeats: 1, maxTokens: 16, warmup: 1, timeoutMs: 5_000, ...extra };
}

const vllmAt = (baseURL: string, extra: Partial<BenchFile["engines"][number]> = {}) => ({ engine: "vllm" as const, baseURL, model: "fake-model", quantization: "awq", ...extra });

async function bench(file: BenchFile, options: { env?: NodeJS.ProcessEnv; seed?: number; engine?: string; signal?: AbortSignal; onEvent?: (event: BenchEvent, view: Readonly<BenchView>) => void } = {}) {
  const out = writeTree({});
  const result = await runBench(file, { out, env: options.env ?? (await toolsEnv()), seed: options.seed ?? 7, sampleIntervalMs: 50, engine: options.engine as never, signal: options.signal, onEvent: options.onEvent });
  const { events } = await readCheckedLedger<BenchEventBody>(join(result.dir, "ledger.jsonl"));
  return { ...result, out, events, types: events.map((event) => event.type) };
}

describe("the bench file", () => {
  it("lists the four engines as a closed list", () => {
    expect(ENGINES).toEqual(["ollama", "vllm", "sglang", "tensorrt_llm"]);
  });

  it("accepts a whole bench file and the defaults", () => {
    expect(validateBench(benchOf([vllmAt("http://localhost:8001/v1")], "prompts"))).toEqual([]);
    expect(validateBench({ name: "b", engines: [vllmAt("http://localhost:8001/v1")], prompts: "p" })).toEqual([]);
  });

  it("refuses unknown keys, at the top and in an engine", () => {
    const problems = validateBench({ ...benchOf([{ ...vllmAt("http://localhost:8001/v1"), gpu: 1 } as never], "p"), temperature: 0.7 });
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("unknown bench property `temperature`"), expect.stringContaining("unknown property `engines[0].gpu`")]));
  });

  it("refuses an unknown engine, an engine twice, a base URL that does not end in /v1 and a missing model or quantization", () => {
    const problems = validateBench(
      benchOf(
        [
          { engine: "llamacpp", baseURL: "http://localhost:1/v1", model: "m", quantization: "q" } as never,
          vllmAt("http://localhost:8001"),
          vllmAt("http://localhost:8001/v1", { model: "", quantization: "" }),
        ],
        "p",
      ),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("`engines[0].engine` must be one of: ollama, vllm, sglang, tensorrt_llm"),
        expect.stringContaining("`engines[1].baseURL` must be an http or https URL ending in /v1"),
        expect.stringContaining("engine vllm is listed twice"),
        expect.stringContaining("`engines[2].model`"),
        expect.stringContaining("`engines[2].quantization`"),
      ]),
    );
  });

  it("refuses bad settings", () => {
    const problems = validateBench(benchOf([vllmAt("http://localhost:8001/v1")], "p", { concurrency: [0, 2], repeats: 0, maxTokens: 1.5, warmup: -1, timeoutMs: 0, workloads: ["latency", "speed"] as never }));
    for (const key of ["concurrency", "repeats", "maxTokens", "warmup", "timeoutMs", "workloads"]) expect(problems.some((problem) => problem.includes(`\`${key}\``))).toBe(true);
  });

  it("writes nothing for an invalid bench, a prompt directory without prompts, or an engine the file does not list", async () => {
    const out = writeTree({});
    await expect(runBench({ name: "", engines: [], prompts: "p" } as never, { out })).rejects.toThrow(BenchInvalidError);
    await expect(runBench(benchOf([vllmAt("http://localhost:8001/v1")], writeTree({ "alpha/notes.md": "x" })), { out })).rejects.toThrow(/alpha has no prompt\.md/);
    await expect(runBench(benchOf([vllmAt("http://localhost:8001/v1")], promptsDir()), { out, engine: "sglang" })).rejects.toThrow(/--engine sglang: the bench file does not list it/);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("the streaming client", () => {
  const request = (baseURL: string) => ({ baseURL, model: "fake-model", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 32 });

  it("sends a streamed request that asks for usage, at temperature 0 with a seed", async () => {
    const engine = await fakeEngine({ chat: () => streamed(2, 0) });
    await streamChat(request(engine.baseURL), { timeoutMs: 5_000 });
    expect(engine.chatBodies[0]).toEqual({ model: "fake-model", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: 32, seed: 0 });
  });

  it("times the first chunk that carries content, the gaps between chunks and the whole request, and keeps the usage as reported", async () => {
    const engine = await fakeEngine({ chat: () => ({ headerDelayMs: 150, chunks: [{ delayMs: 0, content: "a" }, { delayMs: 120, content: "b" }, { delayMs: 120, content: "c" }], usage: { prompt_tokens: 11, completion_tokens: 3 } }) });

    const measured = await streamChat(request(engine.baseURL), { timeoutMs: 5_000 });

    expect(measured.error).toBeNull();
    expect(measured.ttftMs).toBeGreaterThanOrEqual(140);
    expect(measured.interChunkMs).toHaveLength(2);
    for (const gap of measured.interChunkMs) expect(gap).toBeGreaterThanOrEqual(100);
    expect(measured.latencyMs).toBeGreaterThanOrEqual(measured.ttftMs! + 200);
    expect(measured.contentChunks).toBe(3);
    expect(measured.content).toBe("abc");
    expect(measured.usage).toEqual({ promptTokens: 11, completionTokens: 3 });
    expect(measured.finishReason).toBe("stop");
  });

  it("keeps usage null when the engine reports none, and never counts chunks as tokens", async () => {
    const engine = await fakeEngine({ chat: (_, i) => (i === 0 ? streamed(5, 0, null) : streamed(5, 0, { prompt_tokens: 4 })) });

    expect((await streamChat(request(engine.baseURL), { timeoutMs: 5_000 })).usage).toBeNull();
    expect((await streamChat(request(engine.baseURL), { timeoutMs: 5_000 })).usage).toEqual({ promptTokens: 4, completionTokens: null });
  });

  it("puts a streamed tool call together", async () => {
    const engine = await fakeEngine({ chat: () => ({ chunks: [{ toolCall: { id: "c1", name: "get_weather", arguments: '{"ci' } }, { toolCall: { arguments: 'ty":"Paris"}' } }], usage: null, finishReason: "tool_calls" }) });

    const measured = await streamChat(request(engine.baseURL), { timeoutMs: 5_000 });

    expect(measured.ttftMs).not.toBeNull();
    expect(measured.toolCalls).toEqual([{ id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' }]);
  });

  it("records a status that is not 2xx with the first 300 characters of the body", async () => {
    const engine = await fakeEngine({ chat: () => ({ status: 503, body: `overloaded ${"x".repeat(400)}` }) });

    const measured = await streamChat(request(engine.baseURL), { timeoutMs: 5_000 });

    expect(measured.status).toBe(503);
    expect(measured.error).toMatch(/^HTTP 503: overloaded x+$/);
    expect(measured.error!.length).toBe("HTTP 503: ".length + 300);
    expect(measured.ttftMs).toBeNull();
    expect(measured.usage).toBeNull();
  });

  it("gives up on a request that takes longer than its limit, and on a stream that ends before [DONE]", async () => {
    const engine = await fakeEngine({ chat: (_, i) => (i === 0 ? { stall: true } : { ...streamed(2, 0), omitDone: true }) });

    const stalled = await streamChat(request(engine.baseURL), { timeoutMs: 300 });
    expect(stalled.error).toBe("timed out after 300 ms");
    expect(stalled.latencyMs).toBeGreaterThanOrEqual(250);

    const cut = await streamChat(request(engine.baseURL), { timeoutMs: 5_000 });
    expect(cut.error).toBe("the stream ended before [DONE]");
    expect(cut.content).toBe("t0 t1 ");
  });

  it("reads the time from the clock it is given", async () => {
    const engine = await fakeEngine({ chat: () => streamed(3, 0) });
    let tick = 0;
    const measured = await streamChat(request(engine.baseURL), { timeoutMs: 5_000, now: () => (tick += 10) });
    // Started at 10; the three content chunks at 20, 30 and 40; done at 50.
    expect(measured).toMatchObject({ ttftMs: 10, interChunkMs: [10, 10], latencyMs: 40 });
  });
});

describe("the engine check", () => {
  it("finds the model listed and reads the version from the engine's own path", async () => {
    const engine = await fakeEngine({ models: ["other", "fake-model"], version: { path: "/get_server_info", version: "0.5.22" }, chat: () => streamed(1, 0) });
    expect(await checkEngine({ engine: "sglang", baseURL: engine.baseURL, model: "fake-model" })).toEqual({ available: true, models: ["other", "fake-model"], version: "0.5.22", error: null });
  });

  it("records no version when the engine says none, never a guess", async () => {
    const engine = await fakeEngine({ version: null, chat: () => streamed(1, 0) });
    expect(await checkEngine({ engine: "vllm", baseURL: engine.baseURL, model: "fake-model" })).toMatchObject({ available: true, version: null });
  });

  it("is unavailable when the model is not listed, the list fails, or nothing listens", async () => {
    const other = await fakeEngine({ models: ["qwen-other"], chat: () => streamed(1, 0) });
    expect(await checkEngine({ engine: "vllm", baseURL: other.baseURL, model: "fake-model" })).toMatchObject({ available: false, models: ["qwen-other"], error: "the engine does not list the model fake-model (it lists: qwen-other)" });

    const failing = await fakeEngine({ models: { status: 500, body: "no GPU" }, chat: () => streamed(1, 0) });
    expect(await checkEngine({ engine: "vllm", baseURL: failing.baseURL, model: "fake-model" })).toMatchObject({ available: false, models: null, error: expect.stringContaining("HTTP 500: no GPU") });

    const closed = await closedBaseURL();
    expect(await checkEngine({ engine: "vllm", baseURL: closed, model: "fake-model" })).toMatchObject({ available: false, models: null, error: expect.stringMatching(/ECONNREFUSED|fetch failed/) });
  });
});

describe("a bench", () => {
  it("checks the engine, records the hardware and an idle sample, warms up, then measures latency and the throughput sweep", async () => {
    const engine = await fakeEngine({ chat: () => streamed(3, 10) });
    const prompts = promptsDir();

    const { state, types, events, dir, out } = await bench(benchOf([vllmAt(engine.baseURL, { container: "ahp-vllm" })], prompts));

    expect(dir.startsWith(out)).toBe(true);
    expect(types).toEqual(["bench_created", "engine_checked", ...Array(3).fill(["workload_started", "workload_ended"]).flat(), "bench_ended"]);
    expect(state.state).toBe("completed");
    const created = events[0] as Extract<BenchEvent, { type: "bench_created" }>;
    expect(created.seed).toBe(7);
    expect(created.prompts.map((prompt) => prompt.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(created.prompts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(created.settings).toMatchObject({ workloads: ["latency", "throughput"], concurrency: [1, 2], repeats: 1, maxTokens: 16, warmup: 1, timeoutMs: 5_000 });
    expect(created.fingerprint).toMatchObject({ gpu: { name: FAKE_GPU.name, memoryTotalMiB: FAKE_GPU.memoryTotalMiB, driver: FAKE_GPU.driver }, gpuReason: null, cpu: { model: expect.any(String), cores: expect.any(Number) }, ramBytes: expect.any(Number) });

    const [check] = state.engines;
    expect(check!.check).toMatchObject({ available: true, version: "0.0.0-fake", idleGpu: { memoryUsedMiB: FAKE_GPU.idleMemoryMiB, source: "nvidia-smi" }, warmup: { requests: 1, failed: 0 } });

    // One warmup request, then 3 latency requests, 4 at concurrency 1 and 8 at concurrency 2 (at least 4 per worker).
    expect(engine.chatBodies).toHaveLength(1 + 3 + 4 + 8);
    expect(state.workloads.map((w) => [w.workload, w.concurrency, w.ended?.requests.length])).toEqual([
      ["latency", 1, 3],
      ["throughput", 1, 4],
      ["throughput", 2, 8],
    ]);
    expect(engine.maxInFlight()).toBe(2);

    const latency = state.workloads[0]!.ended!;
    expect(new Set(latency.requests.map((r) => r.promptId))).toEqual(new Set(["alpha", "beta", "gamma"]));
    for (const r of latency.requests) {
      expect(r.error).toBeNull();
      expect(r.ttftMs).toBeGreaterThan(0);
      expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
    }
    const gpu = latency.resources.gpu!;
    expect(gpu.source).toBe("nvidia-smi");
    expect(gpu.memoryUsedMiB!.peak).toBeLessThanOrEqual(5300);
    expect(gpu.memoryUsedMiB!.mean).toBeGreaterThanOrEqual(5100);
    expect(latency.resources.host).toMatchObject({ source: "os", scope: "whole_machine" });
    expect(latency.resources.docker).toMatchObject({ source: "docker stats", container: "ahp-vllm", memoryUsedBytes: { peak: 1.5 * 1024 ** 3 }, cpuPercent: { peak: 12.5 } });

    const sweep = summarizeWorkload(state.workloads[2]!.ended!);
    expect(sweep).toMatchObject({ requests: 8, succeeded: 8, failed: 0, usageReported: 8 });
    expect(sweep.requestsPerSecond).toBeGreaterThan(0);
    expect(sweep.outputTokensPerSecond).toBeCloseTo((8 * 3) / (state.workloads[2]!.ended!.wallMs / 1000), 6);

    // What was written is what is read back.
    expect(await readBench(dir)).toEqual(state);
  });

  it("gives no output tokens per second unless every request reported usage, and says how many did", async () => {
    const engine = await fakeEngine({ chat: (_, i) => (i === 3 ? streamed(2, 0, null) : streamed(2, 0)) });

    const { state } = await bench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { workloads: ["throughput"], concurrency: [1], warmup: 0 }));

    const summary = summarizeWorkload(state.workloads[0]!.ended!);
    expect(summary).toMatchObject({ requests: 4, succeeded: 4, usageReported: 3, outputTokensPerSecond: null });
    expect(summary.requestsPerSecond).toBeGreaterThan(0);
  });

  it("records an engine that is not up as unavailable with its error, skips its workloads and goes on with the others", async () => {
    const up = await fakeEngine({ chat: () => streamed(1, 0) });
    const down = await closedBaseURL();

    const { state, types } = await bench(benchOf([{ engine: "ollama", baseURL: down, model: "qwen", quantization: "q4_K_M" }, vllmAt(up.baseURL)], promptsDir(), { workloads: ["latency"] }));

    expect(state.state).toBe("completed");
    const ollama = state.engines.find((e) => e.engine === "ollama")!;
    expect(ollama.check).toMatchObject({ available: false, error: expect.any(String), idleGpu: null, warmup: null });
    const skipped = state.workloads.filter((w) => w.engine === "ollama");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.skipped).toEqual({ reason: "engine_unavailable", error: ollama.check!.error });
    expect(state.workloads.find((w) => w.engine === "vllm")!.ended!.requests).toHaveLength(3);
    expect(types.filter((type) => type === "engine_checked")).toHaveLength(2);
  });

  it("runs only the engine named, and leaves the others unchecked and unrecorded", async () => {
    const engine = await fakeEngine({ chat: () => streamed(1, 0) });
    const down = await closedBaseURL();

    const { state, events } = await bench(benchOf([{ engine: "ollama", baseURL: down, model: "qwen", quantization: "q4_K_M" }, vllmAt(engine.baseURL)], promptsDir(), { workloads: ["latency"] }), { engine: "vllm" });

    expect(state.engines.map((e) => e.engine)).toEqual(["vllm"]);
    expect(state.onlyEngine).toBe("vllm");
    expect(JSON.stringify(events)).not.toContain("ollama");
  });

  it("orders engines × repeats and the prompts of each workload from the seed, and records the order", async () => {
    const vllm = await fakeEngine({ chat: () => streamed(1, 0) });
    const sglang = await fakeEngine({ chat: () => streamed(1, 0) });
    const file = benchOf([vllmAt(vllm.baseURL), { engine: "sglang", baseURL: sglang.baseURL, model: "fake-model", quantization: "awq" }], promptsDir(), { workloads: ["latency"], repeats: 3, warmup: 0 });
    const env = await toolsEnv({ gpu: false, docker: false });

    const first = await bench(file, { env, seed: 42 });
    const again = await bench(file, { env, seed: 42 });
    const other = await bench(file, { env, seed: 43 });

    const schedule = (result: typeof first) => (result.events[0] as Extract<BenchEvent, { type: "bench_created" }>).schedule;
    expect(schedule(first)).toEqual(schedule(again));
    expect(schedule(first)).toHaveLength(6);
    expect(schedule(first)).not.toEqual(schedule(other));
    expect(first.state.workloads.map((w) => [w.engine, w.repeat])).toEqual(schedule(first).map((s) => [s.engine, s.repeat]));
    // The latency requests go in the recorded prompt order.
    for (const [i, unit] of schedule(first).entries()) expect(first.state.workloads[i]!.ended!.requests.map((r) => r.promptId)).toEqual(unit.prompts);
  });

  it("records no GPU figures, with the reason, when nvidia-smi is missing, and no Docker figure for an engine that is not a container", async () => {
    const engine = await fakeEngine({ chat: () => streamed(1, 0) });

    const { state, events } = await bench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { workloads: ["latency"] }), { env: await toolsEnv({ gpu: false }) });

    const created = events[0] as Extract<BenchEvent, { type: "bench_created" }>;
    expect(created.fingerprint.gpu).toBeNull();
    expect(created.fingerprint.gpuReason).toContain("nvidia-smi");
    expect(state.engines[0]!.check).toMatchObject({ available: true, idleGpu: null, idleGpuReason: expect.stringContaining("nvidia-smi") });
    const { resources } = state.workloads[0]!.ended!;
    expect(resources.gpu).toBeNull();
    expect(resources.gpuReason).toContain("nvidia-smi");
    expect(resources.docker).toBeNull();
    expect(resources.dockerReason).toBe("not a container: the bench file names none for this engine");
    expect(resources.host.memoryUsedBytes).not.toBeNull();
  });

  it("records failed requests as errors with no timings it did not measure", async () => {
    const engine = await fakeEngine({ chat: (_, i) => (i === 1 ? { status: 500, body: "CUDA out of memory" } : streamed(1, 0)) });

    const { state } = await bench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { workloads: ["latency"], warmup: 0 }), { env: await toolsEnv({ gpu: false, docker: false }) });

    const failed = state.workloads[0]!.ended!.requests.filter((r) => r.error !== null);
    expect(failed).toEqual([expect.objectContaining({ status: 500, error: "HTTP 500: CUDA out of memory", ttftMs: null, usage: null })]);
    expect(summarizeWorkload(state.workloads[0]!.ended!)).toMatchObject({ requests: 3, succeeded: 2, failed: 1, outputTokensPerSecond: null });
  });

  it("stops at a cancel: the workload in hand ends cancelled and no other starts", async () => {
    const engine = await fakeEngine({ chat: () => streamed(4, 100) });
    const controller = new AbortController();

    const { state, types } = await bench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { warmup: 0 }), {
      env: await toolsEnv({ gpu: false, docker: false }),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "workload_started") setTimeout(() => controller.abort(), 150);
      },
    });

    expect(types).toEqual(["bench_created", "engine_checked", "workload_started", "workload_ended", "bench_ended"]);
    expect(state.state).toBe("cancelled");
    expect(state.workloads[0]!.ended!.cancelled).toBe(true);
    expect(state.workloads[0]!.ended!.requests.some((r) => r.error === "cancelled")).toBe(true);
    expect(state.pending).toHaveLength(2);
  });
});

describe("replay", () => {
  it("refuses a workload that is not the next one scheduled", async () => {
    const engine = await fakeEngine({ chat: () => streamed(1, 0) });
    const { events } = await bench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { warmup: 0 }), { env: await toolsEnv({ gpu: false, docker: false }) });

    const started = events.filter((event) => event.type === "workload_started");
    // The second workload's start moved before the first's.
    const swapped = events.map((event) => (event === started[0] ? started[1]! : event === started[1] ? started[0]! : event));
    expect(() => replayBench(swapped)).toThrow(BenchLedgerInconsistentError);
  });

  it("refuses a workload of an engine that was not available", () => {
    const created = { seq: 1, prevHash: null, time: "t", hash: "h", type: "bench_created" } as const;
    const base = {
      ...created,
      benchId: "bench_x",
      protocolVersion: "0.1.0",
      name: "n",
      seed: 1,
      onlyEngine: null,
      engines: [vllmAt("http://localhost:1/v1")],
      settings: { workloads: ["latency"], concurrency: [1], repeats: 1, maxTokens: 1, warmup: 0, timeoutMs: 1, sampleIntervalMs: 50 },
      request: { stream: true, includeUsage: true, temperature: 0, seed: 0 },
      prompts: [{ id: "a", sha256: "0".repeat(64) }],
      fingerprint: { gpu: null, gpuReason: "none", cpu: { model: "c", cores: 1 }, ramBytes: 1, os: "Windows" },
      schedule: [{ engine: "vllm", repeat: 1, workload: "latency", concurrency: 1, prompts: ["a"] }],
    };
    const checked = { seq: 2, prevHash: "h", time: "t", hash: "h2", type: "engine_checked", engine: "vllm", available: false, models: null, version: null, error: "down", idleGpu: null, idleGpuReason: null, warmup: null };
    const started = { seq: 3, prevHash: "h2", time: "t", hash: "h3", type: "workload_started", engine: "vllm", repeat: 1, workload: "latency", concurrency: 1 };
    expect(() => replayBench([base, checked, started] as never)).toThrow(/not available/);
  });
});

it("keeps benches in AHP's per-user directory unless told otherwise", async () => {
  const engine = await fakeEngine({ chat: () => streamed(1, 0) });
  const { dir } = await runBench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { workloads: ["latency"], warmup: 0 }), { env: await toolsEnv({ gpu: false, docker: false }), sampleIntervalMs: 50 });
  expect(dir.startsWith(join(process.env.AHP_HOME!, "benches"))).toBe(true);
});

it("reads docker stats' sizes in both binary and decimal units, and nothing else", () => {
  expect(bytesOf("1.5GiB")).toBe(1.5 * 1024 ** 3);
  expect(bytesOf("512MiB")).toBe(512 * 1024 ** 2);
  expect(bytesOf("2.1GB")).toBe(2.1e9);
  expect(bytesOf("0B")).toBe(0);
  expect(bytesOf("--")).toBeNull();
});

it("keeps the bench in its own directory, named by its ID, with its ledger", async () => {
  const engine = await fakeEngine({ chat: () => streamed(1, 0) });
  const { dir, benchId, out } = await bench(benchOf([vllmAt(engine.baseURL)], promptsDir(), { workloads: ["latency"], warmup: 0 }), { env: await toolsEnv({ gpu: false, docker: false }) });
  expect(benchId).toMatch(/^bench_[a-z0-9]+$/);
  expect(dir).toBe(join(out, benchId));
  expect(readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).length).toBeGreaterThan(3);
});
