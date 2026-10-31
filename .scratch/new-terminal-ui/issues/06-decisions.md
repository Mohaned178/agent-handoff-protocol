# 06: Decisions in the app

**Implement with:** Sonnet 5.5, effort medium

**What to build:** Everything a run waits for a person to decide, decided on its run screen with one key, for a run
started in this app or anywhere else: an approval gate, an unknown attempt, a run whose process stopped.

**Blocked by:** 04 (05 for a run that goes on in place)

**Status:** todo

- [ ] Gate: the timeline's last block is "what you are approving" and the diff from the run's base to the gate's commit
      (`pendingApprovalOf`, never a worktree); footer `a approve   r reject   ↑↓ scroll`
- [ ] `a` calls `approveStep`; `r` asks the reason in the prompt (required; "the agent is given this") and calls
      `rejectStep`; the run goes on on the same screen, gate after gate; a push, PR or merge after it shows as a step
      with its outcome
- [ ] Unknown attempt: the recovery report (what it did, from its activity log; its workspace diff) and
      `a adopt   x abort` through `recoverAttempt`
- [ ] Stopped run (stale lock, no unknown attempt): `enter resume` through `resumeRun`, taking the lock over as
      `ahp recover` does today
- [ ] Home's "waiting for you" opens straight on the decision
- [ ] A refusal from the SDK (decided elsewhere, lock held by a live process) is one `error` line on the screen, never a
      crash; the screen re-reads the ledger after
- [ ] Tests (`test/tui-decisions.test.ts`): approve and reject on the mock with a bare remote (`addBareRemote`), two
      gates in a row, adopt and abort (the mock's `hang`, then a crash cut with `truncateLedgerAfter`), resume a stopped
      run, a decision refused because another process holds the lock
