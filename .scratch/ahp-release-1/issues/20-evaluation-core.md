# 20: Evaluation core: tasks, freezing, C0 and C3

**What to build:** An evaluator defines a suite of tasks and runs `ahp eval` for conditions C0 (single agent) and C3 (full AHP). Tasks are frozen before any trial, every trial is scored by the same independent validators, and crashes become harness incidents. Mock trials only; mock results are labelled and never evidence.

**Blocked by:** 04, 06

**Status:** implemented, awaiting the maintainer's answer on the decisions below and the first green CI run

**Model:** Sonnet 5.5 · xhigh

- [x] Task format: fixture repo, task prompt, hidden tests, planted early constraints, seeded defects, protected paths
- [x] Tasks and hidden tests frozen with hashes recorded in the ledger before any trial; a changed task is detected
- [x] C0 and C3 condition runners on the same tasks
- [x] Independent validators score every trial at the end, never from agent self-report
- [x] Evaluation runs have no approval gates and perform no external actions
- [x] An `unknown` attempt forces `abort` and records a harness incident, excluded from condition counts and reported per condition
- [x] Per-trial storage of configs, prompts and raw transcripts
- [x] Report lists verified success rate and constraint-violation rate per condition

## Implementer notes

- Freeze hash = SHA-256 over the sorted list of (relative path, file content hash) for the whole task directory, recorded before the first trial and re-checked before each trial.
- Condition runners build ordinary workflows and run them through the SDK run API; evaluation adds no separate execution path.
- Validators run after the trial in their own fresh verification worktree, independent of the runtime's in-run verification; the in-run verdict never decides the trial's score.
- A planted-constraint check is a deterministic check (e.g. a forbidden pattern or a required invariant) defined in the task, not a judgement.

## Comments

2026-10-28, implementation notes. User doc: `docs/evaluation.md`; code `src/evaluation/`; glossary section "Evaluation"; tests `test/evaluation-task.test.ts`, `test/evaluation.test.ts`, `test/evaluation-scoring.test.ts`, `test/evaluation-lifecycle.test.ts`, `test/cli-eval.test.ts`, `test/transcripts.test.ts`, plus additions to `test/process.test.ts`, `test/ledger.test.ts` and the three real adapters' tests.

**What was added.**
- `ahp eval <suite-file> [--out <dir>] [--json]` and `runEvaluation`/`readEvaluation` in the SDK. A suite is a module (default export) naming task directories, the agent for each role and the conditions; a task is a directory (`task.json`, `repo/`, `hidden/`).
- The freeze, the evaluation ledger (`ledger.jsonl`, its own event union), C0 and C3 as ordinary workflows run by `runWorkflow`, the independent validators, harness incidents and unscored trials, per-trial storage, `report.json`/`report.txt`.
- **A raw transcript for every attempt of every run**, in the process layer (`LaunchOptions.transcript`, `AttemptInput.transcript`, `transcriptPaths`). Nothing kept one before, and the ticket's seventh box and spec stories 84 and 104 need it. Committed on its own (`c8c3a88`).
- `LedgerWriter` and `readLedger` are generic over the event body (default unchanged), and `LedgerWriter.append` now throws on a body field named `seq`, `prevHash`, `time` or `hash`. **That guard was found by a test:** my first `task_frozen` had a `hash` field, which the ledger's own `hash` silently overwrote (the recorded freeze hash was the event's chain hash). It is now `taskHash`, and no body can collide again.

**Verified.** Seam 1 tests drive `runEvaluation` with the scripted mock adapter against real temporary git repositories and real child processes. They cover both disagreements between the run and the validators (a failed run scored a pass, a successful run scored a fail), protected paths, constraints, incidents, unscored trials, a task edited between trials (by mutating a hidden test from `onEvent`), cancel, what a trial keeps (every file's hash checked against its bytes), invalid suites (nothing written) and the report. The freeze hash has a known-answer test worked out with plain `crypto`. Nothing here ran a real tool; every number it produces is `[mock]`.

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Raw transcripts are kept for every attempt, not only in evaluations: stdin and stdout, byte for byte, in `<git dir>/ahp/runs/<run>/transcripts/<attempt>.{in,out}.txt`; stderr is not kept.** *Recommended: adopt.* Stderr stays ignored because ticket 18's decision 2 says an undrained pipe could stall OpenCode, and I did not reopen it. Cost: a file pair per attempt, and the files hold whatever the tool printed, secrets an agent printed included (ticket 18 saw the tail of a real key in an error message); the docs say so. Alternative: only when `ahp eval` asks. It would leave spec story 84 unmet.
2. **The evaluation ledger is a separate event union written by the same `LedgerWriter`** (generic over the body), not new events in the run's `LedgerEventBody`. *Recommended: adopt.* The run replay's exhaustive `never` check and `RecoveryReport.lastEvents` stay about runs. The spec's event list (task frozen, trial started/ended, harness incident) is all there; "spend observed" is ticket 22's.
3. **A task is a directory, and the freeze covers every file in it**, used or not: SHA-256 of the canonical JSON of the sorted `[path, SHA-256 of bytes]` pairs, which is the implementer note's rule written down exactly. The hidden tests also have a hash of their own, and each file is recorded. *Recommended: adopt.* A `.git`, a symlink or a non-UTF-8 hidden test is refused. Line endings are part of the bytes: the repo's `.gitattributes` makes tasks committed in it LF everywhere.
4. **A changed task stops the whole evaluation** (`task_changed`, no further trial, `evaluation_ended: stopped`, exit 1), and a task is never frozen again; an evaluation is never resumed, each `ahp eval` is a new directory. *Recommended: adopt.* The freeze exists so tasks cannot be tuned after results are seen; carrying on with other tasks, or re-freezing, would defeat it.
5. **C0 is one attempt with no retry and only a `summary` required; C3 is plan → implement → review with every step on one `retryBudget` (default 2).** *Recommended: adopt.* C0's `transient` retries are left as C3's (default 5): a rate limit is not something a condition does. C0 gets no hidden-test acceptance, which is C3's treatment, so the matched-budget baseline of ticket 21 can be C0 repeated.
6. **The planted constraints are told to the first step only, and C3's `implement` and `review` are not given the task prompt, only what the previous step reported (`summary`, `decisions`, `constraints`).** *Recommended: adopt, but this is the decision most worth your eye.* It is what makes a violated constraint context lost (glossary: handoff context), and it makes C3 depend on how well its planner summarises the task: a poor plan hurts C3, which is the thing being measured, but it is not "full AHP on the same inputs as C0". The alternative (tell every step the whole task) would measure nothing about context.
7. **A trial passes when the hidden tests pass and no protected path changed; constraints are scored apart; the validators score the last snapshot the run made** (the fixture if none). A protected-path change fails the trial without running the tests, as it fails a step. The violation rate is over the scored trials of tasks that plant at least one constraint, with the counts beside it. *Recommended: adopt.*
8. **"Harness incident" keeps its glossary meaning (an `unknown` attempt) and nothing else is called one.** A trial that cannot be scored for another reason is `unscored` with one of three reasons: `validator_inconclusive` (run twice, the runtime's rule), `setup_failed` (the run ended `config_auth` or `rejected`: a login problem must not read as a condition scoring 0%) and `harness_error` (AHP threw in that trial; the evaluation goes on). All are excluded from the rates and reported apart per condition, with their reasons. `transient` failures that exhaust their budget count as failed trials. *Recommended: adopt.* Ticket 22's invalid-cell threshold should count incidents and unscored trials, which this keeps separate so it can choose.
9. **Seeded defects are in the format (id, description, a fixture file), validated and frozen, and not scored.** *Recommended: adopt.* Nothing in the ticket, the spec's metric list or ticket 21 reads them, and scoring them would mean inventing review-quality semantics. Say what a defect check should be, and it is a small addition (the same deterministic checks as constraints).
10. **A trial's repository is kept in the evaluation's directory, and the evaluation lives in `<AHP_HOME>/evaluations/<id>` by default** (`--out` overrides), outside every repository like the worktrees. *Recommended: adopt.* Its run ledger and pinned snapshots are inside it, so `ahp inspect <run> --repo <trial repo>` works afterwards; copies of the config, prompts, transcripts, ledger, diff and validator evidence sit beside it, each named by path and SHA-256 in `trial_ended`. The attempts' worktrees are removed once a trial ends (they can hold `node_modules`).
11. **Exit codes of `ahp eval`:** 0 when the evaluation completed (a harness incident or a failing condition is a finding, not a failure of the command), 1 when it stopped (a changed task) or failed, 2 for an invalid suite or task (nothing written), 130 when cancelled. *Recommended: adopt.*
12. **Public names:** the SDK exports the evaluation module (`runEvaluation`, `reportOf`, `validateResult`, `EVALUATION_ROLES`, ...); `validate` and `ROLES` were renamed because the doctor module already exports `ROLES`. *Recommended: adopt.*

**Not done, on purpose.** C1, C2, the matched-budget baseline, repeats, shuffled order, paired statistics (ticket 21); the spend cap, invalid cells, tool-version pinning and the API-key expectation in the output (ticket 22); resuming an evaluation after a crash (a crashed `ahp eval` leaves a ledger with a started trial and no `evaluation_ended`); any real-tool trial.
