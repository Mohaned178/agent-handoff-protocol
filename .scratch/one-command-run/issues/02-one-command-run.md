# 02: `ahp "<task>"`

**What to build:** Running a task from one sentence: AHP builds the workflow in memory from ticket 01's answers, shows a
summary, and on Run starts it like `ahp run` would; the approved work goes on a local branch unless `--push`.

**Blocked by:** 01

**Status:** done (2026-10-30)

- [x] `ahp "<task>"`: the first argument, when it is not a command and has more than one word, is a task (spec D1); a
      single unknown word stays "unknown command", so a misspelt command never starts agents
- [x] The summary: task, check (with source), install (with source), each step's tool and model (and effort), and where
      the result goes; then Run / Change something / Cancel. Change something is ticket 03; until then it is not offered
- [x] `--yes` runs without asking; without a terminal it is required (a usage error says so)
- [x] Steps: implement → review by default, `--plan` adds plan first (spec D4); implement is verified by the check
      command (with the install command), review sends implement back, then the approval gate (spec D6)
- [x] The result: `push_branch` to `.` (a local branch) by default; `--push` to `origin`, `--push <remote>` to another,
      refused before any agent starts when the remote is missing (as `ahp run` does today)
- [x] No check command found: the person is asked for one, with "none: review only" as a choice, labelled "not verified"
      in the summary (spec D3); without a terminal and with no check, a usage error unless `--check <command>` is given
- [x] The repository is made ready as `ahp setup` does (`readyRepository`), and uncommitted changes are named before Run:
      "agents work from your last commit; N changed files are not in it" (they never see uncommitted work)
- [x] No file is written: the workflow is the run's, in its ledger, and `ahp runs`/`ahp inspect` work as for any run;
      `--save <file>` writes it as a workflow file for later
- [x] Tests: in-process with a fake terminal and the mock (a `--mock` flag for tests and demos, or the test's own
      adapters), against fixture projects: inferred summary, Run, Cancel, `--yes`, `--push`, the refusals

## Notes

- `ahp setup` and `ahp init` stay for workflow files; `ahp` with no argument keeps opening setup.

## Implementation notes (2026-10-30)

`src/setup/task.ts` (`buildTaskRun`, `formatTaskSummary`, `renderTaskRun`, `mockScripts`/`mockCasting`, `stepsOf`) and
`taskCommand` in `src/cli/main.ts`. Tests: `test/cli-task.test.ts` (in-process, fake terminal, `--mock`; one test runs
the inferred `npm install` and `npm test` for real, about 3 s). Choices made:

1. **No silent mock for a real task.** With no usable tool, `ahp "<task>"` is a usage error that names `ahp doctor`
   and `--mock`; only `--mock` casts the mock, whose generic scripts write `AHP-MOCK.md` (saying it did not do the
   task) and approve it, so the whole flow, gate and branch included, can be seen for free.
2. **`--save` writes only once the person chooses Run** (or `--yes`): Cancel leaves nothing behind. The path is
   relative to the directory given (the current one, or `--repo`), and an existing file is refused before anything runs.
3. **`--push` parsing:** `parseArgs` has no optional values, so a bare `--push` becomes `--push=origin`; the next
   argument is its remote only when it is a remote's name (a task always has a space in it). `--push=<remote>` works too.
4. **The new branch avoids the local branches and, with `--push`, the remote's tracking branches** (a push is never
   forced, so a taken remote branch would fail only at the last step).
5. **`--yes` skips only Run?**: in a terminal, a project with no check is still asked for one (a person is there).
6. Cancel at Run? exits 0 ("cancelled: nothing was started"); Ctrl+C at a question exits 130 with the same line.
7. Without a check (review only) no install is shown or run: verification then has no command to install for.
8. The guide (`ahp` with no terminal) now names `ahp "<task>"` first for a project; the README is ticket 05.

## Comments

- 2026-10-31: the maintainer adopted every choice in the implementation notes ("do recommendation"); they are settled.
- 2026-10-31: first green CI run with this ticket: 41146259771 (Linux 899 passed, 1 skipped; macOS 899 passed, 1
  skipped; Windows 896 passed, 4 skipped).
