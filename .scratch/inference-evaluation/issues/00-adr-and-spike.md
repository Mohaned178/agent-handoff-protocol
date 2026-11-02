# 00: ADR, direction and the local-engine spike

**Implement with:** Sonnet 5.5, effort medium

**What to build:** Write down the scope change, give the person a launcher for each engine, and find out on this machine
what each engine can do with the chosen model.

**Blocked by:** none

**Status:** in progress (docs and launchers done 2026-10-31; the spike needs the maintainer's machine)

- [x] ADR 0007: inference evaluation and reflection are in scope. Local models reach the runtime only through
      OpenCode's custom provider, and only `src/inference/` speaks HTTP to a local engine.
- [x] `docs/design/ahp-v2-direction.md`, CLAUDE.md and `GLOSSARY.md` updated
- [x] `bench/engines/`: Compose files with pinned images for vLLM, SGLang and TensorRT-LLM, and `ollama.md`
- [ ] Spike, run by the maintainer (Ollama, vLLM and SGLang only; TensorRT-LLM dropped from the spike 2026-11-01, Docker
      optional, WSL2 allowed): for each engine, record in `docs/spikes/2026-11-xx-local-engines.md`:
  - does it serve Qwen2.5-Coder-7B int4
  - the largest context that fits
  - the tool-call parser
  - whether usage is returned in a stream
  - whether OpenCode can drive it
- [ ] Fallback, if any engine fails, decided with the maintainer (spec D8)
- [ ] Model pinned by revision: the Hugging Face commit of `Qwen/Qwen2.5-Coder-7B-Instruct-AWQ` added to each Compose
      file (`--revision`, or the engine's own flag), and the digest of Ollama's `qwen2.5-coder:7b-instruct-q4_K_M` and
      Ollama's version written in `ollama.md`; the bench records both
