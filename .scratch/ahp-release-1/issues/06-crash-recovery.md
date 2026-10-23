# 06: Crash recovery

**What to build:** If the runtime dies mid-run, restarting never re-dispatches an attempt. Any attempt without a terminal record becomes `unknown`, its step goes to `needs_recovery`, and the developer gets a recovery report. They resolve it with `ahp recover <attempt> --policy adopt|abort`.

**Blocked by:** 04, 05

**Status:** ready-for-agent

**Model:** Opus 5.5 · xhigh

- [ ] `dispatching` is durably recorded before the agent process is spawned; every effect has a prior intent event
- [ ] Replay never re-dispatches an attempt that has a `dispatching` record
- [ ] Attempts with no terminal record after restart, an unconfirmed kill, or lost contact become `unknown`
- [ ] Shared-repo ref snapshot (including remote-tracking refs) taken before and after each attempt
- [ ] Recovery report: last ledger events, worktree diff, ref diff, transport tool-call log if any, explicit statement that host and external effects are undetermined
- [ ] Recovery policies per step: `manual` (default), `adopt`, `abort`; `discard_and_retry` rejected as deferred
- [ ] The run process exits at `needs_recovery`; `ahp recover` takes the lock, applies the policy and resumes
- [ ] `adopt` verifies the existing workspace as the attempt's result; `abort` ends the step
- [ ] `ahp recover` refuses unless the attempt is awaiting recovery
- [ ] Tests run the runtime as a child process and kill it before spawn and mid-attempt
