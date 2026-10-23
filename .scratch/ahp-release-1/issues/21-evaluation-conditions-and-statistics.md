# 21: Evaluation: C1, C2, matched baseline, statistics

**What to build:** The evaluator can run all conditions (C0–C3) plus the matched-budget baseline, with repeats and randomized order, and gets paired per-task comparisons with confidence intervals.

**Blocked by:** 20

**Status:** ready-for-agent

**Model:** Opus 5.5 · high

- [ ] C1: same agents passing plain text; no envelope, no runtime acceptance checks, no retry
- [ ] C2: AHP handoffs validated between steps; no runtime acceptance checks between steps, no retry
- [ ] Matched-budget baseline: C0 repeated as many times as C3 used attempts for that task; success if any passes
- [ ] Repeats per cell and randomized run order
- [ ] Metrics: verified success, constraint violations, duplicated/reverted work, retries per success, wall time, usage only where reported (labelled, not compared across mismatched units)
- [ ] Paired per-task comparisons with confidence intervals; negative and inconclusive results reported plainly

## Implementer notes

- Statistics method, exactly: for each task, success rate per condition = passes / valid trials (harness incidents excluded). Paired difference per task = rate(A) − rate(B). The headline is the mean paired difference across tasks, with a 95% confidence interval from a paired bootstrap over tasks: 10,000 resamples, a seeded pseudo-random generator, percentile interval.
- Always report raw counts (passes, valid trials, incidents) next to every rate.
- If the interval includes 0, the report says "no detectable difference", not "AHP is better" or "worse".
- Test the statistics with known-answer fixtures: fixed inputs and seed must produce a fixed interval; identical conditions must give a difference of 0.
- Randomized order = a seeded shuffle of all trials; the seed and the resulting order are recorded in the ledger.
- Matched-budget baseline for a task = as many independent C0 trials as attempts C3 used on that task in the same repeat.
