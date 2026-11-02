# CLAUDE.md

Guidance for Claude Code when working in this repository. Per-ticket history is in `.scratch/<feature>/issues/` and `git log`; the long form of this file is at commit `644ff82`.

## Current state

Release 1 of AHP is built: linear workflows with validated, versioned handoffs, hidden-test verification in a fresh worktree, failure classes and retries, a hash-chained single-writer ledger, crash recovery, cancellation, send-back from review, approval gates, external actions (push/PR/merge by AHP only), capabilities with declared enforcement levels, the conformance suite and support matrix, `ahp doctor`, adapters for Claude Code, Codex and OpenCode, the evaluation engine (conditions C0, C0V, C1, C2, C3min, C3, C3c, C3r, matched-budget baseline), the pilot suite (authored, mock-only, never run against a real tool), and the one-command run `ahp "<task>"`. The inference evaluation (ADR 0007: `ahp bench`, OpenCode on a local engine, tool-call measures, `C3c`, `C3r`) is built on branch `inference-evaluation` (tickets 01 to 06 done; 00's spike and 07, the docs and the maintainer's real run, open). Plain `ahp` opens the full-screen app and the plain commands run from `src/commands/` (`.scratch/new-terminal-ui/spec.md`, tickets 00 to 09 done, 10 the maintainer's first-use test). No linter.

## Commands

- `npm run typecheck`: `tsc` over `src/` and `test/`, no emit
- `npm test`: the whole Vitest suite; `npx vitest run test/<file>.test.ts` for one file
- `npm run conformance -- run <adapter>` / `-- matrix [--write]`: run the conformance suite here and record it, or render the support matrix (`--write` updates `docs/support-matrix.md` and the README table)
- `npm run build`: `src/` to `dist/` (only `bin/ahp.mjs` needs it; also `prepare`)
- `npm run schemas`: regenerate `schemas/*.json` from the Zod schemas in `src/protocol/`
- `node src/cli/bin.ts <command>`: run the CLI from source

## Code layout

One package, ESM, Node ≥ 24 type stripping: imports use `.ts` extensions (`tsc` rewrites them on build), only erasable TypeScript (no enums, namespaces, parameter properties). `src/index.ts` is the public SDK entry; `bin/ahp.mjs` checks the Node version then loads `dist/cli/bin.js`. Modules, one paragraph each:

- **`protocol`**: Zod schemas and JSON Schema generation for handoffs, types, closed enumerations, state unions. Rejection reasons, handoff states, `FAILURE_CLASSES`, `CapabilityKind` etc. are `as const` arrays shared by schema and code, so adding one is a protocol change. `PROTOCOL_VERSION` is 0.2.0; replay refuses a ledger from a newer protocol and still replays older ones (fixtures in `test/fixtures/ledgers/<version>/`, never edit one: the chain is checked). Details: `schemas/`, `docs/a2a-mapping.md`.
- **`ledger`**: append-only JSONL at `<git common dir>/ahp/runs/<run>/ledger.jsonl`; every event has `seq`, `prevHash`, `hash` (SHA-256 of canonical JSON without `hash`). Readers check the whole chain and throw `LedgerCorruptError`; a torn tail is left out. `LedgerWriter` holds `ledger.lock` (host, PID, process start time) from `create`/`open` to `close`; only `ahp recover` takes over a stale lock. It is generic over the event body and throws on a body field named `seq`, `prevHash`, `time` or `hash`. Details: ADR 0006, `docs/how-it-works.md`.
- **`runtime`**: the executor is a loop over replayed state. `drive` (`run.ts`) reads the next action from state derived so far and records at least one event per turn, so any process can pick a run up (`resumeRun`, `recoverAttempt` call the same `drive`). Add behaviour as a case of "state → next action", never as flow held in memory. Retry budgets are counted by replay (`StepView.retryUsage`). Also: worktrees outside every repository at `<AHP_HOME>/worktrees/<run>/<attempt|verification>`, snapshots pinned under `refs/ahp/snapshots/<run>/<attempt>`, a step's workspace starts from the previous step's passing snapshot commit and artifact hashes are over blobs of that commit (ADR 0005), `classifyAttempt`/`decideAfterFailure` (pure, `failure.ts`), review send-back, approval gates (`approval.ts`), external actions (`external.ts`, `pull-requests.ts`), capability resolution (`capabilities.ts`), attempt timeouts (`timeout.ts`), cancel (`cancel.ts`). Time goes through a `Clock`. Details: `docs/how-it-works.md`, `.scratch/ahp-release-1/issues/` (02 to 11, 27), ADRs 0002 to 0005.
- **`process`**: the shared process layer. `resolveExecutable` (on Windows PATHEXT; an npm `.cmd` shim is read for its entry point and run with `process.execPath`; any other `.cmd`/`.bat` is refused), `launch` (execa, `shell: false`, prompt on stdin, `PWD` set to `cwd`, only adds env variables; on Windows only an existing `.exe`/`.com`; `duplex` keeps stdin open; `transcript` writes the raw in/out files), process-tree termination (process group on Linux/macOS plus descendants by parent PID; `taskkill /T /F` on Windows). stderr stays ignored. Details: `.scratch/ahp-release-1/issues/07`, `docs/spikes/2026-10-27-transport-spike-windows.md`.
- **`adapters`**: `contract.ts` (`Adapter`, `AdapterDeclaration`: static and complete, an `EnforcementLevel` per capability and network stance per OS), `mock`, `claude-code`, `codex`, `opencode` (driven over ACP, `acp/`), shared `prompt.ts` and `output-schema.ts`. An adapter reports a step's output fields through `AttemptExit.reportedOutput` (an agent claim that verification checks, never a file), the model and usage only as the tool reported them, appends what its tool reports live (tool calls, messages, usage, limits) to the attempt's activity log (`activity.ts`, `<runs>/<run>/activity/<attempt>.jsonl`; never the record), and throws rather than apply a level above its declaration. Details: `docs/adapters/claude-code.md`, `codex.md`, `opencode.md`, `.scratch/ahp-release-1/issues/15, 16, 18`.
- **`conformance`**: the suite as plain data-returning code (`runConformance`, no Vitest), results one JSON per adapter × OS label in `conformance/results/`, the support matrix. `SUITE_VERSION` is bumped when a check is added or made stricter (`test/conformance-matrix.test.ts` pins `CHECK_IDS`). A real adapter is refused when `CI` is set. A new adapter adds its subject to `scripts/conformance.ts` and its provokers beside the adapter. Details: `docs/support-matrix.md`, `.scratch/ahp-release-1/issues/12, 24`.
- **`doctor`**: `TOOLS` is the one table of the three tools (command, version args, login probe, adapter name, install and log-in commands); `diagnose` runs only version and login-status commands and reads no credential or config. `ahp init` renders the reference workflow through `renderWorkflow` (validated). Details: `.scratch/ahp-release-1/issues/13`.
- **`evaluation`**: tasks (a directory with `task.json`, `repo/`, `hidden/`) frozen by hash in an evaluation ledger (its own event union), conditions that build ordinary `WorkflowDefinition`s, independent validators (never the run's own verdict), seeded schedules, bootstrap comparisons, safeguards (spend cap, incident threshold, tool versions). No run ledger holds the hidden tests; only validators do. An `unknown` attempt ends a trial as a harness incident. Details: `docs/evaluation.md`, `docs/pilot.md`, `.scratch/ahp-release-1/issues/20 to 23, 27`.
- **`inference`** (the only module that speaks HTTP to a model): `runBench` (`ahp bench`) measures latency, throughput, quality and tool calls of Ollama, vLLM, SGLang and TensorRT-LLM over their OpenAI-compatible API, ledger in `<AHP_HOME>/benches`; AHP never starts or serves a model, the person starts each engine (`bench/engines/`). OpenCode on a local engine is `opencode({ localEndpoint })` (`src/adapters/opencode/local.ts`). Details: ADR 0007, `.scratch/inference-evaluation/spec.md` (`docs/inference-evaluation.md`: setup, reproducibility checklist, reading the report; results go in `docs/results/inference-evaluation-<date>.md` only from the maintainer's real run).
- **`sdk`**: the public run API (`runWorkflow`, `resumeRun`, `approveStep`, `rejectStep`, `recoverAttempt`, `inspectRun`, `listRuns`).
- **`cli`, `setup`**: `src/cli/bin.ts` is all of `cli`: on a terminal, no arguments or `ahp "<task>"` opens the app (`src/tui/open.ts`, loaded only then); anything else is a plain command. `setup` holds the logic the app and the plain commands share (check and install inference, casting, models, settings, repository readiness, the task workflow, the demo), with no printing. `ahp setup|settings|init` only answer "moved into the app". Details: `.scratch/new-terminal-ui/`.
- **`commands`**: the plain commands for CI, scripts, pipes and agents (`main.ts`; one parser and usage text in `args.ts`; lines, no colour, no questions; exit 0 passed, 1 failed, 2 usage, 4 waiting for a person), `ahp "<task>" --yes`, `clean`, and the data both front ends use (`receiptOf`, the task session). Details: `.scratch/new-terminal-ui/issues/08`.
- **`tui`**: the app (Ink, no JSX: `h()`), opened by plain `ahp` on a terminal. `theme.ts` tokens only; one key table per screen feeds input and footer; logic in pure `*-model.ts`. The run screen is `runModel` over what `follow.ts` reads from the ledger and activity logs (from their last offsets) plus the live diff (`live-diff.ts`); the receipt as data is `receiptOf` (`src/commands/receipt.ts`), which `src/commands/receipt-text.ts` renders for the plain commands. Details: `.scratch/new-terminal-ui/`.

Also: `schemas/` (published JSON Schemas), `scripts/` (generators), `pilot/` (pilot tasks and suites), `bench/` (bench assets). `docs/troubleshooting.md` quotes every refusal and stop line verbatim: change it when a message changes.

## Rules the design depends on

- **Core hypothesis:** structured validated handoffs (with runtime-checked acceptance) beat a single agent and a plain-text pipeline on verified success and context loss. A negative result is legitimate.
- **Never fabricate results.** Mock adapter output is never evidence. Report usage and cost only where an integration reports it, labelled with its source, never summed across tools, never estimated; a number not reported is null, never 0. Report models as requested vs reported; never claim to discover subscription entitlements.
- **Success = verification passes**, never an agent's self-report. "reported done" and "verified" are different words.
- **Keep the four concerns separate:** run/step state, handoff validation, attempt state, result verification.
- **`unknown` attempt outcomes are never retried automatically.** They go to `needs_recovery` under a recovery policy: `manual` (default), `adopt` or `abort`. In evaluation they are harness incidents.
- **Verification runs in a fresh verification worktree**, never the agent's live one; there is no "Tester" agent.
- **Only AHP performs external actions** (push/PR/merge); a changed shared ref fails verification; no deploy in release 1.
- **A git worktree is workspace isolation, not a security boundary.** Each applied capability carries an enforcement level (`enforced_by_tool` / `cooperative` / `none`), declared statically per adapter × OS and read before the agent starts. Prompt instructions and ACP permission requests are `cooperative`, never enforcement (`docs/limits.md`).
- AHP never stores provider credentials; adapters use each tool's own login.

## Release scope

- Release 1: **Claude Code, Codex CLI, OpenCode**, combinable in one workflow, each via a dedicated adapter; the core has no provider-specific logic. Gemini CLI was dropped on 2026-10-30: do not re-add it unless the maintainer asks (the ACP pieces it shared stay, used by OpenCode).
- TypeScript + Node.js, cross-platform; publish a support matrix and never claim an adapter works on an OS it was not tested on. License Apache-2.0.
- Out of scope: web platform, visual editor, serving/downloading models, simulation, direct model-provider connections in the runtime.
- In scope since 2026-10-31 (ADR 0007): inference-engine evaluation (`ahp bench`; `ahp eval` through OpenCode on a local engine), reflection (`C3r`), checked context compression (`C3c`), tool-call measures.
- ACP is a candidate transport; AHP shapes map to A2A where semantics match. Do not invent a competing general-purpose protocol.

## Platform facts

- The maintainer develops on **Windows only** (Windows Terminal). Adapter suites run on Windows native and Linux via WSL2; macOS cells stay untested. No Docker (engines run native or in a WSL2 venv). Development needs no paid API access: the mock adapter covers it, and real tools are tested under the maintainer's own logins.
- On this machine the Bash tool chokes on big heredocs and `node -e` patches: use Write and Edit for file content.
- Reference scenario for fixtures and demos, "Add a password-reset endpoint": plan (Claude Code) → implement (Codex; hidden tests verify, bounded retry) → review (OpenCode; "changes requested" sends implement back) → approval gate → AHP pushes or opens a PR.

## Tests

Tests are at seam 1: the SDK run API plus the mock adapter against real temporary git repos (`test/run.test.ts`, `recovery`, `cancel`, `sendback`, `approval`, `external-actions`, ...), the process layer with fake tools as real child processes, a few CLI child-process tests, and pure tables (`test/failure.test.ts`). Assert only on observable behaviour.

- `test/helpers/setup.ts` sets `AHP_HOME` to a temp dir. Never run a real `claude`, `codex`, `opencode`, `gh`, `nvidia-smi` or `docker`: use the fakes (`installFakeTool` in `test/helpers/fake-tools.ts`, `claude.ts`, `codex.ts`, `opencode.ts`, `fake-gh.ts`, `fake-gpu.ts`, `fake-engine.ts`, `fakePullRequests()`). A test that looks at tools sets PATH with `pathWithoutTools()`.
- Time: pass `fakeClock()` (`test/helpers/clock.ts`) wherever a run can wait. Attempt timeouts use real timers, so their tests use a few hundred ms.
- Mock scripts: the mock has no script for an attempt you did not give it, so that attempt is `unknown` and the run stops in `needs_recovery`. The default retry budget is 2; a step that fails by design and scripts one attempt sets `retry: { budget: 0 }`. A script is indexed by a step's own attempt number, and after a send-back attempt numbers keep counting (a step sent back once needs two scripts). `mockScripts` covers a retry budget of 3. Cancel tests abort the SDK `signal` from `onEvent` and use the mock's `spawnGrandchild`, `ignoreSignals`, `pidFile`.
- Ledgers: tests that append hand-made events use `appendLedgerEvent` (`test/helpers/ledger.ts`), written from the ticket, not imported. A dead PID is `GONE_PID`, never an exited child's PID (Windows reuses it). Crash tests kill an `ahp run` child (`startRun`, `test/helpers/process.ts`) held by `hangBeforeSpawn`/`hang`, and kill the orphaned agent by PID before cleanup. `truncateLedgerAfter` simulates a crash point.
- Windows: a conformance full run starts dozens of processes (about 20 s), so tests use `only`; Ctrl+C is tested on Linux and macOS only; an `fs.watch` can miss changes.
- Generated docs (support matrix, README table, schemas) fail their tests when stale; `test/package.test.ts` checks the tarball.

## Open decisions (do not silently resolve)

`docs/design/ahp-v2-direction.md` §9 (settled except the pilot budget and available keys) and `docs/adr/`. Ask the user before picking anything new. The new terminal app's decisions D1 to D10 wait for "go" (`.scratch/new-terminal-ui/spec.md`).

## Where to look

- `docs/design/ahp-v2-direction.md`: the agreed direction (2026-10-24), read it first. `GLOSSARY.md`: domain terms (use its vocabulary). `docs/adr/`: hard-to-reverse decisions.
- Other docs: `how-it-works`, `evaluation`, `adapters/*`, `limits`, `support-matrix`, `troubleshooting`, `a2a-mapping` (a mapping only, no code emits A2A), `spikes/` (transport evidence on Windows).
- `docs/diagrams/ahp-user-workflow.excalidraw`: the reference scenario; keep it in step with the glossary.
- Git remote: https://github.com/Mohaned178/agent-handoff-protocol (default branch `main`); line endings are LF via `.gitattributes`.

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
