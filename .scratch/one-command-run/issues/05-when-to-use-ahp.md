# 05: The README around `ahp "<task>"`, and when not to use AHP

**What to build:** The README's first screen shows the one-command run, and a short section says plainly when AHP is
worth it and when an agent on its own is the better tool.

**Blocked by:** 02, 04

**Status:** done (2026-10-31)

- [x] Getting started: install, `ahp demo`, then `ahp "<task>"` in a project; `ahp setup` and workflow files move below,
      as the way to keep a workflow that is run again
- [x] "When to use AHP": a test defines done; the task is long or runs while nobody watches; more than one tool; a record
      of what was asked, done, checked and approved is needed
- [x] "When not to": quick edits, docs, anything with nothing to test and little to lose ("use your agent directly")
- [x] The opening example is a receipt (ticket 04) from a real run, not a mock one; if no real run is recorded yet, the
      example says it is illustrative
- [x] No claim that handoffs beat a single agent until ticket 06 has a result; until then "every step is checked", not
      "better results"

## Notes

- `docs/how-it-works.md` keeps the details; the README stays short.

## Implementation notes (2026-10-31)

README only (docs/how-it-works.md keeps the details). Choices made:

1. **Both opening examples are real output shapes:** the summary was rendered by `formatTaskSummary` itself; the
   receipt follows `formatReceipt`'s wording but its content is made up, so it is labelled illustrative and its usage
   line is "..." rather than invented numbers. Replace it with a real run's receipt once one exists (ticket 06).
2. **"When not to" says AHP does not claim better results** and points at the evaluation, "no result yet".
3. Workflow files moved under "Keeping a workflow", with `--save` as the way to keep a one-command run.
4. Fixed while there: the attempt timeout default (20 minutes, not an hour) and the evaluation's conditions (C0, C0V,
   C1, C2, C3min, C3 and the baseline, not "four conditions").
