---
name: inference-evaluation
description: Implements a ticket of the inference-evaluation feature (`.scratch/inference-evaluation/issues/00`–`07`): `ahp bench` over vLLM/SGLang/TensorRT-LLM/Ollama, OpenCode on a local engine, tool-call measures, context compression (`C3c`), reflection (`C3r`). Use when asked to do, continue or fix one of those tickets, or to work in `src/inference/` or `bench/`.
---

# Inference evaluation: one ticket at a time

The feature that makes AHP match its brief (ADR 0007). The spec is `.scratch/inference-evaluation/spec.md`, and its decisions D1–D8 are settled: build on them and never re-open them. The plan file with the reasoning is `C:\Users\pc\.claude\plans\my-project-should-be-misty-parasol.md`.

## Steps

1. **Pick the ticket.** Use the one named, else the lowest-numbered `Status: open` whose `Blocked by` tickets are `done`. Order: 00 → 01 → 02 → 03; 04, 05 and 06 are independent; 07 is last. Ticket 00's spike and 07's real run need the maintainer's GPU: prepare them and hand them over, and leave the results for the maintainer to fill in. Done when you can name the ticket and every checkbox it holds.
2. **Read its seams** in [`SEAMS.md`](SEAMS.md) under the ticket's number, then open each file named there before editing it. Done when every file you will change has been read in this session.
3. **Test first.** Write the failing test at the seam the ticket names (fake engine, fake `nvidia-smi`, fake `opencode`, mock adapter), then the code. Run the file with `npx vitest run test/<file>.test.ts`. Done when it is green.
4. **Whole check.** Run `npm run typecheck` and `npm test`, plus `npm run schemas` if any Zod schema in `src/protocol/` changed. Done when all are green. If a failure is unrelated to your change, quote it to the maintainer rather than skipping it.
5. **Record.**
   - In the ticket: tick its boxes, set `Status: done (<date>)`, and add `## Implementation notes (<date>)` with each choice you made that the ticket left open (numbered, with the reason).
   - Add a paragraph on the ticket to CLAUDE.md, in the style of the other ticket paragraphs: names of functions and files, the rule, the tests.
   - Update `GLOSSARY.md` if a term changed.
6. **Commit** on branch `inference-evaluation`: one commit per ticket, with the message naming the ticket and ending with the attribution trailer. Never push.

Stop and ask the maintainer, with a recommendation, whenever a choice is new and not in the spec. In particular, ask before a model fallback (D8), a new image tag, or any new closed-list value beyond the ones the ticket names.

## Rules the code must keep

- **Never fabricate.** A number an engine or tool did not report is `null`, never `0`, never estimated. Tokens come only from the engine's `usage`; chunks are not tokens, so call their timing *inter-chunk*. An unreachable engine is recorded `available: false` with its error and shown in the report.
- **Fakes are not evidence.** A fake engine, fake `nvidia-smi` or the mock never produces a committed result. Real numbers come only from the maintainer's run.
- **AHP never starts, downloads or serves a model.** The person starts each engine from `bench/engines/`. Only `src/inference/` speaks HTTP to a model; the runtime reaches a local model only as OpenCode's provider.
- **Closed lists** (`ENGINES`, `CONDITIONS`, evidence kinds, workloads) are `as const` arrays shared by schema and code. Adding a value is a deliberate change, touching every place listed in `SEAMS.md`.
- **The ledger is state.** Bench and evaluation loops read the next action from replayed state ("state → next action"), never from flow held in memory. A body field may not be named `seq`, `prevHash`, `time` or `hash`.
- **Older ledgers still replay.** Read every new event field with `?? null` or a default.
- **A context budget is a check.** `C3c`'s limit fails verification (`context_over_budget`); a prompt alone is not enforcement.

## Overlap with the new terminal app

The new-terminal-ui feature's ticket 03 renames the tool-call log to the activity log (`activityLogPath`, `<runs>/<run>/activity/<attempt>.jsonl`, with `tool_call` entries). Ticket 04 here counts the `tool_call` entries of whichever log exists when it lands, and keeps reading the old `tool-calls/` path. The terminal app's ticket 09 deletes `src/setup/wizard.ts`, so once that ticket lands a new condition has no wizard list to update. Check `git log` for the other feature's commits before editing a shared file (CLAUDE.md, `src/protocol/`, adapters).

## Gotchas in this repo

- ESM with Node ≥ 24 type stripping: import with `.ts` extensions, and use only erasable syntax (no enums, namespaces or parameter properties).
- Every child process goes through `src/process` (`resolveExecutable`, `launch`, or `probe` from `src/doctor/probe.ts`), never `child_process` directly. On Windows only a real `.exe` runs; `nvidia-smi.exe` and `docker.exe` qualify. stderr is not read.
- Tests set `AHP_HOME` to a temp dir (`test/helpers/setup.ts`). Install fake tools with `fakeToolsDir()` and `installFakeTool()` (`test/helpers/fake-tools.ts`), and put them on PATH with `pathWithFakes()`. The real engines, `nvidia-smi`, `opencode` and `docker` never run in a test.
- Timing tests use real timers with limits of a few hundred ms, and assert bounds, never exact values.
- On this Windows machine the Bash tool chokes on big heredocs and `node -e` patches: use Write and Edit for file content.
- `docs/troubleshooting.md` quotes CLI messages verbatim, and `test/support-matrix.test.ts` and the README markers fail when they are stale. Update them when you change a message the CLI prints.
