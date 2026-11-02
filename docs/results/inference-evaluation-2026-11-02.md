# Inference evaluation: results of 2026-11-02

Three engines were benched on one machine: **Ollama, vLLM and SGLang**. Only Ollama was also evaluated on the pilot tasks.
TensorRT-LLM is out of scope (maintainer decision 2026-11-01). Two findings dominate, and the second limits everything else:

1. **No engine produced a valid tool call**: 0 of 15 on each. The model wrote every call as text.
2. **Because of that, nothing passed the pilot tasks on Ollama** (0 of 6 in every condition, with 0 tool calls made by OpenCode),
   so the handoff conditions, C3c and C3r included, cannot be told apart. This says nothing for or against structured handoffs.

**Sources.** Every number below is copied from `bench/results/2026-11-02/combined-report/report.json` (text form `report.txt`
beside it), built from the per-engine ledgers in `bench/results/2026-11-02/{ollama,vllm,sglang}/` and the evaluation in
`pilot/results/2026-11-02/ollama/`. Seed 20261101 throughout.

## What was run

- **Machine:** NVIDIA GeForce RTX 4060, 8188 MiB, driver 621.01; AMD Ryzen 5 5500 (12 cores); 15.9 GiB RAM; Windows 11.
- **Model:** Qwen2.5-Coder-7B-Instruct at int4: GGUF Q4_K_M on Ollama, AWQ on vLLM and SGLang (revision `8e8ed243…`).
- **Bench:** `bench/local.mjs`: latency, throughput (concurrency 1, 2, 4, 8), quality (8 prompts) and tools (5 cases);
  3 repeats; `max_tokens` 512; 2 warmup requests.
- **How each engine was started** (they are *not* the same configuration):

| Engine | Version | Start |
|---|---|---|
| Ollama | 0.40.13 | native Windows, `OLLAMA_CONTEXT_LENGTH=16384` |
| vLLM | 0.32.0 | WSL2 venv: `--max-model-len 16384 --gpu-memory-utilization 0.85 --enforce-eager --max-num-seqs 4 --max-num-batched-tokens 4096 --kv-cache-dtype fp8 --attention-backend TRITON_ATTN`, `VLLM_USE_FLASHINFER_SAMPLER=0`, parser `hermes` |
| SGLang | 0.5.22 | WSL2 venv: `--context-length 2048 --mem-fraction-static 0.85 --attention-backend triton --sampling-backend pytorch --disable-cuda-graph`, parser `qwen25`; the venv's pip CUDA toolkit as `CUDA_HOME` with two symlinks added in the venv (`libcudart.so`, `lib64`) |

SGLang could not hold the plan's 16,384-token context: after the weights it had a KV cache of 2,850 tokens, and it hung in
CUDA-graph capture. It was relaunched with a 2,048-token context and CUDA graphs off (maintainer chose this retry). The bench
prompts are short, so it ran them, but **this SGLang cannot drive OpenCode and is not the 16k configuration of the plan.**
That is why SGLang has no evaluation.

## Engines compared (bench)

| Measure | Ollama | vLLM | SGLang |
|---|---|---|---|
| Time to first token p50 / p95, one at a time | 54.6 / 79.3 ms | 89.6 / 545 ms | 97.3 / 414 ms |
| Request latency p50 / p95 | 2.41 / 6.29 s | 8.39 / 44.4 s | 7.41 / 33.0 s |
| Output tokens/s, c=1 (median, min–max of 3) | 49.0 (48.7–50.3) | 28.4 (9.5–29.3) | 17.6 (5.3–25.1) |
| Output tokens/s, c=4 | 50.0 (48.1–50.1) | 97.8 (96.8–101) | 59.0 (54.5–87.7) |
| Output tokens/s, c=8 | 49.4 (49.4–49.8) | 101 (98.5–104) | 144 (97.1–153) |
| Time to first token p50 at c=8 | 23.5 s | 5.9 s | 171 ms |
| Code quality (pass) | 18/24 (75.0%) | 9/24 (37.5%) | 18/24 (75.0%) |
| Valid tool calls | 0/15 | 0/15 | 0/15 |
| GPU memory peak (MiB) | 6424 | 7111 | 6814 |
| GPU utilization mean | 94.0% | 42.2% | 33.5% |
| Machine memory peak | 8.8 GiB | 15.6 GiB | 15.4 GiB |

Reading it:

- **Batching.** Ollama's output stays near 50 tokens/s at every concurrency, so extra requests queue. vLLM and SGLang scale
  with concurrency (to about 100 and 144 tokens/s at c=8). Past c=4 the AWQ engines produce more total tokens than Ollama.
- **Single-request speed is unreliable for vLLM and SGLang.** Their c=1 and c=2 ranges are very wide (SGLang c=1: 5.3 to
  25.1 tokens/s), while Ollama's is tight. The two WSL2 engines ran with the machine's memory almost full (15.4 to 15.6 of 15.9
  GiB at peak) and CPU peaking at 100%, and other work ran on the machine at times. The cause was not isolated, so **do not
  read the c=1 gap between Ollama and the others as an engine property.**
- **Quality.** Ollama and SGLang both passed 18/24; `group-by` and `parse-duration` failed 0/3 on both. vLLM passed 9/24:
  `fizzbuzz`, `flatten` and `roman` also failed 0/3. The report's comparison: Ollama higher than vLLM by 0.375 (95% interval
  0.125 to 0.750, 8 prompts); Ollama against SGLang no detectable difference; vLLM lower than SGLang by 0.375 (−0.750 to
  −0.125). The vLLM and SGLang weights are the same AWQ model, so the difference comes from how vLLM was run (an fp8 KV
  cache and the other flags above, among others). It was not isolated, and it is not a statement about vLLM in general.
- **Tool calls: a negative result, as found.** In all 45 requests (3 engines × 5 cases × 3 repeats) the model wrote the call as
  text, not in `tool_calls`; every outcome was `no_call`, and the engines' parsers (Ollama built in, vLLM `hermes`, SGLang
  `qwen25`) found nothing. All three comparisons say no detectable difference. This is about this model's output under these
  parsers, not about the engines' tool-call support in general.
- **Resources.** `nvidia-smi` gave no power reading. No Docker engine was used, so there are no container figures; the host
  figures above are the whole machine's.

## Verified success on the pilot tasks (Ollama only)

`pilot/local/ollama.mjs`: 6 tasks × conditions C0, C0V, C3, C3c and C3r, 1 repeat, 30 trials, all scored, no harness incidents.

| Condition | Verified success |
|---|---|
| C0 (one agent) | 0 of 6 |
| C0V (one agent with check and retry) | 0 of 6 |
| C3 (full AHP) | 0 of 6 |
| C3c (C3 with a context budget) | 0 of 6 |
| C3r (C3 with a reflect step) | 0 of 6 |

OpenCode made **0 tool calls** in every condition (6, 11, 32, 21 and 30 attempts logged), so no agent could edit a file and
every result changed nothing. Every paired comparison (C3 against C0V, C0V against C0, C3c against C3, C3r against C3, C3
against C0) is "no detectable difference", with a mean difference of 0.00. That is a floor effect: it does not test whether
handoffs, compression or reflection help, and it must not be quoted as evidence on either side. The hypothesis stays untested.
vLLM and SGLang have no evaluation: vLLM had the same 0/15 tool-call result in the bench, so the evaluation was not run, and
SGLang's 2,048-token context cannot hold OpenCode's own prompt (about 12k tokens, measured in the spike).

## Not measured

- **TensorRT-LLM:** out of scope.
- **The Docker route:** there is no Docker on this machine; vLLM and SGLang ran in WSL2 venvs, so their container figures
  are absent.
- **vLLM and SGLang evaluations:** not run, for the reasons above.
- **A model that makes tool calls.** Whether the engines differ in verified success needs a model whose calls the parsers
  can read; that choice is the maintainer's (spec D8), and nothing was swapped.

## Limits

- One GPU, one model, one machine, one run per engine, 3 repeats, 8 quality prompts and 5 tool cases: small samples. With
  fewer than 100 values, p99 is the slowest one.
- The format differs (GGUF Q4_K_M against AWQ), and the engines were not started in equivalent configurations (see the table),
  so a difference between engines is also a difference in format and flags.
- The machine was under memory pressure during the vLLM and SGLang runs, and single-request timings varied widely.
- Quality on 8 small prompts says little about quality on real tasks.
