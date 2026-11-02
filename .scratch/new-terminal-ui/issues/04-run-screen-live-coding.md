# 04: Run screen with live coding

**Implement with:** Opus 5.5, effort high

**What to build:** Opening a run shows it as a live timeline (spec "Run: live coding"): each step with its tool, model,
effort and time; for the step at work, the code changing, the commands it runs and what it says; a sidebar of tokens
and limits; the receipt at the end. Read only (decisions are ticket 06).

**Blocked by:** 02, 03

**Status:** done (2026-11-02)

- [x] `src/tui/run-model.ts` (pure, the most-tested part): from `RunView`, the activity entries and the live diff, the
      timeline blocks: a step's mark (✓ ✗ ⠋ ↻ ! ○), tool · model (requested; the reported one beside it when it
      differs) · effort, time, tokens so far; activity lines; retry and send-back lines with their reason
- [x] Following files, never state held only in the UI: the ledger and the activity log re-read on change (`fs.watch`
      with a 250 ms poll as the fallback for Windows drives), read from the last offset, not from the start
- [x] Live diff: `git diff --no-color` of the running attempt's worktree against its base, at most once a second, only
      while the attempt runs and the screen is open, skipped when the previous one has not finished; files in the
      order they changed, the newest expanded (up to 30 lines), older ones one line (`✎ path +a −r`); binary and huge
      files named, not shown
- [x] `enter` expands or folds a block; `d` the whole diff, scrollable; `l` the raw transcript, tail first
- [x] Sidebar (≥ 110 columns, else `u` toggles it): per tool, usage as reported (in, out, cached, cost, with "not
      reported" where null), its limits as reported ("plan limit: allowed, 5-hour window"; "context 13.3k / 200k");
      AHP's limits: the attempt's total and idle time against `resolveTimeout`, retries used of the budget
- [x] The end: the receipt block from a pure `receiptOf(RunView)` (moved out of `src/cli/receipt.ts`, which renders it
      from that data until ticket 09): checks verified or not, "reported done" counts with the first failing line,
      send-backs, refusals, usage per tool with source, one "next" line; on the mock, a line saying so
- [x] Performance: a redraw at most every 100 ms; a run with 500 activity entries and a 2,000-line diff stays
      responsive (a test measures the model, not the terminal)
- [x] Tests (`test/run-model.test.ts`, `test/tui-run.test.ts`): mock runs (clean pass, a retry, a send-back, a failure,
      a gate waiting, an unknown attempt), a ledger and an activity log growing while the screen is open, the live diff
      over a worktree changed during the test, the sidebar's "not reported", the receipt's facts unchanged from today's
      `ahp inspect`

## Implementation notes (2026-11-02)

Implemented by Opus 5.5, as planned.

1. **`receiptOf` lives in `src/commands/receipt.ts`**, the first file of `src/commands/`. The plain commands (ticket 08)
   need it after ticket 09 deletes `src/cli/`, and `src/runtime/` may not import `TOOLS` (which `failureLineOf` uses for
   the log-in command). It returns `Receipt` (per agent step: the check, a verdict of `verified`, `not_verified` or
   `ended_before_check`, the times the agent reported done with why each failed, send-backs with what became of them,
   handoff refusals; usage per adapter; the next command; whether it is mock). `formatReceipt`, `formatBriefReceipt`
   and `nextStepOf` in `src/cli/receipt.ts` render from it. `test/receipt.test.ts` passes unchanged.
2. **The ledger is followed with `readLedgerFrom(path, cursor)`** (`src/ledger/chain.ts`): the same check as
   `readLedger` (one `parseLedger` now serves both), from a byte offset, continuing the chain from the last event read.
   A torn tail is left out and read again once its newline is there. A file shorter than the cursor is read again
   from the start. The replay of the events read so far is recomputed on each change (a few hundred events take well
   under a millisecond), because `applyEvent` mutates in place and React needs a new object.
3. **The follower (`src/tui/follow.ts`)** holds the bytes it has read and nothing else: events, activity entries (whole
   lines only, so a line being written is never parsed half), the lock, and the mtime of each running attempt's output
   transcript (the same file `watchAttempt` measures idleness by, so "idle" is the runtime's own measure). It falls back
   to `tool-calls/<attempt>.jsonl` for runs recorded before ticket 03. `fs.watch(runDir, { recursive: true })` wakes it,
   the 250 ms poll runs regardless, and one read runs at a time (a wake during a read reads once more after it).
4. **Redraws** are throttled in the screen's hook to one per 100 ms (`REDRAW_MS`). The elapsed and idle times tick once
   a second while the run is live. The spinner keeps its own 80 ms frames from ticket 02; Ink throttles output anyway.
5. **The base of the live diff** is the attempt's handoff revision's `base.commit` (`attemptBase`), the commit the
   runtime made the worktree from. The diff runs `git --no-optional-locks -c core.quotepath=off diff --no-color
   --no-ext-diff --no-textconv --no-renames <base>` in the worktree through the existing `git()` helper. Untracked
   files (`ls-files --others --exclude-standard`) are read from disk and shown as all added, because `git add -N` would
   write the agent's index. "Huge" is a file whose diff has more than 5,000 lines, or an untracked file over 1 MiB (named,
   not read). After 200 untracked files the rest are only named. A line longer than 400 characters is cut.
6. **"The order they changed"** is each file's mtime in the worktree. A deleted file has none, so it is placed when the
   screen first saw it gone. The live diff's lines are merged with the activity lines by time, so an edit appears between
   what the agent read and what it ran, as in the spec's mockup. Tool calls use `●` (or `$` for a command), so `✎` is
   kept for the files the diff shows.
7. **What a block shows.** Expanded by default: the block at work while the run goes on, and any that failed, waits or
   was cancelled. The others are folded to their retry and send-back lines. Activity is shown for a step's last attempt
   only (earlier ones are their retry lines), the newest 60 lines, with "… N earlier lines: l shows the raw log". One
   line per tool call, in the state its tool last reported. Retry lines say why and count each budget: `retry k of
   budget`, `transient retry k of transientBudget, after Ns`, or the reroute. Their failing output (the last 12 lines of
   the check) and a send-back's findings open with `enter`. An attempt's outcome says "reported done" and, separately,
   "verified" or "not verified", and a review adds its verdict.
8. **Who and how long.** The tool is `TOOLS`' name (`mock` for the mock). The model is the attempt's requested one, or
   "default model". The effort is the agent's `options.effort`, from the run's own `run_created` workflow, the reroute's
   when the attempt ran on it. The reported model is shown beside it only when it differs. A step's time runs from its
   first attempt's creation to its last `step_terminal`, or to now while it is at work. A gate's runs from its first
   request.
9. **Tokens.** A block's tokens are its attempts on its last attempt's tool, summed as `summarizeUsage` does within one
   adapter. A running attempt contributes its latest `attempt`-scope usage entry. `message`-scope entries (Claude
   Code's per-message counts, ticket 03 note 2) are never added up: the sidebar shows the last one as "last message: …"
   until the attempt ends. A tool that reported nothing while its attempt runs reads "reported at the end of its turn"
   (Codex does this, D4), and "not reported" once the attempt has ended.
10. **The sidebar** (36 columns, from 110 columns of terminal) has one section per tool in the order each first played.
    Under `mock (scripted, not evidence)`: in and out on one line, then cached, then cost, each "not reported" in
    `muted` where null; how many attempts reported when not all did; the source; then the latest limit of each kind.
    Claude Code's `rateLimitType` reads `five_hour` as "5-hour window" and `seven_day` as "7-day window"; any other
    value is shown as it came, its underscores as spaces. Then "Limits (AHP) · <step>" for the step at work: attempt
    time against `timeout.totalMs`, idle against `timeout.idleMs` ("no limit" for 0), retries of the budget, and
    transient retries and the reroute when they happened.
11. **External actions** have no block of their own. The gate's block names where the approved work goes (`→ branch
    ahp/x`) and says how each action after it ended. A waiting gate lists up to 10 changed paths from its
    `approval_requested` event and quotes the plain commands that decide it today (`ahp approve <run> <gate>`, `ahp
    reject … --reason <text>`); ticket 06 puts `a` and `r` there.
12. **Who writes the run**, from the lock: this process (no notice), another live process ("run … is running in another
    terminal (PID n); this screen only watches it"), another host, or none while the run is unfinished and not waiting
    for a person ("! its process stopped partway: ahp recover <run> resumes it"). With no live writer, an in-progress
    mark becomes `!` instead of the spinner, and no live diff is read.
13. **Keys.** Timeline: `↑↓ step` (more than one block), `enter expand|fold`, `d full diff`, `l raw log`, `u usage|timeline`
    (below 110 columns), `esc back`, `ctrl+c`, and `?` help (works, kept out of the footer for room). `d` shows the
    live diff while the selected step's last attempt runs; otherwise that attempt's snapshot against its base, from the
    repository (`git diff base snapshot`). `l` tails the last 64 KiB of the attempt's output transcript, with escape and
    control characters removed, and opens at its bottom. Both views scroll with `↑↓` and `pgup pgdn`, and `esc` goes back.
    `ctrl+c` cancels only when the screen is given a `cancel` (the run's own `AbortController`, ticket 05) and the run is
    live; otherwise it quits, as on other screens.
14. **Opening a run.** `Nav` gains `openRun(runId)`, and the app keeps the run's ID beside the router. Until ticket 05
    (a task started from the prompt) and ticket 07 (`/runs`) call it, `node src/tui/dev.ts <run-id>` opens a run's
    screen. Without a run the screen says so (`NO_RUN_OPEN`). Home is unchanged.
15. **The receipt** comes once the run has ended, under the timeline, and is in view until a block is selected. Its lines
    wrap at spaces (`wrapLine`) rather than lose a fact to "…". The usage line names the tool (`Claude Code`) where the
    old text named the adapter.
16. **Performance test**: ten passes of parsing a 2,000-line diff and building the model with 500 activity entries
    average under 50 ms each, measured in `test/run-model.test.ts`.
17. **Tests.** `test/tui-follow.test.ts` covers the follower directly: reading from the offset, a torn ledger tail and a
    torn activity line left out until whole, a broken chain reported with the events read before kept. The live test
    in `test/tui-run.test.ts` runs a hanging mock attempt, appends activity entries to its log, edits its worktree, and
    cancels with `ctrl+c` through the run's signal (`run_cancel_requested` recorded, the run ends `cancelled`). It always
    aborts in a `finally`, so a failure never leaves the agent holding `AHP_HOME`.
