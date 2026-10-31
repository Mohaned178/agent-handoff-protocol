# Inference evaluation, compression, reflection and tool calling

Status: agreed 2026-10-31 (maintainer). Plan: `C:\Users\pc\.claude\plans\my-project-should-be-misty-parasol.md`.

## Why

The project brief asks for two things:

1. A handoff framework covering delegation, provenance, context compression, reflection, human checkpoints, multi-agent
   workflows and tool calling.
2. An evaluation of vLLM, SGLang, TensorRT-LLM and Ollama on latency, throughput, resource use and task quality, in a
   reproducible environment.

Release 1 so far covered most of the first half and ruled the second out (`docs/design/ahp-v2-direction.md` §1). The
maintainer decided on 2026-10-31 that the project must match the brief, especially the second half. ADR 0007 records
the change.

## Decisions

- **D1. Two layers.**
  - `ahp bench` measures each engine directly over its OpenAI-compatible API: latency, time to first token, throughput
    under concurrency, GPU and memory use, code quality on small prompts, and tool-call validity.
  - `ahp eval` runs the pilot tasks through OpenCode backed by each engine, so task quality means verified success.
- **D2. One model everywhere: Qwen2.5-Coder-7B-Instruct at int4.**
  - AWQ on vLLM, SGLang and TensorRT-LLM; GGUF Q4_K_M on Ollama.
  - The quantization differs by engine and is recorded with every result.
  - Hardware: RTX 4060 with 8 GB VRAM, 16 GB RAM, Windows 11 with WSL2 and Docker Desktop.
- **D3. The person starts an engine; AHP never starts a container.**
  - `bench/engines/` holds the launchers: Docker Compose files with pinned tags, and Ollama run natively.
  - AHP checks that the engine serves the model (`/v1/models`) and records its version.
- **D4. Never fabricate.**
  - A number an engine does not report (such as token usage) is null and never counted from chunks.
  - An engine that cannot run on this hardware is reported with its error, never left out.
  - Fake engines in tests are never evidence.
- **D5. Context compression is checked, not asked for.**
  - Every trial records the size of each handoff.
  - Condition `C3c` adds a byte budget on handed-on fields, which verification enforces (evidence `context_over_budget`).
- **D6. Reflection is a condition, not a runtime feature.** `C3r` adds a `reflect` step, played by the implement agent,
  between implement and review.
- **D7. Tool calling is measured at two levels.**
  - The bench scores tool-call prompts.
  - The evaluation counts each attempt's tool calls from the tool-call log: null for an adapter that keeps none.
- **D8. Fallback.** If the spike (ticket 00) shows that an engine cannot serve the 7B int4 model in 8 GB, the
  maintainer decides the fallback. Nothing is swapped silently.

## Tickets and who implements them

`issues/00` to `issues/07`. Order: 00 → 01 → 02 → 03; 04, 05 and 06 are independent of the bench; 07 comes last.

How a model is chosen (as in `.scratch/new-terminal-ui/spec.md`):
- **Opus 5.5** for a ticket that sets an architecture later tickets build on, crosses an adapter, or changes the protocol.
- **Sonnet 5.5** for work on a settled base that follows an existing pattern.
- **Haiku 5.5** for mechanical work with a clear list. None of these tickets qualifies.

| # | Ticket | Model | Effort | Why this model |
|---|---|---|---|---|
| 00 | ADR, direction, spike | Sonnet 5.5 | medium | what is left is the spike checklist and recording the maintainer's findings; no code |
| 01 | Bench core | Opus 5.5 | high | sets the bench's architecture: ledger events, replay, the timing client, GPU sampling through the process layer; 02 and 03 build on it, and the never-fabricate rules for timings and tokens live here |
| 02 | Quality, tools, report, CLI | Sonnet 5.5 | high | scoring tables and a report over a settled ledger, reusing `comparePaired`; many small cases to get right |
| 03 | OpenCode on a local engine | Opus 5.5 | high | crosses the OpenCode adapter's config and permission rule (a security-relevant invariant) and the evaluation's per-trial tool record |
| 04 | Tool-call measures | Sonnet 5.5 | medium | one field plumbed through the trial, replay and report, as `work` already is |
| 05 | Context compression | Opus 5.5 | high | a protocol change: a step field, a new evidence kind in verification, a version bump, schemas, and old ledgers that must still replay |
| 06 | Reflection | Sonnet 5.5 | medium | a new condition built like C3, touching a known list of places, with no runtime change |
| 07 | Docs and the real run | Sonnet 5.5 | medium | user docs and a reproducibility checklist; the run is the maintainer's |
