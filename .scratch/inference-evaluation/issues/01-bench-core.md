# 01: Bench core: latency, throughput, resources

**Implement with:** Opus 5.5, effort high

**What to build:** `src/inference/`: a bench file, a streaming client that times each request, workloads at fixed
concurrency, GPU sampling, a hash-chained bench ledger and replay.

**Blocked by:** none (tests use a fake engine; the spike only tunes the launchers)

**Status:** open

- [ ] `ENGINES` closed list (`ollama`, `vllm`, `sglang`, `tensorrt_llm`)
- [ ] Bench file validated, refusing unknown keys:
  - `engines: [{ engine, baseURL, model, quantization }]`
  - `prompts`
  - `concurrency`
  - `repeats`
  - `maxTokens`
  - `warmup`
- [ ] Streaming `/v1/chat/completions` client:
  - measures TTFT, inter-token gaps and end-to-end latency
  - asks for usage with `stream_options.include_usage` and keeps it only as reported, else null
- [ ] Workloads:
  - latency at concurrency 1
  - a throughput sweep, giving requests/s, and output tokens/s from reported usage only
- [ ] Order of engines × repeats from a seed (`seededShuffle`)
- [ ] GPU sampled with `nvidia-smi` through the process layer: peak and mean memory, utilization and power, the source
      named; null when `nvidia-smi` is missing
- [ ] Engine check before any workload: `/v1/models` lists the model. An engine that fails is recorded as
      `engine_unavailable` with the error, and the bench goes on with the others
- [ ] Hardware fingerprint recorded once: GPU, VRAM, driver, CPU, RAM, OS label
- [ ] Ledger through `LedgerWriter<B>` and replay; stored in `<AHP_HOME>/benches/<id>` or `--out`
- [ ] Tests against `test/helpers/fake-engine.ts` (an HTTP server with scripted SSE) and a fake `nvidia-smi`
