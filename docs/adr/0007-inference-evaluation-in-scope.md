# Inference-engine evaluation and reflection are in scope

On 2026-10-31 the maintainer decided that the project must match its brief, which asks for an evaluation of vLLM,
SGLang, TensorRT-LLM and Ollama on latency, throughput, resource use and task quality, and for reflection, context
compression and tool calling in the handoff framework. This reverses the release-1 exclusion in
`docs/design/ahp-v2-direction.md` §1.

The decision keeps the core free of provider logic:

- `ahp bench` (`src/inference/`) is the only module that speaks HTTP to a model, and only to an OpenAI-compatible
  endpoint the person runs locally.
- Local models reach the runtime only through OpenCode's custom provider. The runtime still drives coding agents
  through adapters and never a model directly.
- AHP never starts, downloads or serves a model. The person starts each engine from `bench/engines/`.
- Reflection and context compression are evaluation conditions (`C3r`, `C3c`). A context budget is a verification
  check, never a prompt alone.

## Consequences

- Results depend on hardware. Every bench records the hardware fingerprint, the engine version and the quantization,
  and engines are compared only on the same machine.
- One model is served at int4 everywhere, but the formats differ (AWQ, GGUF), so an engine comparison is a comparison
  of engine plus format, and is reported as such.
- An engine that cannot run on the hardware is reported with its error, never left out.
