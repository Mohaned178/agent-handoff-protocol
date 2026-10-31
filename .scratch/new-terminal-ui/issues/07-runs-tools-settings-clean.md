# 07: Runs, tools, settings and clean

**Implement with:** Sonnet 5.5, effort medium

**What to build:** The screens behind `/runs`, `/tools`, `/settings` and `/clean`, and `ahp clean` (spec D7, D10).

**Blocked by:** 02 (05 for the picker it shares)

**Status:** todo

- [ ] `/runs`: every run, newest first, with state, task, age, outcome and the usage per tool in one line; type to
      filter; `enter` opens the run screen
- [ ] `/tools`: Node and git against their minimums, each tool in `TOOLS` (version, login yes/no/unknown, adapter,
      declared levels on this OS, the install and log-in command when not ready), read with `diagnose` on a spinner
- [ ] `/settings`: each role's default tool, model and effort or "automatic"; `enter` changes one with ticket 05's
      picker; `x` clears one, `X` all (confirmed); a broken entry shown and left out
- [ ] Save as workflow: `w` on the summary writes the task's workflow to a file the person names, refused over an
      existing file (replaces `ahp init` and `ahp setup`'s workflow path)
- [ ] `/clean` and `ahp clean [--dry-run]`: removes the worktrees of runs that have ended (`git worktree remove`, then
      `prune`), never one of a run waiting for a person; keeps ledgers and `refs/ahp/` snapshots; says what it removed
      and the space freed
- [ ] Tests (`test/tui-screens.test.ts`, `test/clean.test.ts`): fake tools installed, logged out and missing; changing
      and clearing a default; save as workflow and its refusal; clean keeps a `needs_recovery` run's worktree and
      removes an ended run's
