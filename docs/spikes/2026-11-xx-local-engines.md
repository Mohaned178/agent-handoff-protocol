# Local engines spike (ticket 00)

**Status:** in progress. Ollama run 2026-11-01 on the maintainer's machine; vLLM and SGLang not yet run (see "Failures and
fallback"). Every value below was read from a real command on this machine; a `_` is still open.

Model: `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ` (Ollama: `qwen2.5-coder:7b-instruct-q4_K_M`). One engine at a time
(`bench/engines/README.md`). Ports: Ollama 11434, vLLM 8001, SGLang 8002, TensorRT-LLM 8003.

**Scope (maintainer decision 2026-11-01):** the spike covers Ollama, vLLM and SGLang. TensorRT-LLM is not run. There is no
Docker on this machine: Ollama runs natively on Windows, vLLM and SGLang in WSL2 Python venvs (`~/venv-vllm`,
`~/venv-sglang`) with the flags of `bench/engines/vllm.yml` and `sglang.yml` plus `--revision`.

## Machine

- GPU / driver / VRAM (`nvidia-smi`, Windows): NVIDIA GeForce RTX 4060, WDDM, driver 621.01 (CUDA UMD 13.5), 8188 MiB;
  532 MiB in use by the desktop before any engine started. Inside WSL2 `nvidia-smi` sees the same GPU (8188 MiB, 621.01).
- Windows 10.0.26300.9818 (Windows 11 Pro); WSL 3.0.3.0, kernel 6.18.54.1-1, WSLg 1.0.79; distribution Ubuntu-24.04
  (Ubuntu 24.04.5 LTS), WSL version 2, 12 CPUs and 7 GiB of memory as seen inside it (`nproc`, `free -g`).
- No Docker (`docker` is not on PATH). WSL2, no Docker.
- OpenCode 1.18.35 (Windows, npm), run from Git Bash.

## Ollama (native Windows, 0.40.13)

1. Start: the Ollama tray app had started again at login and held port 11434 without the 16k setting (the first
   `ollama serve` failed with `bind: Only one usage of each socket address ... is normally permitted`). Both its processes
   were stopped, then in PowerShell `$env:OLLAMA_CONTEXT_LENGTH="16384"; ollama serve`. No edit. Ready at once; the log's
   server config shows `OLLAMA_CONTEXT_LENGTH:16384` and `Listening on 127.0.0.1:11434 (version 0.40.13)`. On the first
   request: `offloaded 29/29 layers to GPU`, `CUDA0 model buffer size = 4168.09 MiB`; `ollama ps`: `5.5 GB  100% GPU
   16384  llamacpp`.
2. `curl http://localhost:11434/v1/models`: lists it.
   `{"object":"list","data":[{"id":"qwen2.5-coder:7b-instruct-q4_K_M","object":"model","created":1793561731,"owned_by":"library"}]}`
3. Version: `GET /api/version` → `{"version":"0.40.13"}`
4. Streamed usage: yes. The last chunk before `[DONE]` (it also carries Ollama's own `timings`, which include the model load
   of the first request):
   `{"id":"chatcmpl-506","object":"chat.completion.chunk","created":1793566306,"model":"qwen2.5-coder:7b-instruct-q4_K_M","system_fingerprint":"fp_ollama","choices":[],"usage":{"prompt_tokens":32,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens":11,"total_tokens":43},"timings":{"prompt_n":32,"prompt_ms":25657,"prompt_per_token_ms":801.78125,"prompt_per_second":1.247222980083408,"predicted_n":11,"predicted_ms":2253,"predicted_per_token_ms":204.8181818181818,"predicted_per_second":4.882379050155349}}`
5. One tool call: **no**. The call comes back as text in `content`, with `finish_reason: "stop"` and no `tool_calls`, the
   same in 3 of 3 requests, although `ollama show` lists the `tools` capability:
   `{"id":"chatcmpl-824","object":"chat.completion","created":1793566316,"model":"qwen2.5-coder:7b-instruct-q4_K_M","system_fingerprint":"fp_ollama","choices":[{"index":0,"message":{"role":"assistant","content":"{\"name\": \"get_weather\", \"arguments\": {\"city\": \"Paris\"}}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":162,"prompt_tokens_details":{"cached_tokens":18},"completion_tokens":17,"total_tokens":179}}`
6. Largest context: prompts of 11905 and 14870 `prompt_tokens` (from `usage`) both answered (2.2 s and 2.1 s, no OOM, no
   truncation in the log). Above the limit Ollama does not refuse: it truncates silently and answers. Prompts of 18053 and
   22606 tokens were logged `msg="truncating input prompt" limit=8194 prompt=18053 keep=4 new=8194` and answered with
   `prompt_tokens: 8194`. Largest that worked: 14870 (configured 16384).
7. `nvidia-smi` while serving (after the 15k prompt): 5867 MiB / 8188 MiB, 100 % utilization.
8. OpenCode: `OPENCODE_CONFIG_CONTENT='{"provider":{"ahp-local":{"npm":"@ai-sdk/openai-compatible","name":"local","options":{"baseURL":"http://localhost:11434/v1"},"models":{"qwen2.5-coder:7b-instruct-q4_K_M":{}}}}}' opencode run -m "ahp-local/qwen2.5-coder:7b-instruct-q4_K_M" "<prompt>"`
   in a throwaway folder outside the repository holding only a `package.json` named `spike-throwaway`.
   - "Reply with the word ok": answered `Ok`, exit 0, 8826 ms.
   - "Read package.json and tell me its name field": **no tool call**. The model wrote the call as text and OpenCode ended
     the turn with it as the answer, exit 0, 5536 ms:
     ````
     ```json
     {"name": "read", "arguments": {"filePath": "package.json"}}
     ```
     ````
     (A first run printed `{"name": "read", "arguments": {"filePath": "/package.json"}}` unfenced; its timing was lost.)
   - Each OpenCode turn sent about 11.9k prompt tokens (Ollama log: `n_tokens = 11969`, `11941`, `11964`), so its system
     prompt and tools fit 16384 with about 4.4k tokens to spare.
9. Tool-call parser: Ollama's built-in one for the model's template (no flag). It did not recognize the model's output as
   a call (step 5).

## vLLM (WSL2 venv, 0.32.0)

The model was downloaded first (it was not on the WSL disk; maintainer decision): `~/venv-vllm/bin/hf download
Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --revision 8e8ed243bbe6f9a5aff549a0924562fc719b2b8a`, 12 files in 21:48, `✓ Downloaded`,
5.2 GB (`model-00001-of-00002.safetensors` 3996422976 bytes, `model-00002-of-00002.safetensors` 1574406784 bytes).

1. Start: `python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --revision 8e8ed24…
   --host 0.0.0.0 --port 8001 --quantization awq_marlin --max-model-len 16384 --gpu-memory-utilization <u>
   --enable-auto-tool-choice --tool-call-parser hermes --seed 0` from `~/venv-vllm`. It took five attempts to reach a
   server that answers; each change after the first was decided with the maintainer:
   1. `0.90` (the Compose value): refused before loading, `ValueError: Free memory on device cuda:0 (6.93/8.0 GiB) on
      startup is less than desired GPU memory utilization (0.9, 7.2 GiB)`. The Windows desktop holds the rest.
   2. `0.85` (lowered by 0.05): weights loaded (`Model loading took 5.29 GiB memory and 19.451735 seconds`), then
      `Available KV cache memory: -0.06 GiB` and `ValueError: No available memory for the cache blocks`.
   3. `0.85` plus `--enforce-eager --max-num-seqs 4 --max-num-batched-tokens 4096`: `Available KV cache memory: 0.6 GiB`,
      `ValueError: To serve at least one request with the model's max seq len (16384), (0.88 GiB KV cache is needed, which
      is larger than the available KV cache memory (0.6 GiB). Based on the available memory, the estimated maximum model
      length is 11216.`
   4. as 3 plus `--kv-cache-dtype fp8`: `GPU KV cache size: 28,592 tokens, Maximum concurrency for 16,384 tokens per
      request: 1.75x`, then `RuntimeError: Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist`
      (FlashInfer compiles its fp8 prefill kernel at start). With `CUDA_HOME` set to the venv's pip `nvcc` (13.4.92):
      `Ninja build failed`, `error: #error "CUDA compiler and CUDA toolkit headers are incompatible, please check your
      include paths"`.
   5. as 4 plus `--attention-backend TRITON_ATTN`: `Application startup complete`, but the first request killed the
      engine with the same `Could not find nvcc` error, now from FlashInfer's top-k/top-p sampler
      (`flashinfer/sampling.py`, `top_k_top_p_sampling_from_logits`). With `VLLM_USE_FLASHINFER_SAMPLER=0` as well it
      serves: `GPU KV cache size: 28,064 tokens, Maximum concurrency for 16,384 tokens per request: 1.71x`, `Actual usage
      is 5.51 GiB for consumed memory (weights + non-torch), 0.54 GiB for peak activation`.

   Steps 2 to 9 below are from configuration 5: `VLLM_USE_FLASHINFER_SAMPLER=0` and `--gpu-memory-utilization 0.85
   --enforce-eager --max-num-seqs 4 --max-num-batched-tokens 4096 --kv-cache-dtype fp8 --attention-backend TRITON_ATTN`.
   curl from Windows reached the WSL server on `localhost:8001` directly.
2. `curl http://localhost:8001/v1/models`: lists it, with `max_model_len` 16384.
   `{"object":"list","data":[{"id":"Qwen/Qwen2.5-Coder-7B-Instruct-AWQ","object":"model","created":1793568515,"owned_by":"vllm","root":"Qwen/Qwen2.5-Coder-7B-Instruct-AWQ","parent":null,"max_model_len":16384,"permission":[…]}]}`
3. Version: `GET /version` → `{"version":"0.32.0"}`
4. Streamed usage: yes. The last chunk before `[DONE]`:
   `{"id":"chatcmpl-a30d3f6fc1b019d2","object":"chat.completion.chunk","created":1793568621,"model":"Qwen/Qwen2.5-Coder-7B-Instruct-AWQ","choices":[],"usage":{"prompt_tokens":32,"total_tokens":43,"completion_tokens":11},"system_fingerprint":"vllm-0.32.0-540ae212"}`
5. One tool call: **no**. 3 of 3 answers put the call in `content` as fenced JSON, `finish_reason: "stop"`, no
   `tool_calls`: `"content":"```json\n{\n  \"name\": \"get_weather\",\n  \"arguments\": {\n    \"city\": \"Paris\"\n  }\n}\n```"`
   (`usage`: `prompt_tokens` 171, `completion_tokens` 29). So under Qwen's own Hugging Face chat template too, the model
   writes no `<tool_call>` tags for the parser to find: the Ollama result (step 5 there) is the model's, not Ollama's
   template.
6. Largest context: 11905 and 14870 `prompt_tokens` both answered (7.5 s and 2.9 s), no OOM or Traceback in the log.
   Above the limit vLLM refuses rather than truncates: `{"error":{"message":"This model's maximum context length is 16384
   tokens. However, your prompt contains at least 16385 input tokens, which exceeds this limit even without any output
   tokens. ...","type":"BadRequestError","param":"input_tokens","code":400}}`. Largest that worked: 14870.
7. `nvidia-smi` while serving: 7697 MiB / 8188 MiB.
8. OpenCode, same command as Ollama's with `baseURL` `http://localhost:8001/v1` and the model
   `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ`: **no answer**. Both prompts ended, exit 0, with
   `Error: max_tokens=32000 cannot be greater than max_model_len=16384. Please request fewer output tokens.` (9766 ms and
   4959 ms): OpenCode asks an unknown model for 32000 output tokens. Ollama ignored that; vLLM refuses it.
   Diagnostic only (not AHP's block): with `"models":{"Qwen/Qwen2.5-Coder-7B-Instruct-AWQ":{"limit":{"context":16384,"output":4096}}}`
   the requests were accepted, but "Reply with the word ok" did not end within 600 s (killed by `timeout`); the vLLM log
   shows OpenCode sending request after request, each answered 200, at `Avg generation throughput` of 2 to 6 tokens/s.
   Measured directly: 200 completion tokens in 42.2 s and 34.0 s (about 5 to 6 tokens/s).
9. Tool-call parser: `hermes` (flag). It found no call in the model's output (step 5).

## SGLang (WSL2 venv, 0.5.22)

`~/venv-sglang` had no `sglang`; reinstalled with `pip install "sglang[all]==0.5.22"` (maintainer decision), exit 0,
`sglang-0.5.22`, `torch 2.14.1+cu130`, `torch.cuda.is_available()` True.

1. Start: `python -m sglang.launch_server --model-path Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --revision 8e8ed24… --host
   0.0.0.0 --port 8002 --context-length 16384 --mem-fraction-static 0.85 --tool-call-parser qwen25 --random-seed 0` from
   `~/venv-sglang`. **Never ready.** Loading the weights (`Load weight begin. avail mem=6.90 GB`) runs SGLang's own JIT
   compile of `awq_marlin_repack` (`sglang/kernels/ops/quantization/awq_marlin_repack.py`), which needs a CUDA toolkit:
   1. venv not activated: `FileNotFoundError: [Errno 2] No such file or directory: 'ninja'`.
   2. venv activated: `/bin/sh: 1: /usr/local/cuda/bin/nvcc: not found`, `RuntimeError: Failed to build JIT module
      sgl_kernel_jit_awq_marlin_repack`.
   3. `CUDA_HOME` set to the venv's pip `nvcc` (`nvidia/cu13`, maintainer decision): it compiled, then the link failed,
      `/usr/bin/ld: cannot find -lcudart: No such file or directory` (the pip package has `lib/libcudart.so.13`, no
      `lib64` and no unversioned `libcudart.so`).
   Memory was not the limit: it failed before the KV cache was sized.
2. to 8.: not reached.
9. Tool-call parser: `qwen25` (flag); not reached.

## Summary

| Engine | Serves the model | Largest context | Tool-call parser | Streamed usage | OpenCode drives it |
|---|---|---|---|---|---|
| Ollama | yes, 100 % GPU, 5867 MiB in use | 14870 tokens answered (limit 16384; above it truncated silently to 8194) | built in; **did not parse** this model's calls (text in `content`) | yes | answers (8.8 s), **no tool call** (5.5 s) |
| vLLM | yes, 7697 MiB in use (configuration 5) | 14870 tokens answered (limit 16384; above it refused with a 400) | `hermes` (flag); **did not parse** this model's calls (fenced JSON in `content`) | yes | **no answer**: `max_tokens=32000 cannot be greater than max_model_len=16384`; with a limit set, it ran at about 5 to 6 tokens/s and a prompt did not end in 600 s |
| SGLang | yes, only after the changes below; 6.8 GB of GPU memory in use | **2048 tokens by choice**: the KV cache held 2850 tokens, so the 16384 of the plan does not fit | `qwen25` (flag); no valid call in 15 of 15 bench requests | yes (the bench's tokens/s come from `usage`) | not tried: 2048 tokens cannot hold OpenCode's prompt (about 12k) |
| TensorRT-LLM | not run (maintainer decision 2026-11-01) | - | - | - | - |

## Pins

- Hugging Face commit of `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ`
  (`git ls-remote https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-AWQ HEAD`, 2026-11-01):
  `8e8ed243bbe6f9a5aff549a0924562fc719b2b8a`. Passed as `--revision` to vLLM and SGLang. `tensorrt-llm.yml` stays
  unpinned: it is not run.
- Ollama version (`ollama --version`): `0.40.13`. `ollama list` ID: `dae161e27b0e`; the manifest's full digest
  (`F:\Ollama\models\manifests\registry.ollama.ai\library\qwen2.5-coder\7b-instruct-q4_K_M`):
  `sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364`, model layer
  `sha256:60e05f2100071479f596b964f89f510f057ce397ea22f2833a0cfe029bfc2463` (4683074048 bytes).

## Failures and fallback (spec D8)

An engine that fails any of 1 to 8 is recorded here with the error. Do not swap the model or engine on your own: bring it
to the maintainer decision (spec D8).

- Ollama, steps 5 and 8: the model's tool calls are not parsed. They come back as JSON text in `content`, and OpenCode
  cannot read a file through it. Decision: _
- vLLM and SGLang, before step 1 (setup, 2026-11-01): `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ` is not on the WSL disk (no
  `~/.cache/huggingface`, no `models--Qwen*` directory anywhere on the WSL file system), and `~/venv-sglang` has no
  `sglang`, `torch` or `flashinfer` (`ModuleNotFoundError: No module named 'sglang'`; the install stopped part way).
  `~/venv-vllm` has `vllm` 0.32.0 and `torch` 2.13.0. Decision: _

## Addendum, 2026-11-02: what the bench runs used

The benches and the Ollama evaluation of `docs/results/inference-evaluation-2026-11-02.md` were run after this spike, on
the same machine.

- **vLLM** ran in configuration 5 (above) unchanged, and served the whole bench with no engine error. Its tool-call
  result in the bench was `no_call` in 15 of 15 requests, as in step 5.
- **SGLang, second run (maintainer's go-ahead to continue):** two symlinks were added inside `~/venv-sglang`'s pip CUDA
  toolkit (`nvidia/cu13/lib/libcudart.so` -> `libcudart.so.13`, and `lib64` -> `lib`), with `CUDA_HOME`, `PATH`,
  `LIBRARY_PATH` and `LD_LIBRARY_PATH` pointing at `nvidia/cu13`. That fixed the `-lcudart` link error of attempt 3 and
  `awq_marlin_repack` compiled. The next failure was SGLang's FlashInfer JIT build, the same `CUDA compiler and CUDA toolkit
  headers are incompatible` error vLLM gave. As for vLLM, avoiding FlashInfer fixed it: `--attention-backend triton
  --sampling-backend pytorch`.
- **SGLang, third run:** the weights loaded (`Load weight end ... mem usage=5.67 GB`), but the KV cache was only
  2850 tokens (`K size: 0.08 GB, V size: 0.08 GB`), and the server stopped at 0 % of "Capture target prefill CUDA graph"
  for about 10 minutes (killed). So **SGLang cannot serve the plan's 16384-token context on this GPU** while the Windows
  desktop holds about 0.5 GiB.
- **SGLang, fourth run (decided with the maintainer: one retry, smaller context):** `--context-length 2048
  --disable-cuda-graph` with the rest as above. It became ready and served the bench. Recorded as a deviation from the
  plan: bench only; it cannot drive OpenCode.
- Final SGLang command: `python -m sglang.launch_server --model-path Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --revision
  8e8ed243bbe6f9a5aff549a0924562fc719b2b8a --host 0.0.0.0 --port 8002 --context-length 2048 --mem-fraction-static 0.85
  --tool-call-parser qwen25 --random-seed 0 --attention-backend triton --sampling-backend pytorch --disable-cuda-graph`.
