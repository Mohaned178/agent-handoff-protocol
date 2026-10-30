# 03: Changing a step's tool, model and effort

**What to build:** A way to change who does a step before a one-command run starts, from the summary's menu or with
flags, and to keep a change as the default for next time.

**Blocked by:** 02

**Status:** done (2026-10-31)

- [x] Change something (the summary's menu): pick a step, then its tool, model and effort with the menus `ahp setup` has
      (`castRole` and the model list in `src/setup`); the summary is shown again with the change; Run starts it
- [x] Flags: `--<step> <tool>`, `--<step>-model <name>`, `--<step>-effort <level>` for `plan`, `implement` and `review`
      (for example `--review claude-code --review-model opus`); a tool that is not usable, or an effort its tool does not
      have, is a usage error before anything runs
- [x] Next time: after a change in the menu, "Use <tool> (<model>) for <step> next time? (y/N)"; yes writes
      `<AHP_HOME>/settings.json` (`{ steps: { review: { tool, model?, effort? } } }`), read by ticket 01's casting and
      shown as "(your default)"; a saved tool no longer usable falls back to the casting, and the summary says so
- [x] `ahp settings` prints the saved defaults and the file's path; `ahp settings --clear` removes them
- [x] Never read by `ahp eval` (spec D5) or by `ahp run <file>` (a file says its own casting)
- [x] Tests: the menu path with a scripted person, every flag, a saved default used and one that fell back, `--clear`

## Notes

- Changing a step during a run is out of scope (spec): a handoff names its recipient when it is issued.
- The settings file holds names only (tool, model, effort), never a credential.

## Implementation notes (2026-10-31)

`src/setup/settings.ts` (`readSettings`, `saveStepDefault`, `clearSettings`, `formatSettings`), `settingsPath()` in
`src/runtime/paths.ts`, and in `src/cli/main.ts` the step flags (`stepFlagsOf`, `checkStepFlags`, `withStepFlags`), the
menu (`changeStep`, which calls `ahp setup`'s `castRole`) and `ahp settings`. Tests: `test/cli-task-change.test.ts`
(fake `claude` and `codex` answering only doctor's commands; every test stops at the summary). Choices made:

1. **`--plan` is both the switch and the tool:** `--plan` alone adds the plan step, `--plan <tool>` casts it too, and any
   `--plan-model`/`--plan-effort` also adds it (naming the plan's model means wanting a plan). What follows `--plan` is
   its tool only when it has no space and is not an option, as for `--push`; a misspelt tool is then a usage error.
2. **A flag changes only what it names:** `--review <tool>` drops the model and effort the casting (or a saved default)
   had for the old tool; `--review-model` alone keeps the cast tool. Flags are never saved (spec D5: only "next time?").
3. **`--mock` with a step flag is a usage error** (it casts every step); in the menu, a step of a `--mock` run may be
   changed to a real tool, doctor then being run.
4. **A settings file that is broken in part** leaves out the entries it gets wrong (unknown step, tool, empty model, an
   effort the tool lacks) and uses the rest; the summary's first line says what was left out. A file that does not parse
   is not used at all. `saveStepDefault` writes the whole file to a temporary name and renames it into place.
5. **The settings file uses `tool`**, as this ticket's format says, so ticket 01's `RoleDefault.adapter` became `tool`.
6. "Next time?" is asked after each change in the menu, default no; a kept change shows "(your default)" at once.
7. Only `taskCommand` reads the settings file, so `ahp run`, `ahp eval`, `ahp init` and `ahp setup` never do; there is
   no test that something does not read it beyond that.
