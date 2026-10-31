# 03: The first ten minutes

**What to build:** Every way a developer's first run can fail ends in one line that names the fix: a command to run or
a flag to pass. And every stop says what to do next.

**Blocked by:** none

**Status:** done (2026-10-31), one item moved to ticket 06

- [x] No tool usable: name each tool's install and login commands (`npm i -g @anthropic-ai/claude-code`, `claude`,
      `codex login`, `opencode auth login`), from `TOOLS` in `src/doctor/tools.ts`, never inferred; `ahp doctor` says
      the same per tool
- [x] No git identity: checked before the first commit `readyRepository` offers, with the two `git config --global`
      commands, instead of a git error after the person said yes (the CI failure of 2026-10-31 was this case)
- [x] No check command: the question already exists; add the commands AHP looked for, so a developer sees why none
      was found
- [x] A check that fails before any agent ran (the fixture's own tests are red): said before Run, from one run of the
      check on the base commit, with a choice to run anyway. *Decision for this ticket:* whether that pre-check costs
      too much time on a slow suite; recommendation: offer it, default on, skipped by `--no-precheck`
- [x] An attempt timed out, a tool's login expired mid-run, a rate limit: the stop line names the cause and the fix
      ("log in again: claude", "raise it: timeout.totalMs") from the attempt's error, not a stack
- [x] Every stop prints one "next" line: approve/reject at a gate, `ahp recover` after a crash, merge after a local
      branch, `ahp inspect` after a failure
- [x] The first real run (not `--mock`) on a machine says once, before Run, that agents run commands on this machine
      and their usage counts against the person's plan, then never again (kept in `settings.json`)
- [ ] (moved to ticket 06, troubleshooting) Windows: a path too long, a locked file (`EBUSY`), PowerShell quoting of a task with quotes: each has a test or
      a documented answer
- [x] Tests: each failure above in-process with fake tools and a fake terminal

## Notes

- clig.dev: "Catch errors and rewrite them for humans"; the most important line last.

## Implementation notes (2026-10-31)

- `TOOLS` (`src/doctor/tools.ts`) has each tool's `install` and `logIn` command (printed, never run). The no-tool
  refusal of `ahp "<task>"` lists all three; `ahp doctor` adds "to install:" for a missing tool and "to log in:" for
  one known to be logged out; a `config_auth` failure line adds "to log in: …" for its tool (`failureLineOf`).
- `readyRepository` checks `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` before it offers `git init` or a first
  commit, and refuses with the two `git config --global` commands, so nothing is asked or changed first. It also
  covers `ahp setup` and `ahp` alone, which share it.
- **The pre-check** (`src/cli/precheck.ts`, decision of this ticket, recommendation taken: on by default, skipped by
  `--no-precheck`): after Run, the check (after the install) runs once on HEAD in a worktree of its own. A pass says
  nothing; a failure prints "! the check already fails on your last commit: <first failing line>" and asks "Run it
  anyway?" (default yes; `--yes` says it and goes on), since a failing check is often the task itself. The first
  failing line now prefers a missing command ("… is not recognized as …", "command not found"), which is what the
  pre-check is mostly for: a check that cannot run would spend every attempt.
- **The first real run** (not `--mock`) prints once "first run with real agents: they run commands on this machine,
  and their usage counts against your own plans" and records `realAgentsNoticed` in `settings.json` (kept when a step
  default is saved; `ahp settings --clear` removes it with the defaults, so it is said again after that).
- Not separately done: a timed-out attempt's message already names its limit and setting (`overrunMessage`); a rate
  limit is the tool's message, retried as `transient`. The "next:" line at every stop came with ticket 02.
- Moved to ticket 06: the Windows answers (long paths, `EBUSY`, PowerShell quoting of a task) as troubleshooting
  entries; nothing here changed how AHP handles them.
- Tests: `test/cli-first-run.test.ts` (fake tools, empty `GIT_CONFIG_GLOBAL`, failing and missing checks).
