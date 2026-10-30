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
