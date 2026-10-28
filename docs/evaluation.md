# Evaluation

`ahp eval <suite-file>` runs a suite of tasks under conditions C0 to C3 and a matched-budget baseline, says how often each produced a result that independent validators accept, and compares the conditions task by task with confidence intervals. It exists to test one claim, that structured, validated handoffs beat a single agent and a plain-text pipeline (design doc §7), and a negative or inconclusive result is reported as plainly as a positive one. Tickets 20 (the core) and 21 (C1, C2, the baseline, repeats, a seeded order, the measures and the statistics); the spend cap, invalid cells and version pinning are ticket 22.

**Mock results are never evidence.** A trial that ran on the mock adapter is labelled `[mock]` in the report, in the ledger (`trial_ended.mock`) and in the CLI output. Real-tool trials need the pilot's budget and keys, which are still open (design doc §9, item 9).

## What gets run

A **task** is a directory (below). A **suite** names tasks and the coding agent for each role. For every task, every condition and every repeat, `ahp eval` makes a fresh git repository from the task's fixture, builds an ordinary workflow, runs it through the same run API `ahp run` uses (`runWorkflow`), and then scores what the run left. Evaluation adds no execution path of its own.

| Condition | What runs |
|---|---|
| **C0** | One step, `solve`, by the suite's `implement` agent: the task and all its constraints in one prompt, **no retry budget** (one attempt at the task; only a `transient` failure such as a rate limit is retried, with backoff, as in every condition), and no acceptance check beyond reporting a `summary`. |
| **C1** | The plain-text pipeline: `plan` → `implement` → `review` by the same three agents as C3, each reporting **one field of free text, `output`**, which is all the next step is handed. No acceptance check but that the text was reported (there is nothing to hand on otherwise), **no retry**, and a review that sends nothing back. |
| **C2** | AHP's handoffs without acceptance checks: the same pipeline, each step handing on C3's structured fields (`summary`, `decisions`, `constraints`; the review reports `verdict` and `findings`) under a validated, versioned handoff with C3's capability requests. **No verification command, no hidden tests, no protected paths, no retry**, and a review that is an ordinary step: its verdict sends nothing back. A step that does not report a field its handoff carries ends the run there, as nothing can be handed on. |
| **C3** | Full AHP: C2 plus the task's hidden tests (with its `install` and protected paths) as the implement step's verification, a retry budget (default 2) on every step shared by agent errors, failed verification and review send-backs, and a review that sends `implement` back on `changes_requested`. |
| **baseline** | The matched-budget baseline: for each **scored** C3 trial, as many independent C0 trials as attempts that C3 trial made (plan, implement and review, retries and `transient` ones included), on the same task in the same repeat. The cell **passes if any of its trials passes**. It tells structure apart from simply trying more. |

C2 against C1 is the envelope's effect; C3 against C2 is the acceptance checks' and retry's (design doc §7). So the three pipeline conditions tell every step **the same words**, apart from how C1 reports, and give it the same capability requests: the plan and review steps ask to be `read_only` in all three (at the level the adapter declares, which for most adapters is `cooperative`: words, not enforcement).

What is told to whom is part of the design. The task's prompt **and its planted constraints** go to the first step only: C0's single agent, the pipeline's `plan`. The pipeline's `implement` and `review` are told what to do in fixed words and learn the constraints only from what the step before them handed on: C1's text, or C2's and C3's handoff context (`summary`, `decisions`, `constraints`). That is what makes the constraints a test of context loss.

In every workflow the steps are agent steps only: **no approval gate and no external action**, so a trial never waits for a person and nothing is published (a trial's repository has no remote, and its pull-request provider refuses every call). Every step recovers an `unknown` attempt by `abort`, never `manual`. The task's network stance is on every step of every condition, so it is the same for a task everywhere. `transient` failures (a rate limit) are retried alike in every condition, so "no retry" is about the agent's work, not about the provider's limits.

## Order, repeats and the seed

Every task runs under every condition (the baseline aside) once per repeat (`repeats`, default 1). The trials are not run task by task: after the tasks are frozen, the whole list is put in a **Fisher-Yates shuffle drawn from a seeded generator** (mulberry32), and the seed and the resulting order are recorded in the ledger (`trials_scheduled`) before the first trial starts. Each trial then starts in exactly that order, and replay refuses a ledger in which one did not. When a C3 trial is scored, its baseline trials are drawn into the trials still to come, each at a position from the same generator (`baseline_scheduled`, with the positions), so they too run interleaved with the rest rather than in a block at the end. The order therefore depends on the seed and on how many attempts each C3 trial made, and the ledger holds both.

The seed is `--seed <n>` (an integer from 0 to 4294967295; `seed` in `runEvaluation`'s options) or, by default, drawn at random and recorded. The same seed resamples the comparisons, so a report can be recomputed from its ledger.

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
  conditions: ["C0", "C1", "C2", "C3", "baseline"],         // default: all five
  agents: {
    plan:      { adapter: "claude-code" },
    implement: { adapter: "codex", model: "..." },
    review:    { adapter: "opencode", model: "..." },
  },
  retryBudget: 2,                                           // C3's steps; the others have none
  repeats: 3,                                               // trials per task and condition; default 1
  spendCap: { amount: 40, currency: "USD" },                // optional: see Safeguards
  maxIncidentRate: 0.34,                                    // optional: see Safeguards
  toolVersions: { codex: "0.146.0", "claude-code": "2.1.311" }, // optional: see Safeguards
};
```

`implement` is always needed, since C0 (and so the baseline) is that one agent alone; `plan` and `review` are needed when C1, C2 or C3 runs. The baseline needs C3. An agent may also be a function of the task and the trial (`implement: (task, { condition, repeat, baselineIndex }) => ...`), which is how a scripted mock agent is given the right edits for each fixture; it is called while the suite is validated too. Every workflow a condition would build is validated against the registered adapters before anything is written: an invalid suite or task is a usage error (exit 2) that names the task, the condition and the problem.

## Safeguards

Four limits keep an evaluation from overspending, from producing numbers out of a flaky cell, or from comparing conditions that differ in ways nobody chose. All are recorded in the ledger (`evaluation_created.safeguards`).

- **Spend cap** (`spendCap: { amount, currency }`). After each trial AHP adds up the cost the tools *reported*, in that currency, over every trial that has ended, and records it (`spend_observed`). Once the total reaches the cap no further trial starts and the evaluation ends `stopped` with reason `spend_cap`. It is checked between trials, so the trial that reaches the cap, and one under way, run to the end: the total can pass the cap by up to a trial's cost. It counts only what a tool reports: an attempt that reported no cost (a subscription, a tool that does not say, another currency) adds nothing, and the report says how many attempts that was, since their spend is unknown and not zero. A cap that no tool ever reports against never stops anything. **So it does not replace the spend limit in each provider's console: set one there for every key the evaluation uses.**
- **Invalid cells** (`maxIncidentRate`, 0 to 1). A cell is one task under one condition. When more than that share of its ended trials (cancelled ones aside) are harness incidents, the cell is **invalid**: its trials are left out of that condition's rates and of every comparison (for the baseline, its cells are incomplete), and the report names it, with the incident count. A rate exactly at the threshold is valid. With no threshold set no cell is marked, though every incident is still shown. The design leaves the number to the pilot (§9, item 3), so there is no default.
- **Network stance.** A task's stance is on every step of every condition, and a suite is rejected (a usage error, exit 2) if the workflows its conditions build give a task's agent steps more than one network setting. Conditions build theirs from the task today, so this guards against a change to a condition rather than against a suite file.
- **Tool versions** (`toolVersions`, by `ahp doctor` tool id: `claude-code`, `codex`, `opencode`, `gemini-cli`). At the start of each trial AHP runs each tool the trial's agents use with its `--version` (what `ahp doctor` does, nothing else) and records the version number it printed beside the pin (`trial_started.tools`). A trial whose version is not the pin, or cannot be read, is flagged as a **version mismatch** in the progress line and in the report, which lists every version found and how many trials ran on it. A mismatch does not stop the evaluation or exclude the trial: whether a trial on another version still counts is the evaluator's call. A tool in use with no pin is recorded as not pinned. The mock is no tool and records none.

`ahp eval` says before it starts that it expects each tool to be logged in with an **API key** configured in that tool (see below), on stderr with `--json`.

## Freezing

Before any trial, every task is read once and **frozen** in the evaluation's own ledger (`task_frozen`): the hash of the whole directory, the hash of the hidden tests, and each file's hash. The freeze hash is the SHA-256 of the canonical JSON of the sorted `[relative path, SHA-256 of the bytes]` pairs, so it depends on nothing but the files' paths and bytes. Every `task_frozen` is recorded before the first `trial_started`; replay refuses a ledger in which a task is frozen after a trial began.

Before **each trial** the task directory is read again and hashed. The bytes that were hashed are the bytes the trial uses (its fixture commit, its hidden tests), so a task cannot change between the check and the trial. If it no longer hashes as frozen, or cannot be read, `ahp eval` records `task_changed` (with the paths added, deleted and modified), starts **no further trial**, ends the evaluation `stopped`, and exits 1. A task is never frozen again within an evaluation, and an evaluation is never resumed: each `ahp eval` is a new directory.

## Scoring

Every trial is scored **after its run has ended, by validators that share nothing with the run's verification**. They build a fresh worktree from the commit the run left (the last snapshot any attempt made, or the fixture if it made none), install, write the hidden tests in, and run the task's command. The in-run verdict never decides the score (C0 has none to speak of), and the agent's own report is not read. A run that failed can be scored a pass, and a run that succeeded can be scored a fail.

- **Verified success** is the hidden tests passing with no protected path changed. A trial that changed a protected path fails without the tests being run.
- **A constraint violation** is scored apart: a trial can pass and still violate a planted constraint, which is the context-loss signature. The rate is over the scored trials of tasks that plant at least one constraint **and whose result changed something**: a result identical to the fixture holds every constraint vacuously, and counting it would lower the rate for producing nothing. The report says how many were left out.
- A validator that cannot run to a result (an install that fails, a command killed by a signal) is run once more, then the trial is **unscored**, never a pass or a fail.

## How a trial ends

| Outcome | Meaning | In the rates? |
|---|---|---|
| `scored` | The validators ran to a result: `pass` or `fail`. | Yes, the only ones. |
| `harness_incident` | An attempt of the trial's run is `unknown`: it may have done anything and may still be running. Recorded as a `harness_incident` event (the glossary's meaning, and only that), with the attempt and why. | No. Reported apart, per condition. |
| `unscored` | Nothing to score: `validator_inconclusive`, `setup_failed` (a step of the run ended `config_auth` or `rejected`, whichever step: a login or configuration problem, so the condition did not run as configured), or `harness_error` (AHP itself threw during the trial). | No. Reported apart, per condition, with the reason. |
| `cancelled` | Ctrl+C. The trial in hand is cancelled, nothing further starts, and the exit code is 130. While cancelling, the runtime leaves an `unknown` attempt for a person instead of applying the step's `abort`, so a cancel that could not confirm a kill leaves the trial's run in `needs_recovery`: `ahp recover <attempt> --policy abort --repo <the trial's repository>` ends it. | No. |

An `unknown` attempt is never retried: the steps' `abort` policy ends the step, so the trial's run ends and the trial is recorded. Failed trials are also broken down by how their run ended (`agent_error`, `verification_failed`, `run_succeeded`, ...), so a condition that fails for a reason of its own shows.

## What is kept

`ahp eval` keeps its evaluations in `<AHP_HOME>/evaluations/<evaluation id>/` (the per-user directory, outside every repository) or under `--out <dir>`:

```
<evaluation id>/
  ledger.jsonl          the evaluation's ledger: hash-chained, one writer, torn tail truncated (ADR 0006)
  report.json  report.txt
  trials/<trial id>/
    repo/               the trial's repository: `ahp inspect <run> --repo <this>` reads its run
    config.json         condition, repeat, baseline cell, task and its hash, the workflow (hidden tests by path and hash, not text), retry budget, platform, Node and protocol versions
    prompts/<attempt>.txt       what the attempt's agent process was sent on stdin
    transcripts/<attempt>.txt   what it printed on stdout, raw
    run-ledger.jsonl    the trial's run ledger as it ended
    result.patch        the diff from the fixture to the result that was scored
    validation.json     the validators' evidence: each command's output, each constraint's finding
```

Each file is named in the trial's `trial_ended` event by path, SHA-256 and size. Each is kept on its own: one that cannot be kept (a disk problem) is left out and named in the event's `artifacts.problem`, and never changes how the trial is classified. **Raw transcripts hold whatever the tool printed**: if an agent printed a secret, it is in the file, and AHP cannot redact what it keeps raw. Stderr is not kept. For the OpenCode adapter the "prompt" file is the ACP messages AHP sent, the prompt among them. The same transcript files are kept for every attempt of every run, in `<git dir>/ahp/runs/<run>/transcripts/`, not only in evaluations.

## The report

Per condition: trials, scored trials, **verified success** and **constraint violations** as `n of d (p%)` (a rate is never shown without its counts, and with nothing scored it says so instead of showing 0), failures by how their run ended, harness incidents, unscored trials with their reasons, cancelled trials, and trials scheduled and never run. Then, over the scored trials:

- **Retries per success**: the attempts beyond each step's first (send-backs and `transient` retries included), over the passes, with both counts.
- **Duplicated and reverted work**, in lines (`git diff --numstat`, added plus deleted; a binary file counts 0). *Duplicated* is the work of attempts whose snapshot is not in the result's history: a failed attempt, or one a review sent back, whose work was done again. *Reverted* is the work of the attempts that are in it, beyond what the result shows: lines one step wrote and a later one changed again or took out. Both are blind to what the lines mean; they measure work thrown away or redone, not its quality.
- **Wall time**: each run's, from its creation to its end (median and mean).
- **Usage, only as each tool reported it**: per adapter, how many attempts reported anything, each number summed over the attempts that reported it (and how many did), cost per currency, and the source labels. Never estimated, never summed across adapters (one counts cached input inside its input tokens, another outside), and never compared between conditions. Usage counts every trial that ended, scored or not.

**The baseline** is reported by cell, one per scored C3 trial: a cell passes when any of its trials passed and fails when every one was scored and none did. A cell with a trial that was not scored (a harness incident, an unscored trial) or never run is **incomplete** and left out, named with why, whether or not another of its trials passed: it was not given C3's whole budget, and counting only the cells that happened to pass would flatter it. Its wall time is per complete cell, the sum of its trials'.

**Paired comparisons.** For each pair the evaluation ran (C3 against C0, the baseline, C1 and C2; C2 against C1; C1 against C0), task by task: each side's success rate on a task is its passes over its valid trials (scored trials, harness incidents excluded; for the baseline, complete cells), the paired difference is rate(A) − rate(B), and the headline is the **mean paired difference across tasks**, with a **95% interval from a paired bootstrap over tasks**: 10,000 resamples of the tasks with replacement, from mulberry32 seeded with the evaluation's seed, the interval's ends being the 250th and the 9,750th of the sorted resampled means. Each task's raw counts (passes, valid trials, incidents) are shown beside its rates, and a task without a valid trial on a side is left out and named.

- An interval that **includes 0** is reported as **"no detectable difference"**, never as better or worse.
- Only an interval wholly above or below 0 says one rate is **higher** or **lower** than the other.
- With fewer than 2 tasks to pair there is no interval, and the comparison is **inconclusive**.
- Each interval stands alone: nothing corrects for making six comparisons, so one of them excluding 0 by chance is to be expected now and then. A pilot of 5–8 tasks gives wide intervals; it is sized to measure variance and cost, not to test the hypothesis (design doc §7).

Whatever the numbers, they are not evidence while they are `[mock]`.

## What an evaluation does not hide from an agent

The hidden tests are never in an agent's workspace, its snapshot or its handoff. They are in the run's ledger, though, because the workflow definition is (C3's only: no other condition's workflow holds them), and that ledger is in the trial repository's `.git/ahp`, which every attempt's worktree shares. An agent that goes looking there can read them. Capabilities are `cooperative` at most for most adapters, and a worktree is isolation, not a security boundary: this is the limit of what the design (ADR 0002) gives, and a pilot should treat a task whose hidden tests an agent could have read as a reason to read its transcript. The trial's `config.json`, beside the repository, does not hold them.

## Before a real evaluation

Needed before the pilot, and not something AHP can check for you: set spend limits in each provider's console (AHP can only see what a tool reports, and says so), use API-key logins configured in each tool (design doc §9, item 9; subscription use under `ahp eval` falls under each vendor's terms; `ahp eval` states this expectation but reads no credential), pin the tool versions in the suite (the safeguards above record and report them), and expect that verification executes agent-written code on your machine: a worktree is isolation, not a security boundary.
