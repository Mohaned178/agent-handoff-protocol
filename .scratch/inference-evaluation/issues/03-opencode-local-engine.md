# 03: OpenCode on a local engine

**Implement with:** Opus 5.5, effort high

**What to build:** Let an OpenCode step use a local OpenAI-compatible engine, so `ahp eval` measures each engine's
verified success on the pilot tasks.

**Blocked by:** 00's spike (OpenCode must be able to drive at least one engine)

**Status:** done (2026-11-01), against fakes only; the repeats of `pilot/local/` wait for the spike's time per attempt

- [x] `opencode({ localEndpoint: { baseURL, models } })`:
  - adds a `provider.ahp-local` block (`@ai-sdk/openai-compatible`) to `OPENCODE_CONFIG_CONTENT`
  - `permission` stays exactly as the capabilities made it
  - the model is `ahp-local/<id>`
- [x] The engine (name, URL, version from `/v1/models` or `/version`) recorded per trial beside the tool versions
- [ ] `pilot/local/`: one suite per engine with the same tasks, conditions and seed. Conditions: C0, C0V, C3, and `C3c`
      and `C3r` once tickets 05 and 06 land, so compression and reflection are measured on free local models too.
      Repeats sized from the spike's time per attempt, so one engine's suite finishes overnight
      (suites done; `REPEATS` is 1 until the spike, note 10)
- [x] `ahp bench report --eval <dir>...`: each engine's verified success beside its speed, compared task by task
- [x] Tests: provider block merged and permissions unchanged, against the fake `opencode`

## Implementation notes (2026-11-01)

1. **Built ahead of the spike.** The ticket is blocked by ticket 00's spike, which needs the maintainer's GPU. Everything
   here runs against fakes (fake `opencode`, fake engine, the mock); nothing shows that OpenCode can drive a real engine.
   The spike's step 8 now uses the exact provider block AHP writes, and asks for the time per attempt.
2. **`localEndpoint` also takes `engine`** (`{ engine, baseURL, models }`, `src/adapters/opencode/local.ts`). The ticket named
   `{ baseURL, models }`, but the engine id is needed to read the version (`VERSION_PATHS`), to name the provider and to
   record the engine per trial. `baseURL` follows the bench file's rule (ending exactly in `/v1`): `isBaseURL` moved from
   `bench.ts` to `engines.ts` so both use it. Unknown keys are refused, as the adapter's own options are.
3. **The model.** `opencode({ localEndpoint })` requests `ahp-local/<first model>`; `model` may be given as `<id>` or
   `ahp-local/<id>`. A step on a local endpoint whose requested model is not `ahp-local/<one of models>` (none included)
   fails as `config_auth` after `session/new` and before any prompt, as a refused model does: OpenCode's default model, a
   cloud one, must never answer in the engine's place. No new closed-list value.
4. **The provider block** is `{ npm: "@ai-sdk/openai-compatible", name: "<Engine> (local, AHP)", options: { baseURL },
   models: { <id>: {} } }`, with no API key and no context `limit`. If the spike shows OpenCode needs the limit for a 16k
   context, it is one more key in `providerBlockOf`.
5. **The engine record is a list on the tool's record** (`ToolVersionRecord.engines: LocalEngineRecord[]`, `events.ts`),
   since a workflow can reach several endpoints. It is optional in the type and read with `?? []`, so older ledgers replay.
   `localTargetsOf` (`src/evaluation/tools.ts`) finds each engine, URL and model once; `recordLocalEngines` checks each with
   `checkEngine` from `src/inference/check.ts` at every trial. A step whose model its endpoint does not list is left out (it
   fails before any prompt).
6. **An engine that does not serve its model when a trial starts** makes the trial `unscored` with the existing reason
   `setup_failed` (its doc comment widened), with no run made and no agent started. Running it would record failures that
   are the evaluation's setup, not the engine's quality. No new closed-list value.
7. **The evaluation report** shows the engines under their tool (`ToolVersionReport.engines`: versions found, trials that
   found it unavailable, the first error), so an unreachable engine is visible there too.
8. **`--eval` (repeatable) needs at least one bench directory.** `verifiedProblems` (`src/inference/verified.ts`) refuses,
   through `BenchesNotComparableError` (exit 2): a mock evaluation, one on no local engine, on several engines or models,
   the same engine in two evaluations, an engine no bench measured, a model other than the bench's, and tasks that differ
   by freeze hash. Per engine the report gives verified success per condition (the evaluation report's `ConditionReport`
   numbers; the baseline is not shown), incidents and unscored apart, and one speed line (latency's TTFT and request latency
   p50, output tokens/s median per concurrency). Engines are compared per condition, each pair in `ENGINES` order, with
   `comparePaired` over `talliesOf` (now exported) and the report's seed.
9. **The seed.** A suite file has no seed key, so `pilot/local/common.mjs` exports `SEED` (20261101) and the comment and
   `docs/pilot.md` give the command with `--seed`. Adding a `seed` key to the suite format was left out (a format change).
10. **`REPEATS` is 1** until the spike gives the time per attempt; the comment in `common.mjs` has the arithmetic (18 trials a
    repeat, about 4 attempts each on average, a 10-hour night). That box stays open.
11. **The suites take each engine's model, URL and id from `bench/local.mjs`**, so the evaluation and the bench cannot
    disagree on the model. Every role is OpenCode on the engine.
12. `stepFlagsOf`'s input type now allows `string[]`, for the repeatable `--eval` in the shared `parseArgs` values.

## Confirmed (2026-11-01)

The maintainer adopted every recommendation (notes 1 to 12, as flagged: building before the spike, `engine` in
`localEndpoint`, a down engine leaves the trial `unscored` `setup_failed`, the model refusal, the seed given as `--seed`
with no suite key, `REPEATS` 1 until the spike). Later tickets treat them as settled.
