# 22: Evaluation safeguards

**What to build:** Evaluation cannot silently overspend, produce numbers from flaky cells, or compare conditions that differ in hidden ways.

**Blocked by:** 11, 20

**Status:** implemented, awaiting review of the decisions below

**Model:** Sonnet 5.5 · medium

- [x] `ahp eval` stops starting new trials when reported spend reaches a configured cap; docs tell the evaluator to set provider-console spend limits
- [x] A cell whose harness incident rate exceeds a configured threshold is marked invalid
- [x] A suite is rejected if a task's network stance differs across conditions
- [x] Tool versions are pinned per suite and recorded per trial; a version mismatch is reported
- [x] Evaluation expects API-key logins configured in each tool, and says so in `ahp eval` output

## Decisions to confirm

1. **Spend cap is checked between trials**, so a trial that reaches the cap, and one under way, run to the end and the total can overshoot by up to a trial's cost. It sums only reported cost in the cap's one currency; attempts without a cost in it are counted and shown as unknown, never as 0. Recommendation: keep (cutting a trial short would make it unscorable).
2. **Invalid cell = task × condition**, incidents over ended non-cancelled trials, strictly above `maxIncidentRate`. Its trials leave that condition's rates and every comparison; for the baseline its cells become incomplete. No default threshold (design §9 item 3 leaves it to the pilot).
3. **Network stance check is a guard**: conditions build every step's network from the task, so no suite can make it differ today, and no test can provoke the rejection. Recommendation: keep as a guard against a future condition change.
4. **Version pins are by `ahp doctor` tool id**, read with the tool's own `--version` at every trial; a mismatch (or an unreadable version) is reported and flagged but does not stop the evaluation or exclude the trial. Recommendation: keep; whether a mismatched trial counts is the evaluator's call.
5. **The API-key expectation is a notice** printed by `ahp eval` before it starts (stderr with `--json`); AHP reads no credential and cannot check it.

## Comments

Review notes (not changed, for the maintainer): the baseline cells of a task whose C3 cell is invalid are still counted, so C3-vs-baseline can pair differently from the other comparisons; a spend cap against tools that report no cost never trips (the report says how many attempts were uncounted); the API-key notice also prints for mock-only suites; `spend_observed` is not checked to be non-decreasing on replay.
