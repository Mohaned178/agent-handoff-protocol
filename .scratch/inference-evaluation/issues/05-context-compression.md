# 05: Context compression

**What to build:** Measure the size of every handoff in every trial, and add a condition whose handed-on context has a
byte budget that verification checks.

**Blocked by:** none

**Status:** open

- [ ] `trial_ended.handoffs`: per issued handoff, the step and the UTF-8 bytes of its `context.fields`, from the
      run ledger's `handoff_issued` events
- [ ] Report: the median and total context bytes per condition
- [ ] Step field `contextBudget: { maxBytes }`. Reported fields over the budget fail verification with evidence
      `context_over_budget` (the bytes and the budget), retried as `verification_failed`. This is a protocol change:
      version bump and `npm run schemas`
- [ ] Condition `C3c`: C3, with every step told the budget and held to it. Added to `COMPARISONS`: `C3c vs C3`
- [ ] Tests: over and under the budget, a retry, older ledgers replay
