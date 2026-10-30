# 04: The run receipt

**What to build:** A short account at the end of every run of what AHP's checks caught that an agent alone would not
have said, because that is the reason to use AHP and today it is only in `ahp inspect`.

**Blocked by:** none

**Status:** planned

- [ ] At a run's end (where the usage summary is printed now), a receipt read from the run's state only:
  - the check: "verified: `npm test` passed in a clean copy", or "not verified: no check command"
  - how often an agent reported done before the check passed: "the agent reported done 2 times before its check passed"
    (attempts whose verification failed), with the first failing line of each
  - what review sent back: its findings, one line each, and whether the revision fixed them (the next review approved)
  - anything refused: a protected path changed, a ref an agent moved, a capability refused
  - usage per tool, as today
- [ ] Only what the ledger records; no "would have" claims and no estimate of time or money saved
- [ ] `ahp inspect` shows the same receipt at its top
- [ ] Tests: a run with a failed attempt then a pass, a send-back, a clean first pass (the receipt then says only
      "verified" and the usage), and a run with no check

## Notes

- Wording rule from the design: an agent's report is a claim; the receipt says "reported done", never "was done".
