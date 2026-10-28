# 21: Evaluation: C1, C2, matched baseline, statistics

**What to build:** The evaluator can run all conditions (C0–C3) plus the matched-budget baseline, with repeats and randomized order, and gets paired per-task comparisons with confidence intervals.

**Blocked by:** 20

**Status:** implemented, awaiting review of the decisions below

**Model:** Opus 5.5 · high

- [x] C1: same agents passing plain text; no envelope, no runtime acceptance checks, no retry
- [x] C2: AHP handoffs validated between steps; no runtime acceptance checks between steps, no retry
- [x] Matched-budget baseline: C0 repeated as many times as C3 used attempts for that task; success if any passes
- [x] Repeats per cell and randomized run order
- [x] Metrics: verified success, constraint violations, duplicated/reverted work, retries per success, wall time, usage only where reported (labelled, not compared across mismatched units)
- [x] Paired per-task comparisons with confidence intervals; negative and inconclusive results reported plainly

## Implementer notes

- Statistics method, exactly: for each task, success rate per condition = passes / valid trials (harness incidents excluded). Paired difference per task = rate(A) − rate(B). The headline is the mean paired difference across tasks, with a 95% confidence interval from a paired bootstrap over tasks: 10,000 resamples, a seeded pseudo-random generator, percentile interval.
- Always report raw counts (passes, valid trials, incidents) next to every rate.
- If the interval includes 0, the report says "no detectable difference", not "AHP is better" or "worse".
- Test the statistics with known-answer fixtures: fixed inputs and seed must produce a fixed interval; identical conditions must give a difference of 0.
- Randomized order = a seeded shuffle of all trials; the seed and the resulting order are recorded in the ledger.
- Matched-budget baseline for a task = as many independent C0 trials as attempts C3 used on that task in the same repeat.

## Comments

2026-10-28, implementation notes. Code in `src/evaluation/` (new: `statistics.ts`, `work.ts`; changed: `conditions.ts`, `suite.ts`, `events.ts`, `replay.ts`, `run.ts`, `trial.ts`, `report.ts`), `src/cli/` (`--seed`, progress lines), `src/index.ts`; user doc `docs/evaluation.md`; glossary (Condition, Matched-budget baseline, Repeat, Paired comparison, Duplicated work and reverted work); tests `test/evaluation-statistics.test.ts`, `test/evaluation-conditions.test.ts`, `test/evaluation-schedule.test.ts`, `test/evaluation-metrics.test.ts`, with ticket 20's evaluation tests made independent of trial order.

**What was added.**
- C1, C2 and `baseline` beside C0 and C3 (`CONDITIONS`, default all five), `repeats` in the suite, `--seed` / `seed`.
- The order: `trials_scheduled` (seed, Fisher-Yates order from mulberry32) after the freeze and before any trial; `baseline_scheduled` (a scored C3 trial's baseline, drawn into the trials still to start at recorded positions). Replay keeps the queue and refuses a trial that starts out of order or before the one in hand has ended; the loop always runs the head of the replayed queue.
- Per trial: `retries`, `wallTimeMs`, `usage` (as reported, per attempt), `work` (duplicated and reverted lines).
- The report: retries per success, work, wall time and usage per condition; the baseline by cell; six paired comparisons with bootstrap intervals and the raw counts per task.

**Verified.** The statistics against a reference written in the test from this ticket's notes, with literal known answers pinned (mulberry32's first number for seed 42, a shuffle for seed 7, the interval `[−0.0714…, 0.6428…]` for seed 2026), one-point intervals for equal differences, and a difference of exactly 0 with interval `[0, 0]` for identical conditions. The rest at seam 1 with scripted mock agents in real repositories. Two code reviewers (standards, spec); their fixes are in (below). Nothing here ran a real tool: every number is `[mock]`.

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **C1 is plan → implement → review, each step reporting one free-text field, `output`, which is all the next is handed.** It runs through the runtime like everything else, so there is still a handoff document underneath and the step's "required output field" is checked: a step that reports no text ends the run (no retry). *Recommended: adopt.* What the agent sees is plain text in and out; the alternative (handing on a field only if reported, never requiring it) needs a new workflow feature, for a case the real adapters' structured output makes rare. Evaluation adds no execution path (ticket 20), so "no envelope" means no structured fields, no artifacts, no evidence, not "no runtime".
2. **C2 is C3's pipeline (same fields, same words, same capability requests) with `requiredOutputFields` only: no command, hidden tests, install or protected paths, no retry, and its review an ordinary step whose verdict sends nothing back.** "Handoffs validated" is the envelope's own check: a step that does not report a field its handoff carries ends the run there, scored on what it left (the runtime checks it at the sender's verification, before the recipient's handoff could be rejected; with no retry the effect is the same, but the trial is scored rather than `setup_failed`). *Recommended: adopt.*
3. **C1, C2 and C3 tell each step the same words (apart from how C1 reports) and make the same capability requests** (plan and review `read_only`, at the adapter's declared level). *Recommended: adopt*: then C2 − C1 is the envelope and C3 − C2 the acceptance checks and retry, with nothing else varying.
4. **"No retry" keeps `transient` retries**, as C0 does (ticket 20 decision 5): a rate limit is not something a condition does. *Recommended: adopt.*
5. **The baseline is listed among the conditions as `baseline`, on by default, and needs C3.** Its trials run C0's workflow (named `<task>-baseline`) and are reported apart from C0's, which stay one per task per repeat. *Recommended: adopt. Cost: this is the expensive condition.* With 3 attempts per C3 trial at the least, it runs at least 3 C0 trials per C3 trial, so for the pilot it costs roughly as much as C0, C1 and C2 together. Leave `baseline` out of a suite's `conditions` to skip it.
6. **"Attempts C3 used" is every attempt of the C3 trial**: plan, implement and review, retries, send-backs and `transient` ones. So a C3 trial that never retried still gets 3 baseline trials. *Recommended: adopt*: it is the ticket's words, and C3 spent three agent runs. The alternative (implement's attempts only) would compare C3's three agents against fewer C0 runs.
7. **A baseline cell is scored only when every one of its trials was scored**; a cell with a trial that was a harness incident, unscored or never run is incomplete and left out, **even if another of its trials passed**, and named with why. *Recommended: adopt, but this departs from the literal "success if any passes", as the spec review flagged.* Counting a passing incomplete cell while leaving out a failing one would favour the baseline: a cell can only be shown to fail when it is whole. The alternative, "any pass makes it pass", is the literal reading.
8. **A baseline is made only for a scored C3 trial.** A C3 trial that was an incident or unscored has no known budget to match. *Recommended: adopt.*
9. **Baseline trials are drawn into the trials still to start, at positions from the same generator** (recorded in `baseline_scheduled`), not run in a block at the end, where time of day and provider load would differ. The whole order is rebuilt from `trials_scheduled` plus every `baseline_scheduled`, never written as one list. *Recommended: adopt.*
10. **The seed comes from `--seed` / `seed`, or is drawn at random and recorded; each comparison resamples from a generator freshly seeded with it**, so a comparison's interval does not depend on which other comparisons the report made, and a report can be recomputed from the ledger. *Recommended: adopt.*
11. **Six comparisons, each made when both sides ran: C3 against C0, the baseline, C1 and C2; C2 against C1; C1 against C0. Only verified success is compared**, as the implementer notes define it; constraint violations, work, wall time and usage are reported per condition and not compared. No correction for multiple comparisons, and the report says each interval stands alone. *Recommended: adopt.*
12. **"Valid trials" are scored trials:** harness incidents are excluded, as the notes say, and unscored trials too (ticket 20 decision 8). For the baseline, its complete cells. *Recommended: adopt.*
13. **Fewer than 2 tasks with valid trials on both sides gives no interval: "inconclusive".** With one task every resample is that task, and the interval would be a point that looks certain. *Recommended: adopt.* The interval's ends are the sorted resampled means at indices 250 and 9,749 (250 outside on each side); an end exactly at 0 counts as including 0.
14. **Duplicated and reverted work are counted in lines with `git diff --numstat`** (binary files 0): duplicated is the work of attempts whose snapshot is not in the scored result's history, reverted is the work in it beyond the result's own diff. A count that cannot be taken is left out (`work: null`) and never changes how a trial ended. *Recommended: adopt.* Deterministic and blind to meaning; no other definition was given.
15. **Wall time is the run's** (its creation to its end), not the trial's (which adds making the repository and running the validators, the same in every condition). Reported as median and mean over scored trials; the baseline's per complete cell, as the sum of its trials'. *Recommended: adopt.*
16. **Usage is summarised per adapter over every trial that ended**, scored or not (spend is spend): how many attempts reported anything, each number summed over the attempts that reported it with that count, cost per currency, and the source labels; never across adapters, never compared. *Recommended: adopt.*
17. **An agent in a suite may be a function of the task and the trial** (`(task, { condition, repeat, baselineIndex })`), which is how a test steers scripted mock agents per trial; it is also called while the suite is validated. *Recommended: adopt.* A real suite names the same agent everywhere.
18. **Evaluation ledgers written before this ticket do not replay** (no `trials_scheduled`), unlike run ledgers, which read new fields with `?? null`. *Recommended: adopt*: there are only mock evaluations from today, and reading them would weaken the order check for every ledger.
19. **Only C3's workflow holds the hidden tests, so only C3's agents could find them** in the trial repository's run ledger (ticket 20 decision 13, accepted for the pilot). That was a caveat; with comparisons it is now a bias toward C3 in every comparison C3 is in. *Recommended: keep it accepted for the pilot, read the transcripts of C3 trials that pass where the others fail, and move ledgers out of the trial repository before the full suite.* Say if it should block the pilot instead.

**Code review (two reviewers).** Fixed: `merge-base --is-ancestor` failures other than exit 1 counted an attempt's lines as duplicated (now they make the count unavailable); replay compared the scheduled trial by JSON text, so by key order (now field by field); `work.ts` re-implemented `findHandoff`; a comparator copied where `byPath` exists; the comparison's exclusion reason was free text that the report rewrote by string replacement (now the closed list `PAIRING_GAPS`); C3's retry budget derived in two places (now `retryBudgetOf`); C1's steps written as one-line literals beside multi-line ones. Not done, as judgement calls: `TrialSlot` and `ScheduledTrial` overlap (the slot is what an agent source needs, without a trial id it cannot have during validation); `baseline_scheduled` repeats the task and repeat that follow from its C3 trial (kept so the ledger reads on its own, and replay checks they agree); `evalCommand` takes five arguments. The spec review's points are decisions 1, 4, 6, 7 and 9 above.

**Not done, on purpose.** The spend cap, invalid cells, version pinning and the API-key expectation (ticket 22); comparing anything but verified success; any real-tool trial.
