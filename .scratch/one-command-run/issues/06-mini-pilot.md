# 06: A mini pilot

**What to build:** Nothing new in code: a run of the existing pilot at the smallest size that says anything, so "why use
AHP" has evidence for or against it instead of an opinion.

**Blocked by:** the maintainer's budget decision (design doc §9.9)

**Status:** waiting on the maintainer

- [ ] Choose: 2 or 3 of the six pilot tasks, conditions C0, C0V and C3min (single agent, single agent with the check and
      retry, implement → review), 1 repeat; that is 6 to 9 trials, one agent combination
- [ ] Set `spendCap`, `maxIncidentRate` and `toolVersions` in the suite, and the provider-console limits, before it runs
- [ ] Read OpenAI's and OpenCode's own terms first (ticket 23 of release 1 could not fetch them)
- [ ] Record the report in `docs/` with its date, tool versions and the statement that a sample this size is a pilot:
      it shows cost per trial and harness problems, and cannot show a difference between conditions
- [ ] Whatever it shows goes in the README as it is, including "no detectable difference"

## Notes

- The full pilot (`docs/pilot.md`: 468 to 1,044 attempts) stays the real test; this is its first, cheapest slice.
- C3min vs C0V is also what spec D4 (the default steps) waits on.

## Prepared (2026-10-31), not run

What needs no budget is done: `pilot/suite-mini.mjs` (password-reset, csv-export, retry-backoff; C0, C0V, C3min; 1
repeat; implement claude-code, review codex: 9 trials, 12 to 36 attempts), a mock-only test that it validates and
schedules those 9 trials (`test/evaluation-pilot.test.ts`), and "The mini pilot" in `docs/pilot.md`. Nothing was run
against a real tool. Choices made, for the maintainer to confirm:

1. **Tasks:** password-reset (the reference scenario), csv-export and retry-backoff: three different kinds of work
   (an endpoint's logic, a format with edge cases, timing and abort), all plain Node.
2. **Combination:** implement Claude Code, review Codex. C0 and C0V are the implement agent alone and Claude Code
   reports a cost, so a spend cap sees most of the spend; OpenCode is left out, which also leaves its unread terms out.
3. **Left unset, as the full pilot leaves them:** `spendCap`, `maxIncidentRate`, `toolVersions` and models. The test
   checks they stay unset, so the budget decision is made where it belongs.

Still waiting on the maintainer: the budget (design doc 9.9), the spend cap and console limits, and OpenAI's terms.
