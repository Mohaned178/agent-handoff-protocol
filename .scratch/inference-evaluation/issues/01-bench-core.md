# 01: Bench core: latency, throughput, resources

**Implement with:** Opus 5.5, effort high

**What to build:** `src/inference/`: a bench file, a streaming client that times each request, workloads at fixed
concurrency, GPU sampling, a hash-chained bench ledger and replay.

**Blocked by:** none (tests use a fake engine; the spike only tunes the launchers)

**Status:** done (2026-11-01)

- [x] `ENGINES` closed list (`ollama`, `vllm`, `sglang`, `tensorrt_llm`)
- [x] Bench file validated, refusing unknown keys:
  - `engines: [{ engine, baseURL, model, quantization }]`
  - `prompts`
  - `concurrency`
  - `repeats`
  - `maxTokens`
  - `warmup`
- [x] Streaming `/v1/chat/completions` client:
  - measures TTFT, inter-token gaps and end-to-end latency
  - asks for usage with `stream_options.include_usage` and keeps it only as reported, else null
- [x] Workloads:
  - latency at concurrency 1
  - a throughput sweep, giving requests/s, and output tokens/s from reported usage only
- [x] Order of engines × repeats from a seed (`seededShuffle`)
- [x] GPU sampled with `nvidia-smi` through the process layer: peak and mean memory, utilization and power, the source
      named; null when `nvidia-smi` is missing
- [x] Host memory and CPU sampled at the same interval as the GPU, labelled honestly as the whole machine's:
      `os.totalmem() - os.freemem()` and the load from `os.cpus()` times. Docker's own figure comes from
      `docker stats --no-stream` where the engine is a container; null where it is not
- [x] An idle sample of GPU memory before the first request of each engine, so the model's own footprint is apart from
      what serving adds
- [x] `--engine <id>` runs one engine of the bench file (only one fits in 8 GB at a time); the rest are not checked and
      not recorded as unavailable
- [x] Engine check before any workload: `/v1/models` lists the model. An engine that fails is recorded as
      `engine_unavailable` with the error, and the bench goes on with the others
- [x] Hardware fingerprint recorded once: GPU, VRAM, driver, CPU, RAM, OS label
- [x] Ledger through `LedgerWriter<B>` and replay; stored in `<AHP_HOME>/benches/<id>` or `--out`
- [x] Tests against `test/helpers/fake-engine.ts` (an HTTP server with scripted SSE) and a fake `nvidia-smi`

## Implementation notes (2026-11-01)

1. **How the bench knows an engine is a container.** The ticket asks for `docker stats` "where the engine is a
   container" but the bench file's keys had no way to say so. An engine entry takes an optional `container` (the name
   `docker stats` uses); without it the Docker figure is null with the reason "not a container". The three Compose files
   now set `container_name: ahp-vllm`, `ahp-sglang` and `ahp-tensorrt-llm` so ticket 02's `bench/local.mjs` can name them.
   No image tag changed. Reason: explicit beats guessing from ports or `docker ps`, and an Ollama entry simply leaves it out.
2. **Idle sample and warmup sit in `engine_checked`.** Right after an engine's check passes, its idle GPU memory is read
   (`idleGpu`, `idleGpuReason`) and then its `warmup` requests are sent; the warmup's count, failures and first error are
   on the same event. No new event type. Every engine is checked (and warmed) before the first workload of any engine.
3. **`bench_ended` has a third state, `stopped`,** for an exception, as `evaluation_ended` has; a workload under way then
   stays `running` in replay (it never ended). `completed` and `cancelled` are as the ticket says.
4. **Cancel.** No new request starts; requests in flight end with the error `cancelled`, the workload is recorded with
   `cancelled: true` and its requests so far, and the bench ends `cancelled` with the rest left in `pending`. A check a
   cancel cut short is not recorded (it says nothing about the engine).
5. **What counts as a token-bearing chunk.** TTFT is the first chunk with non-empty `delta.content` or any
   `delta.tool_calls` piece; the empty role chunk vLLM sends first does not count. `interChunkMs` are the gaps between
   such chunks only. Times are rounded to the microsecond.
6. **Request errors.** Besides a non-2xx status (`HTTP <status>: <first 300 chars>`), a timeout (`timed out after <n>
   ms`) and a cancel, a stream that ends without `[DONE]` is the error `the stream ended before [DONE]`, and a chunk with
   an `error` object is `the engine streamed an error: ...`. What was measured up to there is kept. `streamChat` never
   throws for anything the engine or the network does.
7. **Throughput figures** (`summarizeWorkload`, in the module for ticket 02's report): requests/s counts the requests
   that succeeded over the workload's wall time; output tokens/s is null unless every request, a failed one included,
   reported `completion_tokens`, and `usageReported` says how many did. Nothing is stored that replay can derive.
8. **Schedule.** The engines × repeats pairs are shuffled first, then each workload's prompt order is drawn, in schedule
   order, from the same generator. Within a pair the workloads run in the file's order and the sweep in its levels'
   order. The whole schedule, prompt orders included, is in `bench_created`.
9. **Docker is sampled back to back,** no more often than the interval, since one `docker stats --no-stream` takes about a
   second on Docker Desktop. Host memory is also read once at the start, so a workload shorter than an interval has a
   figure.
10. **`baseURL` must end exactly in `/v1`** (no trailing slash, query or fragment), so `<baseURL>/models` and the origin
    for `VERSION_PATHS` are unambiguous. Each check request has 10 s.
11. **Not in the ledger yet:** the answer's text and tool calls. `streamChat` returns them (`content`, `toolCalls`) for
    ticket 02's quality and tool scoring, which decides what to record.
12. **`--engine`, `--out` and `--seed` are `runBench` options** (`engine`, `out`, `seed`); the flags arrive with the
    `ahp bench` command in ticket 02, which also exports `runBench` from `src/index.ts` (the ticket lists the SDK there).
