# Spec: one command to run a task

**Status:** planned (2026-10-30), decisions D1 to D6 waiting on the maintainer

Asked for by the maintainer on 2026-10-30, after trying to update this repository's README with AHP: "why should a
developer do all these steps when he can go to Claude Code and write 'improve my readme' and that is it".

## Problem

A run today needs a workflow file. Writing one, even through `ahp setup`, means answering about ten questions: the task,
the check command, the install command, the paths, a name, a tool, model and effort for each of three steps, a branch,
a file name. Claude Code needs one sentence. However good the checks are, a tool that costs ten questions before it
does anything loses to one that costs a sentence.

And on some tasks AHP should lose. A README edit has nothing to test, is read in seconds, and costs nothing when it is
wrong: there, AHP's checks are all cost. AHP is worth using when an agent's "done" cannot be trusted and a mistake is
expensive: a test defines done, the task is long or runs while nobody watches, more than one tool is used, or a record
of what was asked, done, checked and approved is needed. The docs should say so, and stop implying AHP is for every task.

## What it should feel like

```
$ ahp "fix the bug where the cart total ignores quantity"

  task       fix the bug where the cart total ignores quantity
  check      npm test                  (from package.json)
  install    npm ci                    (package-lock.json)
  implement  Codex CLI                 its default model
  review     Claude Code               its default model
  result     local branch ahp/fix-the-bug-where-the-cart  (nothing is pushed)

? Run it?  ❯ Run   Change something   Cancel
```

One sentence and one keypress. Everything AHP could work out, it worked out, and it shows where each answer came from.
It asks a question only for something it cannot work out (a project with no test command, for instance).

## Changing a step's tool or model (the maintainer's question)

At the summary, **Change something** lists the steps; picking one asks its tool, then its model (the tool's default
first, then what the tool lists or AHP knows, then a name typed in), then the effort where the tool has one, the same
menus `ahp setup` uses today. Then the summary is shown again with the change, and Run starts it.

The same without a menu, for scripts and for people who know what they want:

```
ahp "fix the cart total" --review claude-code --review-model opus
ahp "fix the cart total" --implement codex --implement-model gpt-5.6-terra --implement-effort high
```

After a change in the menu, AHP asks once "Use Claude Code (opus) for review next time? (y/N)"; yes saves it in a
per-user settings file, so it is the default from then on, shown as "(your default)" in the summary.

Not covered: changing a step's tool or model **while the run is going**. A step's handoff names its recipient (adapter
and model) when it is issued and the ledger records it, so a change mid-run would be a new kind of reroute. A run that
went badly is run again with other choices; `ahp again <run> --review opencode` (the same task, other choices) is a
possible later ticket.

## Decisions (each with a recommendation; "do recommendation" adopts them all)

- **D1. How a task is given.** `ahp "<task>"` (the first argument, when it is not a command) or `ahp do "<task>"`.
  *Recommendation:* `ahp "<task>"`. A misspelt command must not start agents: a single word that is not a command is
  still "unknown command", and the Run? question always comes before anything runs (`--yes` skips it, and is required
  without a terminal).
- **D2. Where the approved work goes by default.** A local branch, or a push to `origin` when there is one.
  *Recommendation:* a local branch, always; `--push` pushes (to `origin`, or `--push <remote>`). Nothing leaves the
  machine unless asked, which also removes the surprise of a branch appearing on GitHub.
- **D3. A project with no test command AHP can find.** *Recommendation:* ask for one, with a choice of "none: review
  only", which the summary and the receipt label "not verified: no check command" (the glossary's structural
  verification). Never invent a check.
- **D4. Which steps by default.** plan → implement → review (the reference scenario, condition C3) or implement →
  review (C3min: one agent fewer, cheaper and faster). *Recommendation:* implement → review, with `--plan` adding the
  plan step. The pilot's C3 vs C3min comparison is what should settle the default later; until then the cheaper one.
- **D5. Remembered choices.** *Recommendation:* yes, per user (`<AHP_HOME>/settings.json`), written only when the person
  says yes to "next time?", shown as "(your default)", and never read by `ahp eval` (an evaluation's casting is its
  suite's alone).
- **D6. The approval gate.** *Recommendation:* kept, always. It is where the person sees the diff before anything lands;
  with a local branch it decides whether the branch is made.

## Out of scope

- Changing a step while its run is going (above).
- Workflow files are not removed: they stay the way to keep a workflow that is run again, or in CI. `ahp run <file>`,
  `ahp setup` and `ahp init` are unchanged except where a ticket says.
- No new step kinds, failure classes or handoff fields: a one-command run is an ordinary `WorkflowDefinition`, built in
  memory, run by `runWorkflow`, recorded in the ledger like any other.

## Tickets

1. `01-task-inference.md`: work out the check command, the install command and the casting from the project
2. `02-one-command-run.md`: `ahp "<task>"`, the summary, Run / Change / Cancel, a local branch by default
3. `03-change-a-step.md`: changing a step's tool, model and effort, by menu and by flags, and remembering it
4. `04-run-receipt.md`: what the checks caught, at the end of every run
5. `05-when-to-use-ahp.md`: the README around `ahp "<task>"`, and when not to use AHP
6. `06-mini-pilot.md`: evidence for or against the core claim, at the smallest useful size
7. `07-inside-claude-code.md`: AHP from inside Claude Code (later)
