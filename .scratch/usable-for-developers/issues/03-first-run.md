# 03: The first ten minutes

**What to build:** Every way a developer's first run can fail ends in one line that names the fix: a command to run or
a flag to pass. And every stop says what to do next.

**Blocked by:** none

**Status:** planned

- [ ] No tool usable: name each tool's install and login commands (`npm i -g @anthropic-ai/claude-code`, `claude`,
      `codex login`, `opencode auth login`), from `TOOLS` in `src/doctor/tools.ts`, never inferred; `ahp doctor` says
      the same per tool
- [ ] No git identity: checked before the first commit `readyRepository` offers, with the two `git config --global`
      commands, instead of a git error after the person said yes (the CI failure of 2026-10-31 was this case)
- [ ] No check command: the question already exists; add the commands AHP looked for, so a developer sees why none
      was found
- [ ] A check that fails before any agent ran (the fixture's own tests are red): said before Run, from one run of the
      check on the base commit, with a choice to run anyway. *Decision for this ticket:* whether that pre-check costs
      too much time on a slow suite; recommendation: offer it, default on, skipped by `--no-precheck`
- [ ] An attempt timed out, a tool's login expired mid-run, a rate limit: the stop line names the cause and the fix
      ("log in again: claude", "raise it: timeout.totalMs") from the attempt's error, not a stack
- [ ] Every stop prints one "next" line: approve/reject at a gate, `ahp recover` after a crash, merge after a local
      branch, `ahp inspect` after a failure
- [ ] The first real run (not `--mock`) on a machine says once, before Run, that agents run commands on this machine
      and their usage counts against the person's plan, then never again (kept in `settings.json`)
- [ ] Windows: a path too long, a locked file (`EBUSY`), PowerShell quoting of a task with quotes: each has a test or
      a documented answer
- [ ] Tests: each failure above in-process with fake tools and a fake terminal

## Notes

- clig.dev: "Catch errors and rewrite them for humans"; the most important line last.
