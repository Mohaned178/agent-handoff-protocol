# 01: Tracer bullet: one-step run with the mock adapter

**What to build:** A developer defines a one-step workflow with the SDK, runs it with `ahp run` against a git repo, and sees with `ahp inspect` that the step succeeded only because verification passed. Under the hood: the mock adapter performs a scripted attempt in a fresh worktree, AHP snapshots the workspace into a commit, runs the workflow's verification command in a fresh verification worktree built from that snapshot, and records everything in a basic append-only JSONL ledger from which state is derived by replay. Includes the repo scaffold: a single TypeScript package with internal module boundaries (protocol, SDK, runtime, ledger, adapters, evaluation, CLI), Vitest, Apache-2.0 LICENSE, CI on Windows, macOS and Linux.

**Blocked by:** None (can start immediately)

**Status:** done

**Model:** Opus 5.5 · high

- [x] Single package scaffold with Vitest; CI runs the test suite on Windows, macOS and Linux runners with no credentials (first green run: GitHub Actions run 40036895588, 22/22 tests on each OS)
- [x] Apache-2.0 LICENSE present (added when the repo was created)
- [x] CLAUDE.md and README updated with build/test commands
- [x] `ahp` refuses to start on Node below 24 with a clear message
- [x] SDK can define a one-step workflow naming the mock adapter and a verification command
- [x] Mock adapter is scripted per attempt (edit files, exit code); its results are labelled as mock in all output
- [x] Each attempt runs in its own git worktree; one attempt = one fresh process
- [x] After the attempt exits, AHP commits a snapshot of the workspace even if the agent did not commit
- [x] Verification runs in a fresh verification worktree from that snapshot; the verification command comes from the workflow definition
- [x] Step succeeds only on verification `pass`; a failing command makes the step `failed`
- [x] Ledger is one append-only JSONL file per run; run/step/attempt state is derived by replay
- [x] `ahp run` executes the workflow and streams progress; `ahp inspect <run>` shows derived state
- [x] Tests exercise seam 1 (SDK run API + mock adapter against a real temporary git repo) and assert only on observable behaviour

## Comments

2026-10-24, implementation notes:

- Locations: ledgers at `<git common dir>/ahp/runs/<run>/ledger.jsonl`; snapshots pinned at `refs/ahp/snapshots/<run>/<attempt>`; worktrees outside every repository at `<AHP_HOME>/worktrees/<run>/<id>` (default: `%LOCALAPPDATA%\ahp`, `~/Library/Application Support/ahp`, `$XDG_STATE_HOME/ahp`). Worktrees were first nested under `.git/ahp/`, but then Node resolution from the verification worktree reached the user's live `node_modules`, which a test now guards against.
- Snapshots use plumbing (`add --all`, `write-tree`, `commit-tree`) with a fixed AHP identity, so no hooks run and no user identity is needed. The attempt worktree is kept; the verification worktree is removed after the verdict.
- The verification command is a string run through the system shell (so `npm test` works on Windows).
- An agent exiting non-zero ends the step as `failed` / `agent_error` without verification. Ticket 04 owns the real failure-class policy (see the comment there).
- Replay refuses a ledger in which a step succeeded without a passing verification.
- Not handled yet: an exception mid-run (e.g. a git failure) leaves the run without `run_terminal`, so it shows as `running`. Tickets 05 and 06 (stale lock, `unknown`, recovery) own that.
