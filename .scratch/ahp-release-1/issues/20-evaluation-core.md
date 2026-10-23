# 20: Evaluation core: tasks, freezing, C0 and C3

**What to build:** An evaluator defines a suite of tasks and runs `ahp eval` for conditions C0 (single agent) and C3 (full AHP). Tasks are frozen before any trial, every trial is scored by the same independent validators, and crashes become harness incidents. Mock trials only; mock results are labelled and never evidence.

**Blocked by:** 04, 06

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · xhigh

- [ ] Task format: fixture repo, task prompt, hidden tests, planted early constraints, seeded defects, protected paths
- [ ] Tasks and hidden tests frozen with hashes recorded in the ledger before any trial; a changed task is detected
- [ ] C0 and C3 condition runners on the same tasks
- [ ] Independent validators score every trial at the end, never from agent self-report
- [ ] Evaluation runs have no approval gates and perform no external actions
- [ ] An `unknown` attempt forces `abort` and records a harness incident, excluded from condition counts and reported per condition
- [ ] Per-trial storage of configs, prompts and raw transcripts
- [ ] Report lists verified success rate and constraint-violation rate per condition

## Implementer notes

- Freeze hash = SHA-256 over the sorted list of (relative path, file content hash) for the whole task directory, recorded before the first trial and re-checked before each trial.
- Condition runners build ordinary workflows and run them through the SDK run API; evaluation adds no separate execution path.
- Validators run after the trial in their own fresh verification worktree, independent of the runtime's in-run verification; the in-run verdict never decides the trial's score.
- A planted-constraint check is a deterministic check (e.g. a forbidden pattern or a required invariant) defined in the task, not a judgement.
