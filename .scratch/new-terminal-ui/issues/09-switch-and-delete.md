# 09: Switch `ahp` over, delete the old layer, docs

**Implement with:** Sonnet 5.5, effort medium

**What to build:** `ahp` opens the new app; the old terminal layer, its tests and its dependency are gone; the docs
describe what is there now.

**Blocked by:** 05, 06, 07, 08

**Status:** todo

- [ ] `src/cli/bin.ts`: no arguments on a terminal opens the app; `ahp "<task>"` opens it on the summary; a plain
      command runs from `src/commands/`; no arguments without a terminal prints the short usage
- [ ] Delete: `src/cli/main.ts`, `format.ts`, `format-doctor.ts`, `format-evaluation.ts`, `live.ts`, `progress.ts`,
      `diff.ts`, `args.ts`, the old receipt text, `src/setup/wizard.ts`, `prompter.ts`, `src/tui/dev.ts`;
      `@inquirer/prompts` removed
- [ ] Delete the old presentation tests: `cli-live`, `cli-guidance`, `cli-start`, `cli-task`, `cli-task-change`,
      `cli-first-run`, `cli-runs`, `setup`, the text checks in `receipt`; `infer`, settings and `receiptOf` keep theirs
- [ ] `ahp setup`, `ahp settings`, `ahp init` answer "moved into the app: run `ahp`" for this release
- [ ] `npm run typecheck`, `npm test`, `test/package.test.ts` pass; nothing imports a deleted file
- [ ] `format-evaluation.ts`'s replacement in `src/commands/` keeps the inference evaluation's trial fields (tool calls,
      handoff bytes) and conditions (`C3c`, `C3r`); the bench report's text stays where ticket 08 put it
- [ ] Docs: README (getting started is `ahp` and a screenshot-like block of the home screen), `docs/how-it-works.md`
      (screens, keys, slash commands, what the sidebar's numbers mean), `docs/troubleshooting.md`, `CHANGELOG.md`
      (breaking: the removed commands), `CLAUDE.md` (`src/tui`, `src/commands`, the activity log)
