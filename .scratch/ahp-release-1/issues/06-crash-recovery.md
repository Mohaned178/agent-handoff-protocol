# 06: Crash recovery

**What to build:** If the runtime dies mid-run, restarting never re-dispatches an attempt. Any attempt without a terminal record becomes `unknown`, its step goes to `needs_recovery`, and the developer gets a recovery report. They resolve it with `ahp recover <attempt> --policy adopt|abort`.

**Blocked by:** 04, 05

**Status:** ready-for-agent

**Model:** Opus 5.5 · xhigh

- [x] `dispatching` is durably recorded before the agent process is spawned; every effect has a prior intent event
- [x] Replay never re-dispatches an attempt that has a `dispatching` record
- [x] Attempts with no terminal record after restart, an unconfirmed kill, or lost contact become `unknown`
- [x] Shared-repo ref snapshot (including remote-tracking refs) taken before and after each attempt
- [x] Recovery report: last ledger events, worktree diff, ref diff, transport tool-call log if any, explicit statement that host and external effects are undetermined
- [x] Recovery policies per step: `manual` (default), `adopt`, `abort`; `discard_and_retry` rejected as deferred
- [x] The run process exits at `needs_recovery`; `ahp recover` takes the lock, applies the policy and resumes
- [x] `adopt` verifies the existing workspace as the attempt's result; `abort` ends the step
- [x] `ahp recover` refuses unless the attempt is awaiting recovery
- [x] Tests run the runtime as a child process and kill it before spawn and mid-attempt

## Comments

2026-10-26, implementation notes. The ticket left several shapes open; these are the choices made, so tickets 07 to 10 can build on them or reopen them.

**Eight decisions the ticket left to me. Confirmed by the maintainer on 2026-10-26, each kept as built; reopen one only with a new decision:**

1. **`ahp recover <run-id>` is the restart.** There is no `ahp resume`. `ahp recover <run-id>` takes over the stale lock (or a free lock on an unfinished run), records `run_resumed { takenOverFrom }`, and continues the run from where its ledger stops. That marks an attempt left dispatched or running as `unknown`, writes its report, and applies the step's policy or stops for a person. `ahp recover <attempt-id> --policy adopt|abort` is the decision. The spec's CLI list stays as it is; the SDK has `resumeRun` and `recoverAttempt`.
2. **An attempt that was created but never dispatched is taken up, not made `unknown`.** Dispatching is recorded before the spawn, so the ledger proves no agent ran. The attempt's half-made workspace is discarded and made again, and the attempt is dispatched for the first time, under the same ID and attempt number. Read literally, "no terminal record means `unknown`" would stop the run for a person over an attempt known to have done nothing.
3. **Step policies `adopt` and `abort` apply at once, and only `manual` stops the run.** `attempt_unknown` puts the step in `needs_recovery`; `recovery_awaited` (manual only) puts the run there and the process exits. So the run leaves `needs_recovery` only through `ahp recover`, as the spec's run state machine says. A step whose policy is `adopt` but whose workspace is gone waits for a person instead.
4. **An adopted workspace that fails verification is retried like any failed verification**, under the step's budget, with a new handoff revision carrying the evidence. That answers ticket 04's question about `retry_scheduled` after recovery. `abort` fails the step as `unknown` and is never retried. The cheaper reading, where an adopted attempt that fails ends the step, costs one agent attempt less per such failure. It is one branch in `advanceUnknownAttempt`.
5. **An adapter that fails is `unknown (lost_contact)`.** That covers `startAttempt` rejecting (the adapter cannot vouch that nothing started) and `exited` rejecting (it lost track of the process). This ends ticket 04's thrown adapter failures. The mock's "no script for attempt N" now stops the run in `needs_recovery` instead of throwing. Ticket 07's process layer may let an adapter say "nothing was spawned" (a missing binary is `config_auth`).
6. **A verification the runtime stopped during is `inconclusive`**, with new validator stage `runtime_stopped`, and re-run once like any other. It counts as that one re-run, so a crash during the re-run escalates the step. Its leftover worktree is removed if it can be.
7. **Effects and their intents.** Each worktree is named in `attempt_created` / `verification_started` before it is made. The spawn follows `attempt_dispatching`, and the verification command follows `verification_started`. The snapshot has no intent event of its own: its ref is fixed by the run and attempt IDs (`refs/ahp/snapshots/<run>/<attempt>`), and a snapshot that stopped partway is simply redone, overwriting the ref. Truncating a torn tail and taking over a stale lock are recorded just after: no event can be written before them.
8. **Exit code 3** from `ahp run` and `ahp recover` means the run stopped for a recovery decision (0 succeeded, 1 failed or error, 2 usage).

**Shapes:**

- **Executor** (`src/runtime/run.ts`): rewritten as `drive`, a loop that reads the next action from the replayed state and records at least one event per turn (it throws if a turn records nothing). Each turn is one of: make the step ready, issue or validate a handoff, run an attempt to its exit, take the refs after it, snapshot, verify, record the failure class, schedule a retry or end the step. So the same code continues a run after any crash point, and the old flow's in-memory state (the accepted revision, the current agent, the base) is now read from replay. A retry's backoff waits only for what is left of it (`scheduledAt + delayMs - now`). `executeRun`, `resumeRun` and `recoverAttempt` (`src/runtime/resume.ts`) all end in `drive`.
- **Protocol:** `UNKNOWN_REASONS` (`no_terminal_record`, `lost_contact`, `unconfirmed_kill`, the last produced by ticket 07), `RECOVERY_POLICIES`, `RECOVERY_ACTIONS`, `StepDefinition.recovery`, `RecoveryReport`, `SharedRef`, `RefChange`, and `LockOwner` (moved from the ledger, since an event carries it now). New events:
  - `ref_snapshot_taken { attemptId, phase: before|after, refs }`
  - `attempt_unknown { attemptId, reason, detail }`
  - `recovery_report_written { attemptId, report }`
  - `recovery_awaited { attemptId }`
  - `recovery_decided { attemptId, policy, decidedBy: human|step_policy, user }`
  - `run_resumed { takenOverFrom }`

  Derived state: `AttemptView.refs`, `.retry` (the retry scheduled after it) and `.recovery { reason, detail, report, awaited, decision }`, plus `RunView.resumptions`. No Zod schema changed, so `schemas/` is untouched.
- **Replay rules:**
  - `attempt_unknown` only for a dispatching or running attempt.
  - Report, await and decision only for an unknown, undecided attempt, in that order.
  - A person decides only an awaited attempt, and the step policy only one that is not awaited.
  - Snapshot and verification of an unknown attempt only once it is adopted.
  - `attempt_failed` accepts an unknown attempt: `unknown` only after `abort`, `verification_failed` or `inconclusive` from its verdict after `adopt`.
  - Ref snapshots: `before` while the attempt is created, `after` once it has exited.
  - `run_resumed` only on a run that has not ended.
- **Ref snapshots** (`src/runtime/refs.ts`): `git for-each-ref` in the shared repository, everything under `refs/` but `refs/ahp/`, recorded just before dispatch and again once the agent has exited. Remote-tracking refs and tags are included; the main worktree's HEAD is not a ref, so it is not in it.
- **Recovery report** (`src/runtime/recovery.ts`), stored in its ledger event:
  - the last 10 events before the attempt was found unknown, as `{ seq, time, type }`;
  - the workspace: whether it exists, and the paths that differ from the step's base commit (tracked and untracked, first 200, read with `--no-optional-locks`);
  - the ref diff: the `before` snapshot against the refs now;
  - `toolCallLog: null`, since no adapter keeps one yet (tickets 18 and 19);
  - `undetermined`, the fixed statement plus the agent's PID, or "whether the agent's process started is not known".
- **Lock** (`src/ledger/lock.ts`, `writer.ts`): `LedgerWriter.open(path, now, { takeOverStale })` takes over only a stale lock. It reads the lock again, removes it only if it still names the owner it found gone, then acquires it normally and returns `takenOverFrom`. A held lock, one on another host and one naming no owner are refused as before. `close` removes the lock only while it still names this writer, which was ticket 05's note. `clearStaleLock` removes the stale lock of a run that has ended or awaits a decision, without writing to its ledger.
- **SDK:** `resumeRun({ repo, runId }) → { runId, state, resumed, takenOverFrom }`, with `resumed: false` and nothing written for a run that has ended or awaits a decision. `recoverAttempt({ repo, attemptId, policy })`. `RecoveryRefusedError`, `isRunId`, `isAttemptId`.
- **`recoverAttempt` refuses** an attempt that exited, was never dispatched, was already decided, or is still dispatched in a run that has not been examined (it says to run `ahp recover <run>` first). It also refuses an attempt no run has, and `adopt` of a workspace that is gone. It checks before taking the lock and again under it, and writes nothing when it refuses. A human decision records the OS user name.
- **CLI:**
  - `ahp recover <run-id>` and `ahp recover <attempt-id> --policy adopt|abort` stream progress like `ahp run`.
  - `ahp run` and `ahp recover` print the report as it is written, and the commands to decide with.
  - `ahp inspect` shows each unknown attempt's reason, report and decision, the resumptions, the attempts awaiting a decision, and an `ahp recover <run>` hint on a stale or free lock of an unfinished run.
  - `--policy discard_and_retry` and a step's `recovery: "discard_and_retry"` are refused with the deferral reason (`DISCARD_AND_RETRY_DEFERRED`).
- **Mock adapter:** `loseContact` (the adapter cannot say how the attempt ended), `hang` (the agent makes its edits and never exits), and `hangBeforeSpawn` (`startAttempt` never settles, so the runtime waits after recording dispatching).
- **Tests:**
  - `test/recovery.test.ts` (seam 1, 23 tests): ref snapshots; lost contact; adopt, a failing adopt retried, abort, and the refusals; step policies and the `discard_and_retry` refusal; and `resumeRun` from each crash point, cut from a finished ledger with `truncateLedgerAfter`. The crash points are after dispatching and after running (unknown, never dispatched again), after created (dispatched once, in a fresh workspace), after exited, after verification started (inconclusive, then re-run), and after a transient retry (waits the remaining 1500 ms of 2000). It also covers a stale lock taken over and recorded, a held lock refused, and an ended or awaiting run left untouched.
  - `test/cli-recovery.test.ts`: `ahp run` killed after `attempt_dispatching` (`hangBeforeSpawn`), then `ahp recover <run>` exits 3, never dispatches the attempt again, and `--policy abort` fails the run. `ahp run` killed mid-attempt (`hang`, with a remote-tracking ref moved afterwards), where the report shows the added file and the moved ref, and `--policy adopt` verifies the workspace and the run succeeds. Plus exit code 3 from `ahp run` and the usage and refusal errors.
  - `test/ledger.test.ts`: release only while the lock names its writer, and takeover only of a stale lock.
  - `test/helpers/process.ts` now holds `until`, `untilGone` and `startRun`, shared with `test/cli-ledger.test.ts`.
  - Two event-list tests gained the two `ref_snapshot_taken` events per attempt.

**Not done:**

- An orphaned agent, or a verification command that outlived the runtime, is not killed: the report says its PID may still be running, and the process layer is ticket 07's. On Windows such a process keeps its working directory, so the leftover worktree of an interrupted verification can stay behind.
- Two `ahp recover` at once on the same stale lock: between re-reading it and removing it there is a window in which both could take it. The hash chain would then break visibly rather than silently.
- The ref snapshot lists every ref, so a repository with thousands of tags makes two large events per attempt.
- The fallback of `adopt` to a person when the workspace is gone is untested: no test can remove the workspace between the attempt's loss and its report.
- The spec's side-effect class (`workspace_only` / `may_have_external_effects`, user story 15) is in no ticket; recovery does not use it.
- Events lost from the very end of a ledger (ticket 05's note) are still undetectable.

Checked by mutation: re-dispatching an attempt found dispatching or running, and releasing a lock without checking its owner, each make tests fail.
