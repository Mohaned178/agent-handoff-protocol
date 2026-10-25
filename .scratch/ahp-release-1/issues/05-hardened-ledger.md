# 05: Hardened ledger

**What to build:** The ledger survives crashes, corruption and concurrent access. A torn final line is truncated on startup, a broken hash chain is reported by `ahp inspect`, and only one process can write a run at a time (ADR 0006).

**Blocked by:** 01

**Status:** ready-for-agent

**Model:** Opus 5.5 · xhigh

- [x] Every event has a sequence number and the hash of the previous event
- [x] On startup a torn tail is detected and truncated, and the truncation is itself recorded
- [x] `ahp inspect` reports a broken hash chain or sequence gap instead of showing derived state as trustworthy
- [x] Writes append to one open file; no write-temp-then-rename anywhere
- [x] Single-writer lock file created exclusively, recording the owner process ID
- [x] A lock whose owner process is gone is treated as stale and flagged for recovery, never silently taken over
- [ ] Tests cover torn tails and a second writer on all three CI OSes

## Implementer notes

- One event per line: sequence number, previous event's hash, event type, payload, and this event's hash = SHA-256 over the canonical JSON of the event without its own hash field (sorted keys, no whitespace).
- Flush to disk after each append (file handle sync) before reporting the effect as recorded.
- Torn tail = a final line that is unparseable or lacks its trailing newline. Truncate to the end of the last valid line, then append a `ledger_truncated` event recording how many bytes were dropped.
- Lock: create the lock file with exclusive-create semantics; write host name, PID and start time. Stale = PID not alive on this host (`process.kill(pid, 0)` throws). If the PID is alive, report "lock held by PID X" and stop; never guess.
- On Windows, opening a file can fail briefly with `EBUSY`/`EPERM` (antivirus, indexer). Retry the open a bounded number of times with short backoff; never retry a partial write.
- Never use write-temp-then-rename for the ledger or the lock.

## Comments

2026-10-26, implementation notes. The ticket left several shapes open; these are the choices made, so ticket 06 and later can build on them or reopen them. The last box stays open until the tests have passed on all three CI OSes.

**Decisions the ticket left to me (awaiting the maintainer's confirmation):**

- **Only a writer truncates a torn tail.** "On startup" is read as the start of a process that opens an existing ledger to write it (`LedgerWriter.open`, holding the lock). Readers (`readRun`, `readRunEvents`, `inspectRun`, `ahp inspect`) never modify a ledger: they leave the torn line out of the derived state and report it. Truncating is a write and needs the single-writer lock, and a reader that truncated could cut off an event a live writer is still appending. Nothing in the runtime opens an existing ledger until ticket 06 (resume, `ahp recover`) and 09 (`ahp approve`/`reject`), so truncation is tested at the ledger module, a seam the maintainer agreed for this ticket.
- **A corrupt ledger shows no state at all.** `readRun`, `readRunEvents` and `inspectRun` throw `LedgerCorruptError` naming the first bad line, and `ahp inspect` prints it to stderr and exits 1 with nothing on stdout, also with `--json`. The alternative, state derived from the events before the break with a warning, invites the trust the ticket says not to give.
- **A stale lock is refused, never removed.** `LedgerWriter.open` throws `LedgerLockedError` (`lock.state` is `stale`) and leaves the lock file as it is; `ahp inspect` flags the run as needing recovery. A lock whose owner is on another host, and a lock file that names no owner, are refused in the same way. A PID reused by an unrelated process reads as running ("lock held by PID X"); AHP reports it rather than guess. Ticket 06 owns the explicit takeover in `ahp recover`.
- **`ahp inspect --json` prints `{ state, ledger, writer }`** instead of the bare `RunView`, since the lock and a torn tail are not derived state. The four CLI tests that read it were updated. Pre-1.0, so no compatibility shim.
- **Events stay flat:** `{ seq, prevHash, time, type, ...payload, hash }`, rather than the nested `payload` object the notes list. Nothing else changes shape, and the hash covers every field either way.
- **Ledgers written before this ticket are refused** ("line 1 is not a ledger event"): they have no chain. There are no users yet, so there is no migration.
- **`ahp inspect` also flags an unfinished run that no process holds** ("writer: none, yet the run has not ended ... needs recovery"). A runtime that throws partway (ticket 04's thrown adapter failures) releases its lock on the way out, so without this, such a run would look like one in progress.

**Shapes:**

- **Event and hash** (`src/ledger/chain.ts`): `hash` is SHA-256 (lowercase hex) over the canonical JSON of the event without `hash`: keys sorted by UTF-16 code unit, no whitespace. The JSON is built as a string, so an output field named `__proto__` serializes like any other. `prevHash` is null for event 1. The writer hashes the plain JSON round trip of the event it writes, and `append` returns exactly that plus `hash`, so live state and replayed state come from the same bytes.
- **Reading** (`readLedger(path) → { events, validBytes, tornTail, corruption }`): it checks each line in order (an event's shape, then `seq`, then `prevHash`, then `hash`) and stops at the first problem. Corruption kinds are `unreadable` (a middle line that is not JSON or not an event), `out_of_sequence` (gap, repeat or step back; a deleted line reports as a gap, not a broken link) and `broken_chain`. A torn tail is a last line without its newline, or a last line with one that is not JSON; a last line that parses but fails the chain is corruption.
- **Writing** (`src/ledger/writer.ts`): `create` takes the lock and then creates the ledger with `ax`. `open` takes the lock, checks the chain, and refuses a corrupt ledger or one with no complete event. It truncates a torn tail through a separate `r+` handle (on Windows a handle opened to append has no `FILE_WRITE_DATA`, so it cannot truncate), datasyncs, reopens with `a` and appends `ledger_truncated { droppedBytes }`. Each event is one `write` and one `datasync`. A write that throws or is short is never retried: the writer refuses further appends, and the next opener truncates the torn line. `close` releases the lock even if closing the file fails. `executeRun` holds the lock for the whole run and releases it in `finally`, so a process killed mid-run leaves a stale lock.
- **Lock** (`src/ledger/lock.ts`): `ledger.lock` beside the ledger holds `{ host, pid, startedAt }` (the owner process's start time, from `process.uptime()`, so a human can tell a reused PID apart), written once and datasynced after an exclusive `wx` create. On `EEXIST`, `readLockState` gives one of `held`, `stale`, `other_host` or `unreadable`; a lock released between the create attempt and the read is tried again, twice at most. Only `ESRCH` from `process.kill(pid, 0)` counts as gone, so `EPERM` (not ours to signal) means running. One case is certain without guessing: a lock naming this process's own PID with another start time was an earlier process's, since no two running processes share a PID, so it is stale. Windows hands a freed PID to a new process quickly, and the next `ahp inspect` or `ahp recover` can be the one that gets it. A full test run showed this: a lock naming an exited child's PID read as held.
- **Windows file locking** (`whileBusy`, `src/ledger/busy.ts`): opens, reads and unlinks retry on `EBUSY`/`EPERM` up to 5 times (25 ms doubling to 400 ms, about 0.8 s), on every platform. Writes are never wrapped.
- **Derived state:** `RunView.ledgerTruncations: { seq, time, droppedBytes }[]`; replay accepts `ledger_truncated` anywhere after `run_created`.
- **SDK:** `inspectRun({ repo, runId }) → RunInspection { state, ledger: { events, tornTail }, writer: LockState }`, which reads the lock before the ledger. `LedgerCorruptError`, `LedgerCorruption`, `LockState`, `LockOwner`, `RunInspection` and `LedgerTruncation` are public. `LedgerWriter` and `LedgerLockedError` stay internal until ticket 06 needs them.
- **CLI:** `ahp inspect` prints `ledger: N events, hash chain intact`, each recorded truncation, a torn tail (described as an event probably being written while a live writer holds the lock), and a `writer:` line when someone holds the lock or the run is unfinished. `ahp run` would print a `ledger_truncated` event, but no run produces one yet.
- **Tests:** `test/ledger.test.ts` covers the chain checked by an independent canonical JSON in `test/helpers/ledger.ts`, each kind of corruption, torn tails left out by readers and truncated by `open`, the lock during a run, a second writer, stale, other-host and ownerless locks, and `inspectRun`. `test/cli-ledger.test.ts` covers `ahp inspect` in each case, plus a live `ahp run` child held in verification: a second writer is refused naming the child's PID, and after `SIGKILL` the lock is stale, `ahp inspect` flags recovery and `open` still refuses. That test waits for the orphaned verification command to exit, since Windows cannot delete the working directory of a running process. Test helpers still write ledgers directly; they are test code.

**For ticket 06:**

- `ahp recover` needs an explicit takeover of a stale lock. Suggested shape: an `open` option that removes the lock only if its content still equals the stale owner the user was shown, then records the takeover (the old owner) as an event.
- A crash between `run_terminal` and releasing the lock leaves a stale lock on a finished run; `ahp inspect` says the writer "ended the run but stopped without releasing its lock". Recovery can clear it without a report.
- The crash tests can reuse the held-verification pattern in `test/cli-ledger.test.ts` (`VERIFY_WHEN_RELEASED`, `AHP_TEST_CONTROL`).
- A test that needs a dead PID uses `GONE_PID` (`test/helpers/ledger.ts`), never an exited child's PID, which Windows can reuse at once. After killing a runtime, wait until its PID reads as free before asserting that its lock is stale.

**Not done:**

- No fsync of the run directory after creating the ledger file, so on POSIX a power loss right after a run starts could lose the new file's directory entry.
- No PID-reuse detection beyond this process's own PID; for any other process the start time is recorded for a human to compare.
- The `EBUSY`/`EPERM` retry is untested, because CI cannot force those errors.
- No migration for ledgers written before this ticket.

Checked by mutation: removing the `prevHash` check, the gap check, the event's own hash check, the torn-tail truncation or the own-PID rule, or taking a stale lock over, each makes at least one of these tests fail.
