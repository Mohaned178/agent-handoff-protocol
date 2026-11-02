# Local engines for `ahp bench`

AHP never starts, downloads or serves a model (ADR 0007). Start one engine at a time from here, then run the bench.
Each engine serves **Qwen2.5-Coder-7B-Instruct at int4** (spec D2) on its own port, so a bench file can list all four
while only the running one answers. An engine that is not running is recorded as unavailable, never left out.

| Engine | Start | Port | Model as served | Format |
|---|---|---|---|---|
| Ollama | [`ollama.md`](ollama.md) (native Windows) | 11434 | `qwen2.5-coder:7b-instruct-q4_K_M` | GGUF Q4_K_M |
| vLLM | `docker compose -f vllm.yml up` | 8001 | `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ` | AWQ int4 |
| SGLang | `docker compose -f sglang.yml up` | 8002 | `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ` | AWQ int4 |
| TensorRT-LLM | `docker compose -f tensorrt-llm.yml up` | 8003 | `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ` | AWQ int4 |

The maintainer runs Ollama, vLLM and SGLang only (decision 2026-11-01). The TensorRT-LLM file and support stay, untested
and not part of ticket 00's spike; a bench that lists it records it as unavailable.

vLLM and SGLang can also run without Docker, in a WSL2 Python venv (one venv per engine; `nvidia-smi` must work inside
WSL2). Use the flags of the Compose file, and give no `container` for that engine in the bench file (its container
figures are then recorded as not a container). The spike records which way each engine was started.

Images are pinned (checked on their registries 2026-10-31). Change a tag only together with the bench that records it.

Each Docker engine's container is named `ahp-vllm`, `ahp-sglang` or `ahp-tensorrt-llm`. A bench file gives that name as
the engine's `container`, so the bench also records the container's own memory and CPU from `docker stats`; Ollama runs
natively and has none.

The Docker engines need Docker Desktop with the WSL2 backend and GPU support (`docker run --rm --gpus all
nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` must print the GPU). Models are cached in the named volume
`ahp-hf-cache`, so the first start downloads about 5.5 GB.

On an 8 GB GPU the context is the first limit: each file sets `max model length` to 16384 tokens and leaves the rest of
the memory to the KV cache. Ticket 00's spike records what each engine actually fits. OpenCode's system prompt alone is
large, so an engine that cannot hold 16k tokens cannot drive OpenCode.

Stop with `docker compose -f <file> down` (Ctrl+C in the window also works). Run one engine at a time: two do not fit in
8 GB.
