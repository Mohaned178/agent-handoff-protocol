# 07: Cancellation and the shared process layer

**What to build:** Ctrl+C on `ahp run` cancels the current attempt safely on every OS. All adapters launch agents through one shared process layer that resolves real executables, passes prompts safely, and kills whole process trees.

**Blocked by:** 01

**Status:** done

**Model:** Opus 5.5 · high

- [x] Executables are resolved to the real binary; `.cmd` shims are never run through a shell
- [x] Prompts are passed via stdin or file, never as shell arguments; a test with shell metacharacters in the prompt proves no injection
- [x] Cancel uses the transport's graceful path when the adapter declares one; otherwise graceful signal → grace period → process-tree kill, and on Windows a forced tree kill
- [x] `cancelled` is recorded only after termination is confirmed, and records graceful vs forced
- [x] An unconfirmed kill makes the attempt `unknown`
- [x] Mock adapter can be scripted to hang and to spawn child processes; tests prove no orphans remain on all three CI OSes

## Implementer notes

- Launch with execa and `shell: false` always.
- Resolving on Windows: search `PATH` with `PATHEXT`. If a real `.exe` exists, use it. If only an npm `.cmd` shim exists, parse the shim to find the JavaScript entry point and run it with the current Node executable (`process.execPath`). If neither works, fail with a clear message that `ahp doctor` also shows. Never run a `.cmd` through `cmd.exe`.
- POSIX: start the agent in its own process group (detached), send SIGTERM to the group, wait the grace period, then SIGKILL the group.
- Windows: `taskkill /PID <pid> /T /F`, then confirm every process in the tree has gone before recording `cancelled`; record `forced: true`.
- Confirmation: poll until the PIDs are gone, up to a timeout; if they don't disappear, the attempt becomes `unknown`.
- Test with a mock script that spawns a grandchild which ignores signals; assert no process from the tree survives, on all three CI OSes.
- Test prompt passing with a prompt containing `& | ; $() " '` and newlines; assert the agent receives it byte-for-byte via stdin and nothing executes.

## Comments

2026-10-26, implementation notes.

**Decisions the ticket left open. Confirmed by the maintainer on 2026-10-26 ("do recommendation"), each as recommended; reopen one only with a new decision:**

1. **Ctrl+C cancels the run, not just the attempt.** After a cancel no agent is dispatched again (replay refuses `attempt_created` and `attempt_dispatching` after `run_cancel_requested`), the step in hand ends `cancelled`, and the run ends `cancelled`. The spec's state machines already have `cancelled` for run and step; continuing with the next step after a Ctrl+C would surprise anyone who pressed it. *Recommended: keep.*
2. **The cancel is recorded before anything is stopped** (`run_cancel_requested`, then `attempt_cancelling` before any signal), so a process that dies mid-cancel leaves a ledger that `ahp recover <run>` goes on cancelling. It does not resume the work. *Recommended: keep; it is the intent-before-effect rule.*
3. **An unknown attempt in a run being cancelled always waits for a person**, whatever its step's `recovery` policy. `adopt` would run a verification command after the user asked to stop. The person who pressed Ctrl+C is there to decide. After the decision the run still ends `cancelled`, unless every step had succeeded. *Recommended: keep.*
4. **A verification running at the cancel is stopped** with the same tree kill. Its verdict is recorded `inconclusive`, at the stage it was in, with the message "the run was cancelled, so the command was stopped…", so the "every verification gets a verdict" rule holds. It is not re-run; the step is `cancelled`. *Recommended: keep. Letting a long test suite finish after Ctrl+C would defeat the cancel.*
5. **Exit code 130** for a cancelled run (what a shell reports for SIGINT), next to 0/1/2/3. *Recommended: keep.*
6. **A second Ctrl+C does not interrupt the cancel.** It only prints that the cancel is under way. The cancel is bounded: the grace period (5 s) plus confirmation (10 s). Killing ahp mid-cancel would leave an `unknown` attempt to recover. *Recommended: keep.*
7. **execa 10.1.1** (as the notes say), pinned to a release two weeks old. execa 10 resolves Windows commands itself and runs anything that is not an `.exe`/`.com` through `cmd.exe`, a file it cannot find included. So `launch` refuses anything but an existing `.exe`/`.com` on Windows, and `resolveExecutable` always produces one. *Recommended: keep execa, with that guard. Plain `child_process.spawn` would do the same job with no dependency, if you prefer fewer dependencies.*
8. **Windows agents are not detached.** Node's `detached` on Windows gives the child no console, and console programs it starts then lose their output (the verification command's output vanished in testing). So on Windows an agent shares AHP's console, and a console Ctrl+C reaches it too. AHP still kills whatever is left of the tree and confirms it gone. If the agent had already ended on its own, the attempt keeps its own outcome and is not recorded `cancelled` (changed after review; see below). A Windows agent that fails just before ahp hears of the cancel is given 250 ms for it to arrive, then treated the same way. *Recommended: keep.*
9. **PATH order wins on Windows.** The directories are searched in order; within one directory a `.exe`/`.com` beats a `.cmd`/`.bat` shim; the first match is used, and an unusable shim is an error rather than a silent fall-through to a later directory. *Recommended: keep (it runs what the user's shell would run).*

**Shapes:**

- **Process layer** (`src/process`, new module):
  - `resolveExecutable(command, { env, platform })`: returns `Executable { file, prefixArgs, via: executable|npm_shim, path }`, or throws `ExecutableNotFoundError` with what was searched, ready for `ahp doctor` (ticket 13).
    - Windows: PATHEXT is used, but only `.com`/`.exe`/`.bat`/`.cmd` count.
    - npm shims: both the cmd-shim ≥ 4 form and the older `%~dp0` form are read. A shim's `.exe` target runs directly, and a Node shim's entry point runs with `process.execPath`. Anything else is refused.
    - Linux and macOS: an executable regular file on PATH.
  - `launch({ executable, args, cwd, input, env })`: execa with `shell: false`, `reject: false`, `buffer: false`, `cleanup: false`, `forceKillAfterDelay: false`. Input goes on stdin (empty if none, so stdin is always closed). Linux and macOS get their own process group.
  - `terminate`/`terminateTree(root, { graceful, graceMs, confirmMs })` returns a `Termination`: `{ outcome: "already_gone" }`, `{ outcome: "stopped", forced, via }` or `{ outcome: "unconfirmed", survivors, detail }` (shape changed after review).
    - Linux and macOS: the graceful callback if given, or else SIGTERM to the group, then SIGKILL to the group. "Gone" means `kill(-pgid, 0)` fails, or `ps` shows only zombies left in the group.
    - Windows: the tree is read with PowerShell CIM (PID, parent PID, creation time). A child counts only if it was created after its parent, so a reused parent PID cannot pull in strangers, and orphans whose parent already exited still count. Then `taskkill /F /T /PID …` over every PID. Polling then checks that each is gone; a survivor counts only if its creation time still matches.
- **Protocol**:
  - `CANCEL_PATHS` (`transport`, `signal`, `tree_kill`) and `AttemptCancel { forced, via }`, where `via` is never null.
  - New events: `run_cancel_requested` and `attempt_cancelling { attemptId }`.
  - `attempt_exited.cancel` (null except for the `cancelled` outcome; an old ledger without it reads as null).
  - `step_terminal` and `run_terminal` accept `cancelled`.
  - Derived state: `RunView.cancelRequestedAt` and `AttemptView.cancellation { requestedAt, result }`.
  - No Zod schema changed, so `schemas/` is untouched.
- **Replay rules:**
  - `run_cancel_requested` only on a running run, once.
  - `attempt_cancelling` only for a running attempt after it.
  - The `cancelled` outcome exactly when the event has a `cancel`, and only for an attempt being cancelled; that `cancel`'s `forced` is exactly `via == tree_kill`. An attempt being cancelled may still exit with its own outcome.
  - `unconfirmed_kill` only for an attempt being cancelled.
  - A `cancelled` step only after the cancel, with no failure class, and with its last attempt `created` or `exited`.
  - A `cancelled` run only after the cancel.
- **Adapter contract:**
  - `AdapterDeclaration.gracefulCancel` (the mock: false).
  - `StartedAttempt.cancel({ graceMs })`, returning a `Termination`.
  - `startAttempt` must launch through the process layer.
- **Executor:**
  - `ExecuteRunOptions` (and the SDK's run, resume and recover options) take `signal` and `cancelGraceMs` (default `DEFAULT_GRACE_MS`, 5000), carried as one `RunCancel` in the run context.
  - `drive` records `run_cancel_requested` at the top of a turn once the signal is aborted, then takes the cancelled path (`advanceCancelledStep`).
  - `executeAttempt` races the agent's exit against the abort.
    - On abort: `attempt_cancelling`, then `cancel`, then `attempt_exited(cancelled)` with the exit code or signal the adapter reports within 5 s, and no reported output (a cancelled agent's report is not its result). An agent found already gone keeps its own exit. An unconfirmed kill becomes `attempt_unknown(unconfirmed_kill)`.
    - A cancel while `startAttempt` is pending gives the adapter 10 s to finish starting, so the agent can be stopped. If it never says, the attempt is `unknown (lost_contact)`.
  - A retry's backoff ends at the cancel.
  - The verification and install commands are stopped through `terminateTree`.
  - A verification command runs in its own process group on Linux and macOS, like an agent.
- **Mock adapter:**
  - Starts its agent through `launch`, and `cancel` is the process layer's `terminate`.
  - New script fields: `spawnGrandchild` (a grandchild that ignores SIGTERM/SIGINT/SIGHUP, for 10 minutes at most), `ignoreSignals`, and `pidFile` (absolute; the agent writes its PID and the grandchild's).
- **CLI:**
  - `ahp run` and `ahp recover` turn SIGINT and SIGTERM into the abort and exit 130 for a cancelled run.
  - New progress lines: "cancelling: no further agent is dispatched", "cancelling: stopping the agent (PID n) and every process it started", and "exited cancelled (signal …; forced: its process tree was killed)" or "stopped gracefully by SIGTERM…".
  - `ahp inspect` shows each attempt's cancel.
- **Tests:**
  - `test/process.test.ts` (16 tests, 1 skipped on Windows), the new process-layer seam:
    - Shim resolution on a Windows layout (read on any OS through `platform: "win32"`): both shim forms, an `.exe` target, `.exe` over `.cmd`, PATH order, a non-shim `.cmd` refused, a missing entry point, and not found. POSIX resolution runs only on Linux and macOS.
    - A prompt full of shell metacharacters and CR/LF reaches an agent started through an npm shim (Windows) or a shebang script (elsewhere) byte for byte on stdin. Arguments arrive as they are, and none of the six injection canaries appears.
    - Tree kill with a grandchild that ignores signals; graceful SIGTERM (forced on Windows); a transport cancel; a transport cancel that is not enough; and an already-exited process.
  - `test/cancel.test.ts` (8 tests, seam 1, all three OSes):
    - A cancel mid-attempt with a signal-ignoring grandchild: no process of the tree survives (checked by PID), the outcome is forced `tree_kill`, and the event order is right.
    - Graceful vs forced per OS; a cancel during backoff (no second attempt); a cancel before the first attempt; and a cancel during verification.
    - A crash after `attempt_cancelling` resumed: the attempt is unknown and waits for a person despite `recovery: "abort"`, and the abort then leaves the run `cancelled`.
    - Replay refusing a dispatch after the cancel; and an unconfirmed kill (a wrapped mock through `executeRun`) making the attempt `unknown (unconfirmed_kill)`.
  - `test/cli-cancel.test.ts`: SIGINT to `ahp run` (Linux and macOS only) exits 130, stops the whole tree, and prints the cancel lines.
  - `startRun` now exposes `exited`.

**Not done:**

- Linux and macOS have not been run locally (WSL has no Node). The POSIX paths of `terminateGroup`, the POSIX resolution test and `test/cli-cancel.test.ts` run first in CI.
- An adapter still cannot say that nothing was spawned. A missing binary makes `startAttempt` throw, which stays `unknown (lost_contact)` (ticket 06, decision 5), not `config_auth`. Doing it properly wants the executable resolved before `attempt_dispatching`, for example an adapter `prepare` step; that fits with ticket 13 or 15.
- Ctrl+C on Windows is not tested end to end. Node cannot send CTRL_C_EVENT to a child, so the cancel is tested through the SDK signal on Windows.
- An agent that leaves processes behind when it exits normally (no cancel) is not cleaned up. A Windows Job Object would need native code.
- On Linux and macOS a grandchild that calls `setsid` leaves the process group and is not killed or seen. Tree confirmation covers the group only.
- `launch` checks that the `.exe` exists before execa resolves it. If the file is removed in between, execa would fall back to `cmd.exe` with its own escaping.
- Reading the Windows process table costs a PowerShell start (about 0.5–2 s) per cancel.

2026-10-26, after review (Standards and Spec, on 1fc43dc). The maintainer adopted every recommendation ("do recommendation"): the nine decisions above and fixes A to E below.

Fixed:

- **A. The Windows Ctrl+C race.** A console Ctrl+C reaches the agent at the same moment as ahp, so the agent could exit before ahp heard of the cancel. Its exit was then recorded as an error, and nothing killed the rest of its tree. Now an agent, or a verification command, that ended with a failure on Windows while a signal is given waits up to 250 ms for the cancel (`cancelledAround`, `src/runtime/cancel.ts`). If the cancel comes, what is left of its tree is stopped as for any cancel. For a verification command, a failure at the cancel is recorded `inconclusive` ("the run was cancelled as the command failed, which may be why it failed"), never `fail`. Tested on Windows: an agent that exits 3, with the cancel 50 ms later, is not retried.
- **B. No `cancelled` without a cancel sent.** `terminateTree` now says `already_gone` when every process had ended before anything was sent. The attempt then exits with its own outcome, recorded under `attempt_cancelling` with `cancel: null`. `AttemptCancel.via` is never null, and replay allows an attempt being cancelled to exit with its own outcome. Tested with a wrapped mock whose exit is seen only once the cancel has found it gone.
- **C.** The transport's cancel takes SIGTERM's place, so there is one grace period, not two. On Linux and macOS, a group whose only members are zombies, which signal 0 still reaches (and which macOS can refuse with EPERM), counts as gone once `ps -A -o pgid=,stat=` shows only `Z` entries.
- **D.**
  - A cancel during verification records `run_cancel_requested` before the command is stopped (`CommandCancel.beforeStop`), so before its verdict (tested).
  - The bounded waits during a cancel go through the `Clock`: `Clock.sleep` takes an optional `AbortSignal`, which also ends the backoff wait.
  - One `requestCancel` records the request, at the top of a turn or just before a turn's effect is cut short.
- **E. Clean-ups:**
  - One `within` (on the clock) and one `unlessCancelled` replace the two `within`s and `aborted`; the `"aborted"` sentinel is now `CANCELLED`.
  - One `answers` replaces `groupAlive`/`pidAlive`'s duplicate; `DEFAULT_GRACE_MS` and `OWN_PROCESS_GROUP` are shared.
  - `signal` and `cancelGraceMs` travel as one `RunCancel` in the run context.
  - The verification abort listener is removed.
  - The termination prose is in `format.ts` only.
  - Replay refuses a dispatch after the cancel before changing any state.
  - The verification cancel test now waits until the command runs, and checks its PID is gone.

Kept, with reasons:

- **`AdapterDeclaration.gracefulCancel` and `TerminateOptions.graceful` have no caller yet.** The ticket requires the transport path, and the ACP adapters (tickets 18 and 19) are its callers. It is tested at the process-layer seam.
- **`run_cancel_requested` is recorded from more than one place**, through one helper. A cancel that cuts an effect short partway through a turn must be recorded before the effect is stopped, by the rule that every effect has a prior intent event. It cannot wait for the next turn.
- **An unconfirmed kill of a verification command is evidence, not `unknown`.** `unknown` is an attempt outcome; a verification is AHP's own validator. Its evidence message says the command could still be running.
- **On Linux and macOS a `setsid` grandchild still escapes the group** (see "Not done").
- **Decision 1 (cancel the run, not just the attempt) and the extra CLI behaviour** (SIGTERM, a cancellable `ahp recover`, exit code 130) were confirmed by the maintainer.

First green CI run: GitHub Actions run 40303830006 (commit c4ec411). 251 tests passed on Linux and macOS (1 skipped: the signal test). Windows had 249 passed and 3 skipped: the signal test, the POSIX resolution test and the Ctrl+C CLI test. `test/process.test.ts`, `test/cancel.test.ts` and, on Linux and macOS, `test/cli-cancel.test.ts` passed on all three. Typecheck and build pass on all three.

The run before it (40303342673, on de543ce) failed one test each on Linux and macOS. The mock agent wrote its grandchild's PID before the grandchild had installed its signal handlers, so a cancel sent at once stopped it with SIGTERM and read as graceful. c4ec411 writes the PIDs only once the grandchild says it ignores the signals.
