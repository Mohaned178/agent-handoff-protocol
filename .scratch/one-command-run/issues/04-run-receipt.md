# 04: The run receipt

**What to build:** A short account at the end of every run of what AHP's checks caught that an agent alone would not
have said, because that is the reason to use AHP and today it is only in `ahp inspect`.

**Blocked by:** none

**Status:** done (2026-10-31)

- [x] At a run's end (where the usage summary is printed now), a receipt read from the run's state only:
  - the check: "verified: `npm test` passed in a clean copy", or "not verified: no check command"
  - how often an agent reported done before the check passed: "the agent reported done 2 times before its check passed"
    (attempts whose verification failed), with the first failing line of each
  - what review sent back: its findings, one line each, and whether the revision fixed them (the next review approved)
  - anything refused: a protected path changed, a ref an agent moved, a capability refused
  - usage per tool, as today
- [x] Only what the ledger records; no "would have" claims and no estimate of time or money saved
- [x] `ahp inspect` shows the same receipt at its top
- [x] Tests: a run with a failed attempt then a pass, a send-back, a clean first pass (the receipt then says only
      "verified" and the usage), and a run with no check

## Notes

- Wording rule from the design: an agent's report is a claim; the receipt says "reported done", never "was done".

## Implementation notes (2026-10-31)

`formatReceipt` in `src/cli/receipt.ts` (pure, from `RunView` only; `formatRunUsage` moved there too and `format.ts`
re-exports both). Printed by `followRun` where the usage summary was (and by "Decide later"), and at the top of
`ahp inspect`. Tests: `test/receipt.test.ts` (runs on the mock, then the receipt of the replayed state; one CLI test).
Choices made:

1. **Every run segment's end prints the receipt**, including a run that stops at a gate with no one to decide it (as
   the usage did): what has been checked so far.
2. **"Not verified: no check command" is said once for the run**, when no agent step ran a check command; a plan or
   review step without one is not called unverified when another step was verified.
3. **"Reported done" counts the attempts whose verification failed** (an agent error is not a report of done). An
   attempt refused for a protected path or a moved ref is in that list, its line saying "refused: ...", so it is not
   listed twice; a handoff an adapter could not take is its own "refused" line.
4. **The first failing line** of a check's output is the first line that looks like a failure (fail, error, assert,
   wrong, missing, expected, not ok, ✗, ×), else its last line. Hidden tests' output is shown, as `describeLastFailure`
   does: it is withheld from agents, not from the person.
5. **Whether a revision fixed the findings** is the review's next attempt: approved, asked for changes again, did not
   reach a verdict, or not reviewed again. A rejection at a gate reads the gate's next decision the same way.
- 2026-10-31: first green CI run with this ticket: 41146259771 (Linux 899 passed, 1 skipped; macOS 899 passed, 1
  skipped; Windows 896 passed, 4 skipped).
