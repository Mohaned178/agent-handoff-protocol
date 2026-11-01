# Inference evaluation: results of 2026-11-02 (partial)

**Status: partial.** One of the three engines the maintainer chose was measured: **Ollama**. vLLM and SGLang were **not**
measured; they are listed below with the errors the spike recorded. TensorRT-LLM is out of scope (maintainer decision
2026-11-01). Nothing here compares engines against each other, because only one has data. The Ollama evaluation (verified
success on the pilot tasks) had not finished when this was written; its section says so.

## What was run

- **Machine:** NVIDIA GeForce RTX 4060, 8188 MiB, driver 621.01; AMD Ryzen 5 5500 (12 cores); 15.9 GiB RAM; Windows 11.
- **Model:** Qwen2.5-Coder-7B-Instruct, GGUF Q4_K_M, as `qwen2.5-coder:7b-instruct-q4_K_M`.
- **Engine:** Ollama 0.40.13, native on Windows, started with `OLLAMA_CONTEXT_LENGTH=16384`.
- **Bench:** `ahp bench bench/local.mjs --engine ollama --seed 20261101`: workloads latency, throughput (concurrency 1, 2, 4,
  8), quality and tools; 3 repeats; `max_tokens` 512; 2 warmup requests.
- **Source of every number below:** `bench/results/2026-11-02/ollama-report/report.json` (text form: `report.txt` beside it;
  ledger in `bench/results/2026-11-02/ollama/`). Commit `bdf4f3c`.

## Ollama

| Measure | Result (p50 / p95 / p99 where given) |
|---|---|
| Time to first token, one request at a time | 54.6 / 79.3 / 85.4 ms (n=24) |
| Request latency, one request at a time | 2411 / 6289 / 6344 ms (n=24) |
| Inter-chunk gap | 19.5 / 22.6 / 24.1 ms (n=4053 gaps; a chunk is not a token) |
| Output tokens/s, concurrency 1 / 2 / 4 / 8 | 49.0 / 50.3 / 50.0 / 49.4 (median of 3 repeats) |
| Time to first token at concurrency 8 | 23478 / 26301 / 28538 ms (n=96) |
| Code quality | 18 of 24 passed (75.0%) |
| Valid tool calls | **0 of 15** (all `no_call`) |
| GPU memory | peak 6424 MiB of 8188; utilization mean 94.0% |
| Machine memory / CPU | peak 8.8 GiB; CPU mean 19.6% |

Reading it:

- **Throughput does not grow with concurrency.** Output stays near 50 tokens/s at every level, so extra requests queue:
  time to first token rises from 54.6 ms (one at a time) to a median of 23.5 s at concurrency 8.
- **Quality by prompt:** `fizzbuzz`, `flatten`, `lru-cache`, `merge-intervals`, `palindrome` and `roman` passed 3 of 3;
  `group-by` and `parse-duration` passed 0 of 3.
- **Tool calls: a negative result, reported as found.** In all 15 requests (5 cases × 3 repeats) the model wrote the call as
  text in the message instead of in `tool_calls`, so none counts as valid. The spike saw the same on 3 of 3 requests.
  That is this model's output under Ollama's parser for it, not a finding about other models.
- **Power** was not reported by `nvidia-smi` on this machine (`n/a`); the container figures do not apply (Ollama is not a
  container).

## vLLM and SGLang: not measured

| Engine | Result | Error recorded in `docs/spikes/2026-11-xx-local-engines.md` |
|---|---|---|
| vLLM 0.32.0 (WSL2 venv) | started only after four changes to the Compose flags; **no bench was run** | the Compose value `--gpu-memory-utilization 0.9` is refused (6.93 of 8.0 GiB free); the final configuration needed `--enforce-eager`, `--kv-cache-dtype fp8`, `--attention-backend TRITON_ATTN` and `VLLM_USE_FLASHINFER_SAMPLER=0`; OpenCode requests were refused or slow (about 5 to 6 tokens/s measured directly) |
| SGLang 0.5.22 (WSL2 venv) | **never ready** | JIT compile of `awq_marlin_repack` failed: no `nvcc`, then `/usr/bin/ld: cannot find -lcudart` |
| TensorRT-LLM | not attempted | out of scope for this run |

These are the spike's findings, not benchmark results. Their numbers, if the engines are brought up later, will be added from
their own `report.json` files.

## Verified success on the pilot tasks

The Ollama evaluation (`pilot/local/ollama.mjs`, 6 tasks × conditions C0, C0V, C3, C3c and C3r, 1 repeat, seed 20261101)
was still running when this was written, and had no complete report. **No verified-success figure, and no comparison of C3c
or C3r against C3, is claimed here.** Its ledger is being written to `pilot/results/2026-11-02/ollama/`. The partial
trials seen so far were failures, which fits the 0 of 15 tool-call result above, but a handful of trials is not a result.
This section will be filled from that evaluation's report.

## Limits

- One GPU, one model, one machine, one engine measured.
- The quantization differs by engine in the plan (AWQ against GGUF Q4_K_M), so a future engine comparison is also a format
  comparison.
- 3 repeats and 8 prompts give small samples; p99 of fewer than 100 values is the slowest of them.
- The model's int4 quality on 8 coding prompts says little about its quality on real tasks.
