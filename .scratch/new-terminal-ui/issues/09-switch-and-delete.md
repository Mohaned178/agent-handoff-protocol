# 09: Switch `ahp` over, delete the old layer, docs

**Implement with:** Sonnet 5.5, effort medium

**What to build:** `ahp` opens the new app; the old terminal layer, its tests and its dependency are gone; the docs
describe what is there now.

**Blocked by:** 05, 06, 07, 08

**Status:** done (2026-11-02)

- [x] `src/cli/bin.ts`: no arguments on a terminal opens the app; `ahp "<task>"` opens it on the summary; a plain
      command runs from `src/commands/`; no arguments without a terminal prints the short usage
- [x] Delete: `src/cli/main.ts`, `format.ts`, `format-doctor.ts`, `format-evaluation.ts`, `live.ts`, `progress.ts`,
      `diff.ts`, `args.ts`, the old receipt text, `src/setup/wizard.ts`, `prompter.ts`, `src/tui/dev.ts`;
      `@inquirer/prompts` removed
- [x] Delete the old presentation tests: `cli-live`, `cli-guidance`, `cli-start`, `cli-task`, `cli-task-change`,
      `cli-first-run`, `cli-runs`, `setup`, the text checks in `receipt`; `infer`, settings and `receiptOf` keep theirs
- [x] `ahp setup`, `ahp settings`, `ahp init` answer "moved into the app: run `ahp`" for this release
- [x] `npm run typecheck`, `npm test`, `test/package.test.ts` pass; nothing imports a deleted file
- [x] `format-evaluation.ts`'s replacement in `src/commands/` keeps the inference evaluation's trial fields (tool calls,
      handoff bytes) and conditions (`C3c`, `C3r`); the bench report's text stays where ticket 08 put it
- [x] Docs: README (getting started is `ahp` and a screenshot-like block of the home screen), `docs/how-it-works.md`
      (screens, keys, slash commands, what the sidebar's numbers mean), `docs/troubleshooting.md`, `CHANGELOG.md`
      (breaking: the removed commands), `CLAUDE.md` (`src/tui`, `src/commands`, the activity log)

## Implementation notes (2026-11-02)

1. **`src/cli/bin.ts` is the only file left of `src/cli/`.** It opens the app (`src/tui/open.ts`, imported dynamically so plain commands never load Ink and React) only when stdout and stdin are terminals and `CI` is unset, and then only for no arguments or a bare `ahp "<task>"`. A task with any flag (`--yes`, `--mock`, `--check`, ...) is the scripted form and stays a plain command, which also keeps `--repo` working as before. Everything else, with no terminal, is `main()`; `ahp --help` on a terminal still prints the usage.
2. **`ahp "<task>"` on a terminal** passes `startTask` to `App`: if first open is done and the repository is ready it opens on that task's summary; otherwise the first-open or readiness screens come first and the task is put back in the prompt, so it is never lost or run unasked.
3. **`src/commands/bin.ts` was removed** (it existed only until this switch); the test helpers `ahp()` and `plain()` now run the same entry, which without a TTY is the plain commands.
4. **`slugOf` moved to `src/setup/slug.ts`** because `infer.ts` and `task.ts` imported it from the deleted wizard; the wizard's other exports (`castRole`, `pathsIn`, `tasksUnder`, `writeNew`, `runSetup`) had no other users.
5. **Deleted with the layer:** the tests `cli-live`, `cli-guidance`, `cli-start`, `cli-task`, `cli-task-change`, `cli-first-run`, `cli-runs`, `setup`; `src/cli/format-bench.ts` too (the bench text lives in `src/commands/bench-text.ts` and `inference`). `receipt`, `run-model`, `tui-run` and `doctor` tests now import the text from `src/commands/`. The "receipt in the CLI" test now asserts the brief receipt at a run's end and the full one at the top of `ahp inspect` (`ahp run` prints the brief one since ticket 08). The three `ahp init` command tests became `initWorkflow` tests; the end-to-end one (generate, run on the mock, approve, push) is unchanged otherwise.
6. **Docs:** README (getting started opens `ahp`, with the real home frame; the commands table), `docs/how-it-works.md` (a new "The app" section: screens, keys, slash commands, the sidebar's numbers; the `--verbose` and `--diff` passages, which no longer exist, rewritten), `CHANGELOG.md` (breaking note), `CLAUDE.md`. `docs/troubleshooting.md` already had the "moved into the app" entry from ticket 08.
7. **`docs/how-it-works.md` was not given a screenshot.** The README block is the frame the test renderer draws at 100 columns with the project name changed.
