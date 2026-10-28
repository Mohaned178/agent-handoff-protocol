# Evaluation

`ahp eval <suite-file>` runs a suite of tasks under two conditions and says how often each produced a result that independent validators accept. It exists to test one claim, that structured, validated handoffs beat a single agent (design doc §7), and a negative result is as legitimate as a positive one. This is ticket 20, the core: conditions C0 and C3 on mock trials. C1, C2, the matched-budget baseline, repeats, shuffled order and confidence intervals are ticket 21; the spend cap, invalid cells and version pinning are ticket 22.

**Mock results are never evidence.** A trial that ran on the mock adapter is labelled `[mock]` in the report, in the ledger (`trial_ended.mock`) and in the CLI output. Real-tool trials need the pilot's budget and keys, which are still open (design doc §9, item 9).

## What gets run

A **task** is a directory (below). A **suite** names tasks and the coding agent for each role. For every task, and every condition, `ahp eval` makes a fresh git repository from the task's fixture, builds an ordinary workflow, runs it through the same run API `ahp run` uses (`runWorkflow`), and then scores what the run left. Evaluation adds no execution path of its own.

| Condition | What runs |
|---|---|
| **C0** | One step, `solve`, by the suite's `implement` agent: the task and all its constraints in one prompt, **one attempt, no retry**, and no acceptance check beyond reporting a `summary`. |
| **C3** | `plan` → `implement` → `review`, full AHP: handoffs between steps, the task's hidden tests as the implement step's verification, a retry budget (default 2) shared by agent errors, failed verification and review send-backs, and a review that sends `implement` back on `changes_requested`. |

What is told to whom is part of the design. The task's prompt **and its planted constraints** go to the first step only: C0's single agent, C3's `plan`. C3's `implement` and `review` are told what to do in fixed words and learn the constraints only through their handoff's context, which is the previous step's required output fields (`summary`, `decisions`, `constraints`). That is what makes the constraints a test of context loss.

In every workflow the steps are agent steps only: **no approval gate and no external action**, so a trial never waits for a person and nothing is published (a trial's repository has no remote, and its pull-request provider refuses every call). Every step recovers an `unknown` attempt by `abort`, never `manual`. The task's network stance is on every step of both conditions, so it is the same for a task everywhere. `transient` failures (a rate limit) are retried alike in both conditions.

## A task

```
<task dir>/
  task.json   the task
  repo/       the fixture repository's files; every trial starts from one commit of exactly these
  hidden/     the hidden tests: hidden/<path> is written at <path> in a validator's worktree, and nowhere else
```

```json
{
  "id": "password-reset",
  "prompt": "Add a password-reset endpoint ...",
  "constraints": [
    {
      "id": "no-md5",
      "statement": "Never hash anything with MD5.",
      "check": { "kind": "forbidden_pattern", "pattern": "md5", "flags": "i", "paths": ["src"] }
    },
    {
      "id": "login-still-works",
      "statement": "Existing login behaviour must not change.",
      "check": { "kind": "required_invariant", "command": "node login-invariant.mjs" }
    }
  ],
  "seededDefects": [{ "id": "off-by-one", "description": "the page size is one too many", "path": "src/page.js" }],
  "verification": { "command": "node --test", "install": "npm ci", "protectedPaths": ["package.json", "test"] },
  "network": { "stance": "deny" }
}
```

- **`prompt`** is the task as the first agent is told it. **`constraints`** are *planted*: each has a `statement` the first agent is told, and a **deterministic** `check`, never a judgement: `forbidden_pattern` (a regular expression searched in the text files of the result, optionally under `paths`) or `required_invariant` (a command that must exit 0 in the result, with the hidden tests in place). A fixture that already matches a forbidden pattern is rejected, since no trial could then violate it.
- **`verification`**: `command` runs through the system shell in a validator's worktree with the hidden tests written in. `install` runs first, for dependencies. `protectedPaths` (and the hidden tests' own paths) may not be changed by a trial.
- **`seededDefects`** are defects the fixture is known to contain, for review evaluation. They are part of the format and are frozen with the task. **Ticket 20 does not score them**; nothing reads them yet. Each names a file of the fixture.
- Everything else in the directory is frozen too and used for nothing. A task holds plain files: a `.git` directory, a symbolic link or anything that is not a file or a directory is refused. Hidden tests must be UTF-8 text. Keep tasks small: a task is read into memory.

Commands run through the system shell, `cmd.exe` on Windows: write them portably (`node script.mjs`). On Windows a command that does not exist exits 1, which cannot be told from failing tests (the same limit as step verification).

## A suite

A module whose default export is the suite, like a workflow file for `ahp run`:

```js
export default {
  name: "pilot-1",
  tasks: ["./tasks/password-reset", "./tasks/rate-limit"], // relative to this file
  conditions: ["C0", "C3"],                                 // default: both
  agents: {
    plan:      { adapter: "claude-code" },
    implement: { adapter: "codex", model: "..." },
    review:    { adapter: "opencode", model: "..." },
  },
  retryBudget: 2,                                           // C3's steps; C0 has none
};
```

`implement` is always needed, since C0 is that one agent alone; `plan` and `review` are needed when C3 runs. An agent may also be a function of the task (`implement: (task) => ...`), which is how a scripted mock agent is given the right edits for each fixture. Every workflow a condition would build is validated against the registered adapters before anything is written: an invalid suite or task is a usage error (exit 2) that names the task, the condition and the problem.

## Freezing

Before any trial, every task is read once and **frozen** in the evaluation's own ledger (`task_frozen`): the hash of the whole directory, the hash of the hidden tests, and each file's hash. The freeze hash is the SHA-256 of the canonical JSON of the sorted `[relative path, SHA-256 of the bytes]` pairs, so it depends on nothing but the files' paths and bytes. Every `task_frozen` is recorded before the first `trial_started`; replay refuses a ledger in which a task is frozen after a trial began.

Before **each trial** the task directory is read again and hashed. The bytes that were hashed are the bytes the trial uses (its fixture commit, its hidden tests), so a task cannot change between the check and the trial. If it no longer hashes as frozen, or cannot be read, `ahp eval` records `task_changed` (with the paths added, deleted and modified), starts **no further trial**, ends the evaluation `stopped`, and exits 1. A task is never frozen again within an evaluation, and an evaluation is never resumed: each `ahp eval` is a new directory.

## Scoring

Every trial is scored **after its run has ended, by validators that share nothing with the run's verification**. They build a fresh worktree from the commit the run left (the last snapshot any attempt made, or the fixture if it made none), install, write the hidden tests in, and run the task's command. The in-run verdict never decides the score (C0 has none to speak of), and the agent's own report is not read. A run that failed can be scored a pass, and a run that succeeded can be scored a fail.

- **Verified success** is the hidden tests passing with no protected path changed. A trial that changed a protected path fails without the tests being run.
- **A constraint violation** is scored apart: a trial can pass and still violate a planted constraint, which is the context-loss signature. The rate is over the scored trials of tasks that plant at least one constraint.
- A validator that cannot run to a result (an install that fails, a command killed by a signal) is run once more, then the trial is **unscored**, never a pass or a fail.

## How a trial ends

| Outcome | Meaning | In the rates? |
|---|---|---|
| `scored` | The validators ran to a result: `pass` or `fail`. | Yes, the only ones. |
| `harness_incident` | An attempt of the trial's run is `unknown`: it may have done anything and may still be running. Recorded as a `harness_incident` event (the glossary's meaning, and only that), with the attempt and why. | No. Reported apart, per condition. |
| `unscored` | Nothing to score: `validator_inconclusive`, `setup_failed` (the run ended `config_auth` or `rejected`, so no agent did the work: a login or configuration problem, not a condition's result), or `harness_error` (AHP itself threw during the trial). | No. Reported apart, per condition, with the reason. |
| `cancelled` | Ctrl+C. The trial in hand is cancelled, nothing further starts, and the exit code is 130. | No. |

An `unknown` attempt is never retried: the steps' `abort` policy ends the step, so the trial's run ends and the trial is recorded. Failed trials are also broken down by how their run ended (`agent_error`, `verification_failed`, `run_succeeded`, ...), so a condition that fails for a reason of its own shows.

## What is kept

`ahp eval` keeps its evaluations in `<AHP_HOME>/evaluations/<evaluation id>/` (the per-user directory, outside every repository) or under `--out <dir>`:

```
<evaluation id>/
  ledger.jsonl          the evaluation's ledger: hash-chained, one writer, torn tail truncated (ADR 0006)
  report.json  report.txt
  trials/<trial id>/
    repo/               the trial's repository: `ahp inspect <run> --repo <this>` reads its run
    config.json         condition, task and its hash, the workflow, platform, Node and protocol versions
    prompts/<attempt>.txt       what the attempt's agent process was sent on stdin
    transcripts/<attempt>.txt   what it printed on stdout, raw
    run-ledger.jsonl    the trial's run ledger as it ended
    result.patch        the diff from the fixture to the result that was scored
    validation.json     the validators' evidence: each command's output, each constraint's finding
```

Each file is named in the trial's `trial_ended` event by path, SHA-256 and size. **Raw transcripts hold whatever the tool printed**: if an agent printed a secret, it is in the file, and AHP cannot redact what it keeps raw. Stderr is not kept. For the OpenCode adapter the "prompt" file is the ACP messages AHP sent, the prompt among them. The same transcript files are kept for every attempt of every run, in `<git dir>/ahp/runs/<run>/transcripts/`, not only in evaluations.

## The report

Per condition: trials, scored trials, **verified success** and **constraint violations** as `n of d (p%)` (a rate is never shown without its counts, and with nothing scored it says so instead of showing 0), failures by how their run ended, harness incidents, unscored trials with their reasons, and cancelled trials. It draws **no comparison between conditions**, and says so; the paired comparison with confidence intervals is ticket 21's. Whatever the numbers, they are not evidence while they are `[mock]`.

## Before a real evaluation

Not done by this ticket, and needed before the pilot: set spend limits in each provider's console (AHP can only see what a tool reports), use API-key logins configured in each tool (design doc §9, item 9; subscription use under `ahp eval` falls under each vendor's terms), pin and record tool versions, and expect that verification executes agent-written code on your machine: a worktree is isolation, not a security boundary.
