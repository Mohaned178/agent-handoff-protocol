# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Tickets 01 (tracer bullet), 02 (multi-step linear workflows with handoffs), 03 (hidden tests, protected paths, three-way verdicts with evidence) and 04 (failure classes, retries, handoff revisions) have landed: linear workflows run with the mock adapter, each step under a validated, versioned handoff and verified in a fresh worktree, and a failed attempt is classified and retried, rerouted or ended by policy. No linter is configured.

## Commands

- `npm run typecheck`: `tsc` over `src/` and `test/`, no emit
- `npm test`: the whole Vitest suite; `npx vitest run test/<file>.test.ts` for one file
- `npm run build`: compile `src/` to `dist/` (needed only for `bin/ahp.mjs`)
- `npm run schemas`: regenerate `schemas/*.json` (the published JSON Schemas) from the Zod schemas in `src/protocol/`; a test fails if they are stale
- `node src/cli/bin.ts <command>`: run the CLI from source without building

## Code layout

One package, ESM, Node ≥ 24 type stripping: imports use `.ts` extensions, and `tsc` rewrites them on build, so use only erasable TypeScript syntax (no enums, namespaces or parameter properties). Modules under `src/`: `protocol` (Zod schemas and JSON Schema generation for handoffs, types, closed enumerations and state unions), `ledger` (append-only JSONL, replay), `adapters` (contract, mock), `runtime` (worktrees, snapshots, verification, run executor), `sdk` (public run API), `evaluation` (empty until ticket 20), `cli`. `src/index.ts` is the public SDK entry. `bin/ahp.mjs` checks the Node version, then loads `dist/cli/bin.js`. `schemas/` holds the published JSON Schemas and `scripts/` the script that generates them.

Handoff schemas are Zod (`src/protocol/handoff.ts`); rejection reasons and handoff states are `as const` arrays shared by the schema and the code, so adding one is a protocol change. A step's workspace starts from the previous step's passing snapshot commit, and a handoff's artifact hashes are SHA-256 over blobs read from that commit (`src/runtime/artifacts.ts`), never from a working tree (ADR 0005). An adapter reports a step's output fields through `AttemptExit.reportedOutput`; they are an agent claim that verification checks, and never files in the workspace. AHP-created worktrees get `core.longpaths` through git's per-worktree config, which turns on `extensions.worktreeConfig` in the repository (see `src/runtime/workspace.ts`).

Failure handling is `classifyAttempt` and `decideAfterFailure` (pure, `src/runtime/failure.ts`) driven by `executeStep` in `src/runtime/run.ts`; `FAILURE_CLASSES` is a closed list like the rejection reasons. Retry budgets are counted by replay (`StepView.retryUsage`), never in memory, and a retry is a new attempt in a new workspace from the step's base commit. An attempt whose agent did not end cleanly is classified from `AttemptExit` (`error`, `stopReason`, exit code) and is not verified. A retry after a failed verification issues a new handoff revision whose `evidence` omits the output of hidden tests (`retryEvidence` in `src/runtime/handoff.ts`). Time goes through a `Clock` (`ExecuteRunOptions.clock`): tests that can wait pass `fakeClock()` from `test/helpers/clock.ts` and never really sleep.

Ledgers live at `<git common dir>/ahp/runs/<run>/ledger.jsonl`; snapshots are pinned under `refs/ahp/snapshots/<run>/<attempt>`. Worktrees live outside every repository at `<AHP_HOME>/worktrees/<run>/<attempt|verification>` (per-user state dir by default, see `src/runtime/paths.ts`) so Node resolution and config lookups from a worktree can never reach the user's checkout. Tests set `AHP_HOME` to a temp dir in `test/helpers/setup.ts`.

Tests are at seam 1 (SDK run API + mock adapter against real temporary git repos, `test/run.test.ts`) and a few CLI child-process tests (`test/cli.test.ts`); classification and the retry decision are also tested as tables (`test/failure.test.ts`). Assert only on observable behaviour. The default retry budget is 2, and the mock adapter has no script for an attempt you did not give it, so a test whose step fails by design and scripts one attempt sets `retry: { budget: 0 }`.

Git remote: public repo https://github.com/Mohaned178/agent-handoff-protocol (default branch `main`). Line endings are normalized to LF via `.gitattributes`.

- `docs/design/ahp-v2-direction.md` is the **current agreed direction** (2026-10-24) and the input to grilling → spec → tickets → implementation. Read it first. It is not frozen; its §9 lists decisions still open.
- `GLOSSARY.md` holds the domain terms and `docs/adr/` the hard-to-reverse decisions; use their vocabulary.
- `docs/diagrams/ahp-user-workflow.excalidraw` shows the **old deck** design and is superseded; it will be redrawn from the spec.
- `AHP-presentation.pdf` is the original 15-slide design deck. Where it conflicts with the v2 direction, v2 wins. To read it as text: `pdftotext -layout AHP-presentation.pdf -` (the Read tool's PDF rendering needs `pdftoppm`, which is not installed here).

## Direction in brief

AHP (Agent Handoff Protocol and LLM Evaluation) makes handoffs between AI **coding agents** explicit, verifiable and measurable, and evaluates whether that improves real task outcomes.

- Release 1 targets four coding-agent CLIs: **Claude Code, Codex CLI, Gemini CLI, OpenCode**, combinable in one workflow, each via a dedicated adapter. Core has no provider-specific logic.
- **TypeScript + Node.js**, cross-platform (Windows, macOS, Linux). Publish a support matrix; never claim an adapter works on an OS it was not tested on.
- Components: protocol (versioned spec), SDK, adapters, runtime, append-only event-sourced ledger, evaluation engine, `ahp` CLI.
- Out of scope for release 1: web platform, visual editor, serving/downloading models, inference-engine benchmarking (Ollama/vLLM/SGLang/TensorRT-LLM), reflection/simulation, direct model-provider connections.
- Positioning: ACP is a candidate transport for driving agents; AHP data shapes map to A2A where semantics match, with AHP-specific semantics as an A2A extension profile. Do not invent a competing general-purpose protocol.

## Rules the design depends on

- **Core hypothesis:** structured validated handoffs (with runtime-checked acceptance) beat a single agent and a plain-text pipeline on verified success and context loss. Evaluation conditions C0–C3 (see design doc §7). A negative result is legitimate.
- **Never fabricate results.** Mock adapter output is never evidence. Report usage/cost only where an integration reports it, labelled with its source. Report models as requested vs reported; never claim to discover subscription entitlements.
- **Success = verification passes**, never an agent's self-report.
- **Keep the four concerns separate:** run/step state, handoff validation, attempt state, result verification.
- **`unknown` attempt outcomes are never retried automatically**; they go to `needs_recovery` under an explicit recovery policy: `manual` (default), `adopt` or `abort`. In evaluation they are harness incidents.
- **Verification runs in a fresh verification worktree**, never the agent's live worktree; there is no "Tester" agent.
- **Only AHP performs external actions** (push/PR/merge); no deploy in release 1.
- **A git worktree is workspace isolation, not a security boundary.** Each applied capability carries an enforcement level (`enforced_by_tool` / `cooperative` / `none`). Never describe prompt instructions or ACP permission requests as enforcement.
- AHP never stores provider credentials; adapters use each tool's own login.

## Open decisions (do not silently resolve)

See `docs/design/ahp-v2-direction.md` §9 and `docs/adr/`; §9 is settled except the pilot budget and available keys (open until rollout step 5). Ask the user before picking anything new.

## Platform facts

- The maintainer develops on **Windows only**. Adapter suites run on Windows native and Linux via WSL2; macOS adapter cells stay untested. Node ≥ 24. License Apache-2.0.
- Steps 1–4 of the rollout must not require paid API access; the mock adapter covers development, and real tools are tested under the maintainer's own logins.

## Reference scenario

"Add a password-reset endpoint": plan (Claude Code) → implement (Codex; hidden tests verify, a failure triggers bounded retry) → review (OpenCode; "changes requested" sends implement back) → approval gate → AHP pushes or opens a PR. Use it as the basis for fixtures and demos.

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
