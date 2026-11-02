# 07: Runs, tools, settings and clean

**Implement with:** Sonnet 5.5, effort medium

**What to build:** The screens behind `/runs`, `/tools`, `/settings` and `/clean`, and `ahp clean` (spec D7, D10).

**Blocked by:** 02 (05 for the picker it shares)

**Status:** done (2026-11-02)

- [x] `/runs`: every run, newest first, with state, task, age, outcome and the usage per tool in one line; type to
      filter; `enter` opens the run screen
- [x] `/tools`: Node and git against their minimums, each tool in `TOOLS` (version, login yes/no/unknown, adapter,
      declared levels on this OS, the install and log-in command when not ready), read with `diagnose` on a spinner
- [x] `/settings`: each role's default tool, model and effort or "automatic"; `enter` changes one with ticket 05's
      picker; `x` clears one, `X` all (confirmed); a broken entry shown and left out
- [x] Save as workflow: `w` on the summary writes the task's workflow to a file the person names, refused over an
      existing file (replaces `ahp init` and `ahp setup`'s workflow path)
- [x] `/clean` and `ahp clean [--dry-run]`: removes the worktrees of runs that have ended (`git worktree remove`, then
      `prune`), never one of a run waiting for a person; keeps ledgers and `refs/ahp/` snapshots; says what it removed
      and the space freed
- [x] Tests (`test/tui-screens.test.ts`, `test/clean.test.ts`): fake tools installed, logged out and missing; changing
      and clearing a default; save as workflow and its refusal; clean keeps a `needs_recovery` run's worktree and
      removes an ended run's

## Implementation notes (2026-11-02)

1. **The task column is the workflow name.** The ledger records only the workflow's name (a slug of the task), so `/runs` shows that, as home does; the task's own words are not kept anywhere.
2. **`ahp clean` is the core and a formatter, not yet a command.** `cleanRuns({ repo, dryRun })` and `formatClean` (`src/commands/clean.ts`) do everything, with the same words on screen and in the terminal. Ticket 08 lists `ahp clean` among the plain commands it ports and CLAUDE.md says not to extend `src/cli/`, so the parsing, `--dry-run` and exit code are 08's.
3. **"Ended" means `succeeded`, `failed` or `cancelled` only.** Anything else is kept with its reason: waiting for approval, `needs_recovery`, a stopped process, a live or other-host lock, an unreadable ledger. The "waiting for a person" test is one function (`waitingDetail`, `src/commands/runs.ts`) that home and clean both use, moved out of `home-model.ts` so they cannot drift.
4. **Only this repository's runs are touched.** `<AHP_HOME>/worktrees` is shared by every repository, so clean walks `listRuns({ repo })` and looks only at `<root>/<run>/*` for those. Removal is `discardWorktree` per directory, one `git worktree prune`, then the empty run directory. One run failing (a file held open on Windows) is reported and the others go on. Sizes are read with `lstat` before removal and counted as freed only for removals that worked. `worktreeRoot()` is new in `paths.ts` and creates nothing, so a dry run writes nothing.
5. **`/clean` removes nothing until Enter,** and Enter runs the clean again rather than replaying the plan on screen, which may be old.
6. **`x`/`X` do not use `clearSettings`,** which deletes the whole file and would bring the welcome screens and the real-agents notice back. `clearStepDefault` and `clearStepDefaults` rewrite the file without the steps and keep `firstOpenDone` and `realAgentsNoticed`. A broken entry is left out when the file is rewritten, as a save does today.
7. **`/settings` saves at once** (no "keep for next time?"), as the picker's own answer is the default. An unset step reads "automatic", never what AHP would cast today. Home's status line now reads the roles again whenever home comes back on screen, or a change would look like it did nothing.
8. **Usage in `/runs`** names the tool before every number (a cut line never leaves a bare figure), shows "not reported" for a tool that reported nothing (never 0), "n of m attempts" when only some did, and never adds one tool to another.
9. **`/tools` scrolls** instead of clipping: a frame body hides what does not fit without a word, and at 80×20 the levels of three tools do not fit. The levels are grouped by level on one line each ("enforced_by_tool: read_only, ..."). An OpenCode login is "login unknown", never "not logged in". The doctor's two notes are copied into `tools-model.ts` rather than imported from `src/cli/`, which ticket 09 deletes.
10. **Save as workflow** (`w` on a summary that can run) writes `renderWorkflowFile` (`src/commands/workflow-file.ts`) with an exclusive open, so a file that appeared since is never replaced. The name gets `.mjs` when it has no extension and anything else is refused, because `ahp run` imports the file and only `.mjs` is always a module. It is written in the repository's top level. When the mock plays a step the file's header says so. It builds on `buildTaskRun`, the workflow the summary shows, not `buildTaskWorkflow` of `src/doctor/init.ts`, which takes a different shape.
11. **`/runs` filter:** every word must match the name, outcome, age, usage or ID; the order stays newest first. Once something is typed, `?` is a letter and Esc clears the filter before it goes back. A run whose ledger cannot be read shows its problem and is not opened (Enter says so).
12. **Not done here, left to the maintainer:** ticket 06's work was uncommitted in `app.ts`, `home.ts`, `run.ts`, `run-model.ts` and `task-runner.ts` when this ticket was built, so this ticket's edits to `app.ts` and `home.ts` are mixed with it in the working tree.
