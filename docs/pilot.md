# The pilot suite

Ticket 23. `pilot/` holds a ready-to-run pilot for `ahp eval` (`docs/evaluation.md`): six authored tasks and two suite files, one per agent combination. **This repository does not run the pilot.** Running it needs the budget and keys that design doc §9, item 9 leaves open, and nothing in `pilot/` or its tests has ever been run against a real coding agent. The only runs so far are the mock adapter's, which are never evidence about any tool.

The design (§7): "5–8 tasks, 2 agent combinations, 3 repeats per cell. Goals: validator determinism, test discrimination, variance, quota cost per cell, harness bugs. It does not test the hypothesis; the full suite is sized from its numbers." Nothing a pilot of this size reports should be read as a result about C3 against the other conditions; the intervals will be wide.

## What is in `pilot/`

```
pilot/
  common.mjs           the six task directories and REPEATS = 3
  suite-a.mjs          combination A: plan claude-code, implement codex, review opencode
  suite-b.mjs          combination B: plan opencode, implement claude-code, review codex
  tasks/<id>/          task.json, repo/ (the fixture), hidden/ (hidden tests and invariant scripts)
  reference/<id>/      for the tests of the pilot itself, never given to an agent:
    solution/            files that, laid over the fixture, solve the task
    violations/<constraint id>/   files that, laid over the solution, break only that constraint
```

Every task is plain Node (no dependencies, so no `install` and nothing needs the network), is verified by `node --test`, and protects `package.json` and its one visible test file. The fixtures are small (one to three source files each); the reference solutions are 42 to 75 lines of files per task. A task is meant to take a competent developer well under an hour, and the hidden tests assert only what the prompt states.

| Task | The work | Planted constraints (checked deterministically) | Seeded defect (in the fixture) |
|---|---|---|---|
| `password-reset` | Add `requestPasswordReset` and `resetPassword` to an auth module: tokens, 30-minute expiry, single use, case-insensitive email | no `console` calls in `src` (pattern); stored password hashes keep verifying and a failed login returns what it did (invariant script) | `findByEmail` compares emails exactly |
| `orders-listing` | Add status filter, sorting, `totalFormatted` and `formatCents` to an order listing | no `toFixed`, `parseFloat`, `toLocaleString`, `Intl.NumberFormat` in `src` (pattern); the orders passed in are not modified (frozen inputs, invariant script) | `paginate` says `hasMore` on a last page that ends exactly at the end |
| `csv-export` | Add `toCsv` (RFC 4180 quoting, formula guard) and a sales report export | `reportRows` for the shop's own sales unchanged; rows, columns and sales not modified (both invariant scripts) | `reportRows` sorts with a comparator returning a boolean, so it does not sort |
| `config-merge` | Add `resolveConfig` merging defaults, file and environment layers | `parseEnv` keeps returning strings (invariant script); no `structuredClone` or JSON round trip in `src` (pattern) | `isPlainObject` accepts arrays and Dates; `parseEnv` can write to `Object.prototype` |
| `retry-backoff` | Add `withRetry` with exponential backoff, jitter, `Retry-After` and abort | no `Math.random` in `src`; no timers in `src/retry.js` (patterns) | `isRetryable` tests `status > 500`, so a 500 is not retried |
| `inventory-reservation` | Add reserve, release and ship to an inventory | every change, a rejected reserve included, recorded through `audit.record` with the given entry types (invariant script) | `receive` accepts a negative quantity |

What each part is for:

- **Hidden tests** are the only thing a trial's success is scored by. For each task the pilot's tests prove they discriminate: the untouched fixture fails them (and the output shows the runner's own failure count, so it is not a missing command), the reference solution passes them.
- **Planted constraints** are stated once, in `task.json`'s `constraints[].statement`, which is the only place the words appear. The first step of a condition is told them with the prompt (`taskText`); later steps only learn them from what is handed on. They are kept out of the prompt, the fixture and its comments and its visible tests (a test checks this), so a step can only know a constraint by being told. Each is checked by a pattern or by an invariant script in `hidden/`, never by a judgement. For each constraint a "violation" proves the check can fail: it passes the hidden tests and the check still finds it.
- **Seeded defects** are real defects in the fixture that the task's prompt and hidden tests cover without naming: an agent that reads the code finds them, one that only writes the new code may not. **Nothing scores them yet** (ticket 20 records them and freezes them with the task), so the pilot does not measure whether a review step finds a defect. What it does show is whether the hidden tests, which each defect makes a difference to, are passed.

The tasks are frozen like any task (`task_frozen` with the directory's hash before the first trial). The hidden tests are in the run ledger of the C3 trial's repository, which an agent could read (docs/evaluation.md, "What an evaluation does not hide from an agent"); read a transcript before trusting a pass on a task.

## What is left for the maintainer to decide

The suites set the combinations, the repeats and the tasks. They do **not** set, on purpose:

- **`model` for each agent.** A tool's own default runs when it is left out, and the report shows the requested model as not requested and the reported model as the tool's. Name models once the keys and budget are known.
- **`spendCap`.** It follows the budget. It only sees cost a tool reports: Claude Code reports a cost and Codex does not (below), so a cap would stop on Claude Code's spend alone. **Set a spend limit in each provider's console too.**
- **`maxIncidentRate`.** The pilot exists to measure it (design doc §9, item 3).
- **`toolVersions`.** Pin what `ahp doctor` shows on the day. A trial records the version it found either way.

## Running it

Not before: API-key logins configured in each tool (`docs/evaluation.md`, "Before a real evaluation"), provider-console spend limits, and the dated terms review (`docs/terms-review-2026-10-28.md`, with what it could not retrieve), whose pages should be read again.

```
ahp doctor
ahp eval pilot/suite-a.mjs --seed <n>
ahp eval pilot/suite-b.mjs --seed <n>
```

Each is one evaluation in its own directory; the two are compared by reading both reports, since `ahp eval` has no command for combining them. With 6 tasks, 4 conditions and 3 repeats, a suite schedules 72 trials, and then a matched-budget baseline trial for each attempt of each scored C3 trial (below).

## Estimated cost

**This is an estimate from the spike's numbers, not a measurement, and it is a floor.** The spike (`docs/spikes/2026-10-27-transport-spike-windows.md`, section 5) measured attempts at tasks that were trivial ("reply ok", a small shell task, two to five turns, a few hundred output tokens). An attempt that writes and tests a module of one of these tasks will use more, by an amount nobody has measured. Nothing below comes from the mock adapter.

**Attempts.** An attempt is one agent process.

| Per combination (6 tasks × 3 repeats = 18 trials per condition) | Agent attempts |
|---|---|
| C0: 1 attempt a trial | 18 |
| C1 and C2: plan, implement, review, no retry; 3 a trial | 54 + 54 |
| C3: the same 3 a trial at least; a retry or send-back adds one, up to 3 attempts for each of the 3 steps | 54 to 162 |
| Baseline: one C0 trial for each attempt of each scored C3 trial | 54 to 162 |
| **Total** | **234 to 450** |

For both combinations: **468 to 900 attempts.** The range is C3's: the low end is C3 never retrying or sending back, the high end is every step using its whole budget of 2 retries. Per tool across the two combinations: Claude Code plans in A and implements in B, 180 to 360 attempts; Codex implements in A and reviews in B, 180 to 360; OpenCode reviews in A and plans in B, 108 to 180.

**Per attempt, as the tools reported it in the spike**, with the labels they carry:

- **Claude Code** (`claude-sonnet-5-5`, effort low): `total_cost_usd` 0.027 to 0.069, a list-price figure from the tool (`costBasis: list`), not a charge on that login; with an API key set it would be charged at API rates. 180 to 360 attempts at those figures is about **$4.86 to $24.84**. If an attempt on these tasks cost 5 or 10 times the spike's figures, which is an assumption and nothing measured, the same arithmetic gives about $24 to $124 or $49 to $248.
- **Codex** (`gpt-5.6-luna`, ChatGPT login): input 57,384 to 96,278 tokens, of which 40,960 to 75,520 cached, and output 771 to 925 (reasoning 123 to 294) for the four small shell tasks; the larger inputs came with the agent reading user-level skill files. Codex reports **no cost**. 180 to 360 attempts at those figures is about **10.3 to 34.7 million input tokens (cached ones included) and 0.14 to 0.33 million output tokens**. No dollar figure is given: it depends on the price of the model chosen, which the spike does not hold and this document does not look up.
- **OpenCode** (free `deepseek-v4.1-flash-free`): 13,509 to 21,168 tokens per model call, cost 0, and one ACP prompt of input 13,187 and output 111. An attempt is several calls and the default paid model was not usable in the spike (HTTP 402), so there is **no estimate** for it.

**What this does not include:** the models' price for Codex and OpenCode; any attempt's growth with the size of the task; retries after a `transient` failure (a rate limit), which every condition makes and which add attempts; and the trial validators, which run no agent.

**What the spend cap would see:** only the cost a tool reports. Of the three tools that is Claude Code's, in USD; every Codex and OpenCode attempt counts as an attempt "without cost" in the report, not as zero. So a cap bounds a pilot by its Claude Code spend alone, and the provider-console limits are what bound the rest.

## What the tests cover

`test/evaluation-pilot.test.ts`, on the mock adapter only, in this order: the tasks are valid and there are five to eight; constraints and defects are not in the prompt or fixture; every constraint has a violation; per task, the fixture fails its hidden tests, the solution passes with no constraint broken, each violation passes but breaks exactly its constraint (scored by the independent validators); both suites are valid, have 3 repeats and cast the same three tools in different roles; both suites freeze all six tasks, validate against the registered adapters and schedule 72 trials with 3 repeats of every task and condition (cancelled before the first trial, so no tool starts); and each task runs end to end on scripted mock agents (every condition on `password-reset`, C0 and C3 on the rest). The full-size suite, with the mock in place of the tools, was also run once by hand with `ahp eval` to confirm the scheduling; its report was not kept.
