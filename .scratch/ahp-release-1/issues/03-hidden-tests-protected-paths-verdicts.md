# 03: Hidden tests, protected paths, verdicts with evidence

**What to build:** A developer declares hidden tests and protected paths for a step. Hidden tests appear only in the verification worktree, never in the agent's workspace. An attempt that changes a protected path fails verification with evidence. Verdicts are `pass`, `fail` or `inconclusive`, each with evidence, and a broken validator is never counted as pass or fail.

**Blocked by:** 01

**Status:** done

**Model:** Sonnet 5.5 · high

- [x] Hidden tests are copied into the verification worktree only; a test proves the mock agent's workspace never contains them
- [x] Protected paths (hidden tests, test runner config, test scripts, CI config) declared per step; any change fails with a protected-path evidence item
- [x] Agent-written tests are allowed and do not affect the verdict
- [x] Verification states `pending → pass | fail | inconclusive`, with evidence items (test output, diff-scope check, protected-path check)
- [x] A validator that crashes yields `inconclusive`, distinct from `fail`
- [x] Ignored files are not carried into the verification worktree; dependencies are installed fresh

## Comments

2026-10-25, implementation notes. The ticket left several shapes open; these are the choices made, so ticket 04 and later can build on them or reopen them.

- **Declaration** (`VerificationDefinition`, `src/protocol/index.ts`): `hiddenTests: { path, content }[]`, `protectedPaths: string[]` and `install: string`, all optional and per step. `hiddenTests` and `install` need a `command` (checked statically). Hidden-test paths are protected implicitly. A protected path is an exact repository path, a file or a directory with everything under it; no globs, the same stance as artifacts. It is compared without regard to case, so the verdict does not depend on the attempt's filesystem. A change to a path that *contains* a protected path counts too (replacing a protected directory with a file or symlink).
- **Where hidden tests live:** inline in the workflow definition, so their content is in the ledger (`run_created`), which sits under the git common dir and is reachable from an agent's worktree. They are not in the workspace, the snapshot or the handoff (tests assert all three). Do not read this as secrecy from a hostile agent: a worktree is not a boundary (ADR 0002 and CLAUDE.md). The handoff does show the verification *command*, which may name a hidden file's path (ticket 02 behaviour); the file's content and the declaration are never shown. Protected paths are not in the handoff either, so a real agent is not told which paths are protected; telling it would be a handoff schema change (`npm run schemas`) and is left to a later ticket.
- **Verification order:** diff the step's base commit against the snapshot, check protected paths, record `verification_started`, then in the fresh verification worktree: install, write hidden tests, run the command. The diff is against the *base commit*, not the snapshot's parent: the snapshot is committed on top of the workspace's HEAD, so an agent that committed would otherwise hide its changes. A violation skips the command and the worktree (`worktree: null` on `verification_started`): the verdict is already `fail`, and the command would run the attempt's changes to the runner and scripts.
- **Evidence** (no new ledger events; all in `verification_verdict.evidence`): `diff_scope` (changed paths with `added|modified|deleted`, first 200) and `protected_paths` (the protected list and the violations) are recorded whenever the step has protected paths or hidden tests; `validator_error` (stage `diff_scope|verification_worktree|install|hidden_tests|command`, message). The ticket's "diff-scope check" is the `diff_scope` item and nothing more: release 1 has no allow-list scope, and none was invented.
- **Verdict rule:** any failing item → `fail`; otherwise any inconclusive item → `inconclusive`; otherwise `pass`. So a missing required field still fails a step whose command exited 127. An `inconclusive` verdict ends the step as `failed` with failure class `inconclusive` (not `verification_failed`); ticket 04 adds the re-run and escalation.
- **What counts as inconclusive:** the command ended on a signal or returned no exit code, or exited 126 or 127 (the shell's "cannot execute" and "not found" codes, also the code a validator uses to say it is broken); the install failed; the verification worktree, the diff or the hidden tests could not be set up (including a symlink on the way to a hidden test, which AHP refuses to write through). Every other non-zero exit is `fail`. **Limit:** on Windows `cmd` reports a missing command as exit 1 and an externally killed process without a signal, so there those two cases cannot be told from failing tests. The signal test is skipped on Windows; CI covers it on macOS and Linux.
- **"Dependencies installed fresh":** the verification worktree is built from the snapshot alone (tests from ticket 01 prove ignored files and the checkout's `node_modules` are absent), and the new `install` command (for example `npm ci`) runs in it before the verification command. AHP does not guess an install command. The install needs the network or a populated cache, which is why a failed install is inconclusive rather than a failure of the attempt; it also means a package manifest the agent broke shows up as inconclusive unless that file is protected.
- **Agent-written tests** neither fail nor rescue a step: AHP never looks at them, and the verdict comes only from the workflow's command. That holds only to the extent the command runs the hidden tests and not whatever tests the agent left (`node --test` over the whole tree would run both).
- **Mock adapter:** scripts gained `deletes` (removed before `edits`) and `commit` (the agent commits its work).
- **For ticket 04:** the evidence recorded here (test output of hidden tests, protected-path violations) is what a retry attaches to the next handoff revision. Hidden-test output reaches the agent that way, so decide there what a retry may show.
- **Not done:** hidden test files are not hashed into the ledger (ticket 20 freezes tasks with hashes); no timeout on the verification command (ticket 07); a leftover verification worktree after an AHP crash is not cleaned (ticket 06).
- First green CI run: GitHub Actions run 40199865993, 79 tests on Linux and macOS and 78 (1 skipped: the signal test) on Windows; the signal-kill case is therefore confirmed on macOS and Linux.
