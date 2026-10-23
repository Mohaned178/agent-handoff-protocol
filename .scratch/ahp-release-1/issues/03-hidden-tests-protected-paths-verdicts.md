# 03: Hidden tests, protected paths, verdicts with evidence

**What to build:** A developer declares hidden tests and protected paths for a step. Hidden tests appear only in the verification worktree, never in the agent's workspace. An attempt that changes a protected path fails verification with evidence. Verdicts are `pass`, `fail` or `inconclusive`, each with evidence, and a broken validator is never counted as pass or fail.

**Blocked by:** 01

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Hidden tests are copied into the verification worktree only; a test proves the mock agent's workspace never contains them
- [ ] Protected paths (hidden tests, test runner config, test scripts, CI config) declared per step; any change fails with a protected-path evidence item
- [ ] Agent-written tests are allowed and do not affect the verdict
- [ ] Verification states `pending → pass | fail | inconclusive`, with evidence items (test output, diff-scope check, protected-path check)
- [ ] A validator that crashes yields `inconclusive`, distinct from `fail`
- [ ] Ignored files are not carried into the verification worktree; dependencies are installed fresh
