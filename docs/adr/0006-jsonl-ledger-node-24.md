# The ledger is hardened JSONL; minimum Node is 24

The source-of-truth ledger is an append-only JSONL file per run with sequence numbers, a hash chain and torn-tail truncation on startup, and the minimum runtime is Node 24. We rejected SQLite via `node:sqlite` because no Node line marks it stable (Node 22: experimental with a warning; Node 24: release candidate), and Node 22 reaches end of life on 2027-04-30. A SQLite read model projected from the JSONL may be added later if evaluation queries need it.

## Consequences

- Ledger writes append to one open file and never use write-temp-then-rename, which fails intermittently on Windows (`EBUSY`/`EPERM` from antivirus and indexers).
- The single-writer lock file is created exclusively and records the owner's process ID; a lock whose process is gone is treated as stale and triggers a recovery report, never a silent takeover.
