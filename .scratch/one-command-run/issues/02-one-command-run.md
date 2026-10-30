# 02: `ahp "<task>"`

**What to build:** Running a task from one sentence: AHP builds the workflow in memory from ticket 01's answers, shows a
summary, and on Run starts it like `ahp run` would; the approved work goes on a local branch unless `--push`.

**Blocked by:** 01

**Status:** planned

- [ ] `ahp "<task>"`: the first argument, when it is not a command and has more than one word, is a task (spec D1); a
      single unknown word stays "unknown command", so a misspelt command never starts agents
- [ ] The summary: task, check (with source), install (with source), each step's tool and model (and effort), and where
      the result goes; then Run / Change something / Cancel. Change something is ticket 03; until then it is not offered
- [ ] `--yes` runs without asking; without a terminal it is required (a usage error says so)
- [ ] Steps: implement → review by default, `--plan` adds plan first (spec D4); implement is verified by the check
      command (with the install command), review sends implement back, then the approval gate (spec D6)
- [ ] The result: `push_branch` to `.` (a local branch) by default; `--push` to `origin`, `--push <remote>` to another,
      refused before any agent starts when the remote is missing (as `ahp run` does today)
- [ ] No check command found: the person is asked for one, with "none: review only" as a choice, labelled "not verified"
      in the summary (spec D3); without a terminal and with no check, a usage error unless `--check <command>` is given
- [ ] The repository is made ready as `ahp setup` does (`readyRepository`), and uncommitted changes are named before Run:
      "agents work from your last commit; N changed files are not in it" (they never see uncommitted work)
- [ ] No file is written: the workflow is the run's, in its ledger, and `ahp runs`/`ahp inspect` work as for any run;
      `--save <file>` writes it as a workflow file for later
- [ ] Tests: in-process with a fake terminal and the mock (a `--mock` flag for tests and demos, or the test's own
      adapters), against fixture projects: inferred summary, Run, Cancel, `--yes`, `--push`, the refusals

## Notes

- `ahp setup` and `ahp init` stay for workflow files; `ahp` with no argument keeps opening setup.
