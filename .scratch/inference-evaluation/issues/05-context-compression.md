# 05: Context compression

**Implement with:** Opus 5.5, effort high

**What to build:** Measure the size of every handoff in every trial, and add a condition whose handed-on context has a
byte budget that verification checks.

**Blocked by:** none

**Status:** done (2026-11-01)

- [x] `trial_ended.handoffs`: per issued handoff, the step and the UTF-8 bytes of its `context.fields`, from the
      run ledger's `handoff_issued` events
- [x] Report: the median and total context bytes per condition
- [x] Step field `contextBudget: { maxBytes }`. Reported fields over the budget fail verification with evidence
      `context_over_budget` (the bytes and the budget), retried as `verification_failed`. This is a protocol change:
      version bump and `npm run schemas`
- [x] Condition `C3c`: C3, with every step told the budget and held to it. Added to `COMPARISONS`: `C3c vs C3`
- [x] Tests: over and under the budget, a retry, older ledgers replay

## Implementation notes (2026-11-01)

1. The budget is also in the handoff's contract (`contract.acceptance.contextBudget: { maxBytes } | null`), and the shared
   prompt (`promptFor`) states it to every adapter, so any workflow with a budget tells its agent before the first attempt,
   not only C3c through its words. Maintainer's choice, 2026-11-01.
2. What is measured is what the step hands on: its required output fields as reported and present, in the step's order
   (`handedOnFieldsOf`, shared with `buildHandoff`), as UTF-8 JSON with no spacing (`contextBytesOf`, `src/protocol/handoff.ts`).
   The same function measures `trial_ended.handoffs`, so a budget and a recorded size are the same number. Extra fields an
   agent reports (`reportFields`) are never handed on and never counted. Maintainer's choice, 2026-11-01.
3. Protocol 0.1.0 → 0.2.0, a minor bump: a 0.1 reader cannot read the new evidence kind, and under 0.x `isNewerProtocol`
   refuses only a higher minor. Replay of 0.1.0 ledgers is unchanged (`test/ledger-releases.test.ts`). `reviseHandoff`
   brings a revision of a handoff issued under 0.1.0 up to the current version (`schemaVersion`, `contextBudget: null`),
   so a 0.1.0 run picked up by this AHP is not rejected as `schema_invalid` on its next retry. The A2A extension URI
   moves to `…/ahp/0.2`, as `docs/a2a-mapping.md` said a breaking change would.
4. `context_over_budget` is recorded only when over (the kind names the failure, as `forbidden_external_action_detected`
   does), after the command, which still runs: the budget says nothing about the work, and the check's output helps the
   retry. Its verdict is `fail` whenever `bytes > maxBytes`.
5. A budget needs required output fields to hold to (a review's `verdict`/`findings` count); one on a step that hands on
   nothing is a validation problem. `maxBytes` is a whole number above 0.
6. `C3C_CONTEXT_BUDGET` is 2048 bytes (the ticket's recommendation), a constant, not a suite option: a second budget
   would be a second condition. Every C3c step, review included, carries it and is told it in its words.
7. `trial_ended.handoffs` lists every revision issued (`stepId`, `fromStepId`, `handoffId`, `revision`, `bytes`), read
   from the run ledger's `handoff_issued` events; null when there was no run or the ledger could not be read, never a
   reclassification. The report's median and total count each context once: handoffs with a sender at revision 1 (a
   retry's revision repeats the same context, and the first step's handoff carries none), over scored trials, like the
   other measures. A condition whose trials recorded handoffs but handed nothing on (C0, C0V) says so.
8. `C3c vs C3` sits after `C3 vs C3min` in `COMPARISONS`. The pilot suites (`pilot/common.mjs`) are left without C3c:
   adding it changes their 90-trial schedule and the cost estimate, which is the maintainer's to decide.
