# 06: Decisions in the app

**Implement with:** Sonnet 5.5, effort medium

**What to build:** Everything a run waits for a person to decide, decided on its run screen with one key, for a run
started in this app or anywhere else: an approval gate, an unknown attempt, a run whose process stopped.

**Blocked by:** 04 (05 for a run that goes on in place)

**Status:** done (2026-11-02)

- [x] Gate: the timeline's last block is "what you are approving" and the diff from the run's base to the gate's commit
      (`pendingApprovalOf`, never a worktree); footer `a approve   r reject   ↑↓ scroll`
- [x] `a` calls `approveStep`; `r` asks the reason in the prompt (required; "the agent is given this") and calls
      `rejectStep`; the run goes on on the same screen, gate after gate; a push, PR or merge after it shows as a step
      with its outcome
- [x] Unknown attempt: the recovery report (what it did, from its activity log; its workspace diff) and
      `a adopt   x abort` through `recoverAttempt`
- [x] Stopped run (stale lock, no unknown attempt): `enter resume` through `resumeRun`, taking the lock over as
      `ahp recover` does today
- [x] Home's "waiting for you" opens straight on the decision
- [x] A refusal from the SDK (decided elsewhere, lock held by a live process) is one `error` line on the screen, never a
      crash; the screen re-reads the ledger after
- [x] Tests (`test/tui-decisions.test.ts`): approve and reject on the mock with a bare remote (`addBareRemote`), two
      gates in a row, adopt and abort (the mock's `hang`, then a crash cut with `truncateLedgerAfter`), resume a stopped
      run, a decision refused because another process holds the lock

## Implementation notes (2026-11-02)

1. **What can be decided is data**: `decisionOf(state, lock)` (`src/commands/decision.ts`) gives a gate, an unknown attempt awaiting a
   person, or a stopped run, and nothing while a live process holds the lock (this window's own run included, which decides
   itself), the lock is unread or unreadable, or the run ended. A free or stale lock on a run that has not ended is "stopped".
2. **Decisions run through `TaskRunner.decide`**, not in the screen: the run goes on in this process under the same `signal`
   as a run started here, so ctrl+c, `esc` to home and "A run is going. Cancel it and quit?" all work for it, and a refusal
   (`LedgerLockedError`, `ApprovalRefusedError`, `RecoveryRefusedError`) ends it with one `error` line that the run screen shows
   in `error`. The ledger is followed as before, so the screen re-reads it after every decision; the next gate appears on
   the same screen.
3. **Gate and unknown attempt scroll as one view**: the decision is the timeline's last block (`What you are approving`, or
   `What happened to attempt N`), in view from its heading, ↑↓ scroll through the whole timeline. Block selection, `d` and `l` are
   off while it is shown (footer `a approve  r reject  ↑↓ scroll`, as the ticket says). The gate's diff is `pendingApprovalOf`
   (the pinned commit, cut at 64 KB as `ahp inspect`); the unknown attempt's workspace diff is read once, read only, with the
   live-diff reader.
4. **The `ahp ...` hint lines are left out of the model when the screen offers a key** (`runModel` option `decide`); without it
   the model says what it said, so the plain texts are unchanged.
5. **Reject reason**: a prompt under the timeline, `enter` rejects, `esc` leaves it; an empty reason is refused in place.
6. **Stopped run**: `enter` resumes (taking over the stale lock through `resumeRun`); a run cut while an attempt ran then shows
   that attempt as unknown, awaiting `a`/`x`. `resumeRun` answering "not resumed" is shown as one line.
7. **Home**: with an empty prompt and runs waiting, `enter` opens the picked one (`tab` picks the next, marked ›, not in the
   footer), which opens on its decision. Home's `tab` no longer does nothing, so the shell test that pressed it presses
   `ctrl+s`.
8. **The race test** (a decision refused because a live process holds the lock) calls `TaskRunner.decide` while a
   `LedgerWriter` holds the lock: the screen follows the lock within its poll, so no key could win that race reliably. A second
   test shows a run held by another PID as read only with no decision key.
