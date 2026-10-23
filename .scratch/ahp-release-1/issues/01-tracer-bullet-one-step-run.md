# 01: Tracer bullet: one-step run with the mock adapter

**What to build:** A developer defines a one-step workflow with the SDK, runs it with `ahp run` against a git repo, and sees with `ahp inspect` that the step succeeded only because verification passed. Under the hood: the mock adapter performs a scripted attempt in a fresh worktree, AHP snapshots the workspace into a commit, runs the workflow's verification command in a fresh verification worktree built from that snapshot, and records everything in a basic append-only JSONL ledger from which state is derived by replay. Includes the repo scaffold: a single TypeScript package with internal module boundaries (protocol, SDK, runtime, ledger, adapters, evaluation, CLI), Vitest, Apache-2.0 LICENSE, CI on Windows, macOS and Linux.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Model:** Opus 5.5 · high

- [ ] Single package scaffold with Vitest; CI runs the test suite on Windows, macOS and Linux runners with no credentials
- [x] Apache-2.0 LICENSE present (added when the repo was created)
- [ ] CLAUDE.md and README updated with build/test commands
- [ ] `ahp` refuses to start on Node below 24 with a clear message
- [ ] SDK can define a one-step workflow naming the mock adapter and a verification command
- [ ] Mock adapter is scripted per attempt (edit files, exit code); its results are labelled as mock in all output
- [ ] Each attempt runs in its own git worktree; one attempt = one fresh process
- [ ] After the attempt exits, AHP commits a snapshot of the workspace even if the agent did not commit
- [ ] Verification runs in a fresh verification worktree from that snapshot; the verification command comes from the workflow definition
- [ ] Step succeeds only on verification `pass`; a failing command makes the step `failed`
- [ ] Ledger is one append-only JSONL file per run; run/step/attempt state is derived by replay
- [ ] `ahp run` executes the workflow and streams progress; `ahp inspect <run>` shows derived state
- [ ] Tests exercise seam 1 (SDK run API + mock adapter against a real temporary git repo) and assert only on observable behaviour
