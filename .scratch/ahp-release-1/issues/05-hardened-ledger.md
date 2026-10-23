# 05: Hardened ledger

**What to build:** The ledger survives crashes, corruption and concurrent access. A torn final line is truncated on startup, a broken hash chain is reported by `ahp inspect`, and only one process can write a run at a time (ADR 0006).

**Blocked by:** 01

**Status:** ready-for-agent

**Model:** Opus 5.5 · xhigh

- [ ] Every event has a sequence number and the hash of the previous event
- [ ] On startup a torn tail is detected and truncated, and the truncation is itself recorded
- [ ] `ahp inspect` reports a broken hash chain or sequence gap instead of showing derived state as trustworthy
- [ ] Writes append to one open file; no write-temp-then-rename anywhere
- [ ] Single-writer lock file created exclusively, recording the owner process ID
- [ ] A lock whose owner process is gone is treated as stale and flagged for recovery, never silently taken over
- [ ] Tests cover torn tails and a second writer on all three CI OSes

## Implementer notes

- One event per line: sequence number, previous event's hash, event type, payload, and this event's hash = SHA-256 over the canonical JSON of the event without its own hash field (sorted keys, no whitespace).
- Flush to disk after each append (file handle sync) before reporting the effect as recorded.
- Torn tail = a final line that is unparseable or lacks its trailing newline. Truncate to the end of the last valid line, then append a `ledger_truncated` event recording how many bytes were dropped.
- Lock: create the lock file with exclusive-create semantics; write host name, PID and start time. Stale = PID not alive on this host (`process.kill(pid, 0)` throws). If the PID is alive, report "lock held by PID X" and stop; never guess.
- On Windows, opening a file can fail briefly with `EBUSY`/`EPERM` (antivirus, indexer). Retry the open a bounded number of times with short backoff; never retry a partial write.
- Never use write-temp-then-rename for the ledger or the lock.
