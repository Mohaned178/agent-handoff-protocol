# 04: Run screen with live coding

**Implement with:** Opus 5.5, effort high

**What to build:** Opening a run shows it as a live timeline (spec "Run: live coding"): each step with its tool, model,
effort and time; for the step at work, the code changing, the commands it runs and what it says; a sidebar of tokens
and limits; the receipt at the end. Read only (decisions are ticket 06).

**Blocked by:** 02, 03

**Status:** todo

- [ ] `src/tui/run-model.ts` (pure, the most-tested part): from `RunView`, the activity entries and the live diff, the
      timeline blocks: a step's mark (✓ ✗ ⠋ ↻ ! ○), tool · model (requested; the reported one beside it when it
      differs) · effort, time, tokens so far; activity lines; retry and send-back lines with their reason
- [ ] Following files, never state held only in the UI: the ledger and the activity log re-read on change (`fs.watch`
      with a 250 ms poll as the fallback for Windows drives), read from the last offset, not from the start
- [ ] Live diff: `git diff --no-color` of the running attempt's worktree against its base, at most once a second, only
      while the attempt runs and the screen is open, skipped when the previous one has not finished; files in the
      order they changed, the newest expanded (up to 30 lines), older ones one line (`✎ path +a −r`); binary and huge
      files named, not shown
- [ ] `enter` expands or folds a block; `d` the whole diff, scrollable; `l` the raw transcript, tail first
- [ ] Sidebar (≥ 110 columns, else `u` toggles it): per tool, usage as reported (in, out, cached, cost, with "not
      reported" where null), its limits as reported ("plan limit: allowed, 5-hour window"; "context 13.3k / 200k");
      AHP's limits: the attempt's total and idle time against `resolveTimeout`, retries used of the budget
- [ ] The end: the receipt block from a pure `receiptOf(RunView)` (moved out of `src/cli/receipt.ts`, which renders it
      from that data until ticket 09): checks verified or not, "reported done" counts with the first failing line,
      send-backs, refusals, usage per tool with source, one "next" line; on the mock, a line saying so
- [ ] Performance: a redraw at most every 100 ms; a run with 500 activity entries and a 2,000-line diff stays
      responsive (a test measures the model, not the terminal)
- [ ] Tests (`test/run-model.test.ts`, `test/tui-run.test.ts`): mock runs (clean pass, a retry, a send-back, a failure,
      a gate waiting, an unknown attempt), a ledger and an activity log growing while the screen is open, the live diff
      over a worktree changed during the test, the sidebar's "not reported", the receipt's facts unchanged from today's
      `ahp inspect`
