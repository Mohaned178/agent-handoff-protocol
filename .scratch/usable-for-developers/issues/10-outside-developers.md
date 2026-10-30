# 10: Outside developers use it

**What to build:** Nothing in code at first: five developers who are not the maintainer install 0.1.0 and use it on
their own work, so "developers will use it" is measured rather than hoped, and what they hit decides what 1.0 needs.

**Blocked by:** 07 (a published version), 06 (docs they can follow alone); needs the maintainer to find the people

**Status:** planned

- [ ] Five developers, at least two on Linux or WSL2 and at least one using each tool, each asked to run at least
      three of their own tasks with no help beyond the README
- [ ] What they report, in a GitHub issue each (ticket 09's template): where they got stuck, what they did not
      understand, whether they would use it again and for which tasks; no telemetry (spec D6)
- [ ] Every blocker fixed and released (0.1.x); every "would not use it again" read for its reason
- [ ] 1.0 when: the five used it without an open blocker, two releases went by with no breaking change to the
      workflow file or the ledger, and the README says, with the pilot's result as it is, which tasks AHP is for
- [ ] *Decision for this ticket:* where to find the five. Recommendation: developers the maintainer knows first, then
      one post (a GitHub discussion or a forum the maintainer uses) once the first two have run it without help

## Notes

- Usage that cannot be counted without telemetry is not counted: no download numbers are quoted as users.
