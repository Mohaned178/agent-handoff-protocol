# Seams per ticket

These are the code locations found on 2026-10-31. Line numbers drift, so search by name if one has moved. Each ticket also lists the decisions already taken for it, so you don't re-derive them.

## 00: ADR and spike

**Done:**
- ADR 0007
- `docs/design/ahp-v2-direction.md` §1
- CLAUDE.md's scope lines
- `GLOSSARY.md` "Inference evaluation"
- `bench/engines/`: pinned `vllm/vllm-openai:v0.32.0` on port 8001, `lmsysorg/sglang:v0.5.22` on 8002, `nvcr.io/nvidia/tensorrt-llm/release:1.2.1` on 8003, Ollama native on 11434

**Left for the maintainer:** the spike report `docs/spikes/2026-11-xx-local-engines.md`. Give the maintainer a checklist covering, for each engine:
- the start command
- `curl <base>/v1/models`
- one streamed request with `stream_options.include_usage`
- one tool-call request
- `nvidia-smi` while it serves
- one `opencode run` against it, with the provider block from ticket 03

## 01: Bench core (`src/inference/`)

**Already written:** `engines.ts` (`ENGINES`, `ENGINE_NAMES`, `isEngineId`, `VERSION_PATHS` per engine on the origin, not under `/v1`).

**Decided:**
- **Bench file**, validated like `validateSuite` (`src/evaluation/suite.ts:78`, which keeps an allow-list of keys):
  - `name`
  - `engines: [{ engine, baseURL (ending /v1), model, quantization }]`, each engine id at most once
  - `prompts` (a dir of `<id>/prompt.md`; ticket 02 adds `test.mjs` beside it)
  - `workloads` (01: `latency`, `throughput`; 02 adds `quality`, `tools`)
  - `concurrency` (default `[1,2,4,8]`), `repeats` (default 3), `maxTokens` (default 512), `warmup` (default 2, never recorded as measurements), `timeoutMs` per request (default 120000)
- **Person's workflow:** one engine fits 8 GB at a time, so the person runs `ahp bench <file> --engine <id>` once per engine, and the ticket 02 report combines bench directories.
- **Client:** `POST <baseURL>/chat/completions` with `{ model, messages, stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens, seed: 0 }`, parsed as SSE `data:` lines up to `[DONE]`.
  - TTFT is the first chunk carrying `delta.content` or `delta.tool_calls`.
  - Record inter-chunk gaps.
  - `usage` (`prompt_tokens`, `completion_tokens`) is taken from whichever chunk has it, else null.
  - A non-2xx status is an error carrying the status and the first 300 characters of the body. A timeout is an error.
  - Time with an injectable `now` (default `performance.now`).
- **Throughput:** a pool of `c` workers drains `max(prompts, 4c)` requests, cycling the prompts. Output tokens/s is null unless every request reported usage; record how many did.
- **Order:** prompt order per workload and repeat comes from `seededShuffle(…, seededRandom(seed))` (`src/evaluation/statistics.ts:14,28`), and the seed is recorded.
- **GPU sampling:** `nvidia-smi --id=0 --query-gpu=utilization.gpu,memory.used,power.draw --format=csv,noheader,nounits -lms 500`, run through `resolveExecutable`/`launch` (`src/process/launch.ts:82`) and stopped with `terminate()`.
  - Record peak and mean per metric, `[N/A]` as null, and `source: "nvidia-smi"`.
  - A missing tool gives `gpu: null` with the reason.
- **Fingerprint:** `probe("nvidia-smi", ["--id=0","--query-gpu=name,memory.total,driver_version","--format=csv,noheader,nounits"])` (`src/doctor/probe.ts:28`), plus `os.cpus()[0].model`, the core count, `os.totalmem()` and `osLabelOf(process.platform)` (`src/conformance/result.ts:75`).
- **Engine check:** `GET <baseURL>/models` must list the model, then the version comes from `VERSION_PATHS`. A failure gives `engine_checked { available: false, error }` and every workload of that engine is recorded `workload_skipped`.
- **Ledger events:**
  - `bench_created` (seed, engines, settings, prompts with sha256, fingerprint, schedule)
  - `engine_checked`
  - `workload_started`
  - `workload_ended` (wallMs, requests[], gpu)
  - `workload_skipped`
  - `bench_ended { state: completed | cancelled }`
- **Writer:** `LedgerWriter.create<B>(path)` and `append`/`close` (`src/ledger/writer.ts:48,104,133`). Read back with `readCheckedLedger<B>` (`src/ledger/chain.ts:107`).
- **Replay:** a `BenchView` with a `pending` queue, as `src/evaluation/replay.ts` does.
- **Storage:** `benchesRoot()` = `join(ahpHome(), "benches")` next to `evaluationsRoot` (`src/runtime/paths.ts:44`), or `--out`.
- **Pattern to copy:** `runEvaluation` (`src/evaluation/run.ts`): validate before writing anything, throw a `…InvalidError` listing the problems, `onEvent` and `signal` options.
- **Tests:**
  - `test/helpers/fake-engine.ts`: a `node:http` server on port 0 serving `/v1/models`, `/version` and `/v1/chat/completions` from scripted responses (chunks, delays, usage or none, status).
  - Fake `nvidia-smi` through `installFakeTool`: one CSV line every 50 ms until killed.

## 02: Quality, tools, report, CLI

- **Quality:** pass the prompt's ```` ``` ```` code block to `test.mjs` through a temp dir, and run it with `node --test` through `launch` (`process.execPath`). The outcome is pass, fail, `no_code` or `timed_out`.
- **Tools:** `bench/tools/<id>.json` holds `{ prompt, tools, expect: { name, arguments: { key: value } } }`. The score is `valid_call`, `wrong_tool`, `bad_arguments`, `no_call` or `malformed` (arguments that are not JSON).
- **Report:** p50/p95/p99 (nearest-rank, stated). Engine pairs are compared per prompt: build `TaskTally`s with prompt as task, then `comparePaired` (`src/evaluation/statistics.ts:99`). Every rate has its count beside it.
- **CLI:**
  - Add `"bench"` to `COMMANDS` (`src/cli/args.ts:17`), or a multi-word argument is read as a task.
  - Add help to `USAGE` (`src/cli/main.ts:65`, `eval` at :83) and options to `parseArgs` (:250).
  - Add a switch case like `eval`'s (:341).
  - `ahp bench report <dir>...` combines benches.
- **SDK:** export `runBench` and named types from `src/index.ts` (curated names, not `export *`).

## 03: OpenCode on a local engine

- `configContentOf` (`src/adapters/opencode/policy.ts:12`) currently writes only `{ permission }`. Merge in a `provider: { "ahp-local": { npm: "@ai-sdk/openai-compatible", name, options: { baseURL }, models: { <id>: {} } } }`, threaded through `start()` (`index.ts`, env built at :94).
- **Option:** add `localEndpoint` to `opencode({...})` (`index.ts:23`) and to `validateOptions` (:61), which rejects unknown keys. The model becomes `ahp-local/<id>`, sent by `session/set_config_option` (:134). A refusal already fails the attempt as `config_auth`.
- **Keep the rule** in `docs/adapters/opencode.md:53`: no option changes `permission`. A test asserts `permission` is byte-identical with and without `localEndpoint`.
- **Engine record:** the per-trial tool record `ToolVersionRecord` (`src/evaluation/tools.ts`) gains the engine (name, URL, version from the engine check). Reuse `src/inference`'s check, so there is one implementation.
- **Tests:** the fake `opencode` (`test/helpers/opencode.ts`, `test/opencode.test.ts`). Read `OPENCODE_CONFIG_CONTENT` from the fake's environment.

## 04: Tool-call measures

- **Tool-call log entry** (`src/protocol/index.ts:576`): `{ time, toolCallId, kind, title, status, paths, permission }`. Statuses are `pending`, `in_progress`, `completed`, `failed` and the synthetic `permission_requested`.
- **Path:** `toolCallLogPath` (`src/runtime/paths.ts:119`). A trial's run location is available in `src/evaluation/trial.ts`.
- **Counting:** group by `toolCallId`, take the last status, and count refusals as `permission: "rejected"` lines. A trial whose attempts have no log file gives `null`.
- **Where it goes:**
  1. a field on `trial_ended` (`src/evaluation/events.ts:199`)
  2. `endOf` (`trial.ts:228`), wrapped like `workOf` at :211 (`.catch(() => null)`, never reclassifying a trial)
  3. `conditionReportOf` (`src/evaluation/report.ts:241`), `ConditionReport` (:76) and `formatReport` (:472)
  4. `replay.ts:199` and `src/cli/format-evaluation.ts:35` must accept the field

## 05: Context compression

- **Measure:** read `handoff_issued` from the run ledger (`readRunEvents`, already used at `trial.ts:222`). Size is `Buffer.byteLength(JSON.stringify(handoff.context.fields))`. Handoffs are built in `buildHandoff` (`src/runtime/handoff.ts:47`).
- **Budget:** a new optional `contextBudget: { maxBytes }` on `StepDefinition`, checked in verification on the reported output fields. New evidence kind `context_over_budget`, a closed-list protocol change. Bump the version in `src/protocol/version.ts`, run `npm run schemas`, and keep `test/ledger-releases.test.ts` green.
- **Condition:** `C3c` is C3 (`workflowFor`, `src/evaluation/conditions.ts:145-185`, `full` flag) with the budget on each step, told to the step in its instructions. The default budget is decided in the ticket; recommend 2048 bytes.
- **Places a new condition touches:**
  - `CONDITIONS` (`events.ts:17`)
  - `CONDITION_NAMES` (`report.ts:402`) and the wizard's list (`src/setup/wizard.ts:274`)
  - `CASTING` (`suite.ts:67`)
  - `GATED_CONDITIONS` (`conditions.ts:46`)
  - `workflowFor` (exhaustive switch)
  - `COMPARISONS` (`report.ts:158`)
  - `docs/evaluation.md`

## 06: Reflection

- **`C3r`:** plan → implement → reflect → review.
  - `reflect` is cast to the implement agent: `castAgent(suite, "implement", …)`, so `CASTING` needs no new role.
  - It requires `HANDED_ON` (`conditions.ts:33`) plus `reflection`, uses `acceptanceOf` (:57), and has the gated retry budget.
  - Review's `sendBackTo` must name the step immediately before it, so `reflect`.
- **Places:** the same list as 05. The comparison is `C3r vs C3`.

## 07: Docs and run

- **New doc** `docs/inference-evaluation.md`. Link it from the README and `docs/evaluation.md`.
- **Reproducibility checklist:** image tags (`bench/engines/`), model revision, engine flags, driver, seed, fingerprint.
- **Real results** are committed only from the maintainer's run, as data under `bench/results/<date>/`.
