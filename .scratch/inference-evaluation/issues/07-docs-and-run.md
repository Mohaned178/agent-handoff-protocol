# 07: Docs and the real run

**Implement with:** Sonnet 5.5, effort medium

**What to build:** A user doc for the inference evaluation, then the maintainer's real run, whose results are committed
as data.

**Blocked by:** 01 to 06

**Status:** open

- [x] `docs/inference-evaluation.md`:
  - setup
  - the reproducibility checklist: image tags, model revision, flags, driver, seed
  - reading the report
- [x] README and CLAUDE.md sections
- [ ] The real run on the maintainer's machine. Nothing is claimed before it exists
- [ ] The results write-up, the brief's deliverable, in `docs/results/inference-evaluation-<date>.md`:
  - engines compared on latency, throughput, resources, quality and tool calls
  - each engine's verified success on the pilot tasks
  - handoff conditions compared, C3c and C3r included
  - every number copied from a `report.json` that is named; charts made from the same numbers
  - the limits stated: one GPU, one model, format differs by engine
  - an engine that could not run listed with its error
  - a negative result reported as found

## Progress (2026-11-02)

Done by Sonnet 5.5: the doc, and the README, CLAUDE.md and `docs/evaluation.md` pointers. **Still open, and the maintainer's:**
the real run and `docs/results/inference-evaluation-<date>.md`. Status stays `open`.

Notes:
1. `docs/inference-evaluation.md` says plainly that no result exists yet. The spike so far (Ollama and vLLM served the model but wrote
   tool calls as text; SGLang never became ready) is in `docs/spikes/2026-11-xx-local-engines.md`, not repeated in the doc.
2. `pilot/local/common.mjs` now lists C0, C0V, C3, C3c and C3r (maintainer: "complete it"), so the write-up can compare
   compression and reflection; 30 trials a repeat instead of 18. `test/pilot-local.test.ts` and `docs/pilot.md` follow.
3. No engine was running on 2026-11-02 (ports 11434, 8001, 8002 empty), so no real run was started.
4. 2026-11-02: real Ollama bench done (`bench/results/2026-11-02/ollama-report/report.json`); a partial write-up is in
   `docs/results/inference-evaluation-2026-11-02.md`. The two boxes stay open: vLLM and SGLang were not measured, and the
   Ollama evaluation was still running. The write-up says so.
