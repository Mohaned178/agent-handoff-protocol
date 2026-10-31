# 02: Design system and app shell

**Implement with:** Opus 5.5, effort high

**What to build:** The base every screen stands on: the black-and-green theme, the frame, the prompt input with the
slash-command menu, the screen router, the footer of keys, and a test harness. The home screen shows recent runs, read
only. No agent runs yet.

**Blocked by:** 01, spec D1, D2, D3, D5

**Status:** todo

- [ ] Dependencies pinned exactly: `ink` 8, `react` 19, `@types/react`; dev `ink-testing-library` 4;
      `npm audit --omit=dev` clean; `test/package.test.ts` updated for the tarball
- [ ] First, a five-minute check that `ink-testing-library` 4.0.0 (published 2024, peer `@types/react >=18`) renders
      an Ink 8 component. If it does not, the harness writes frames through Ink's own `render` to a fake stdout instead,
      noted in the ticket
- [ ] `src/tui/h.ts` (the `h` helper, spec D2); `node src/tui/dev.ts` starts the app from source
- [ ] `src/tui/theme.ts`: the spec's palette tokens, truecolor with the 256-colour fallback (from `COLORTERM`), none
      under `NO_COLOR`/`TERM=dumb`/no TTY; components take tokens, never raw colours
- [ ] Components: `Frame` (title line, body, footer, black background painted to every cell), `Prompt` (a bordered
      input: editing, history with ↑↓ when empty, paste of several lines, Enter submits, `\` + Enter for a new line),
      `CommandMenu` (opens on `/`, filtered as you type, Enter runs, Esc closes), `Footer` (the keys of the current
      screen, from one table per screen so they can never drift from what works), `Spinner` (off with
      `AHP_NO_ANIMATION=1`), `Picker` (a list with ↑↓, Enter, type to filter)
- [ ] Router: a small state machine over screens (`welcome`, `home`, `summary`, `run`, `runs`, `tools`, `settings`,
      `help`); `esc` back, `?` help, `ctrl+c` handled by the screen (never Ink's default exit)
- [ ] Alternate screen on entry, restored on every exit path (normal, thrown error, signal); the cursor shown again
- [ ] Home (spec "Home: the prompt"): repo and branch, "waiting for you" and "Recent" from `listRuns` (a run that cannot
      be read is listed with its problem), the prompt (Enter says "running tasks comes in ticket 05" for now), the
      status line of the default step roles from `castRoles`
- [ ] Size: panes and the sidebar fold below 110 columns; refuses below 80×20 with the spec's message; every line cut
      to the width with "…"
- [ ] Test harness `test/helpers/tui.ts`: render a screen, type, press keys, read the last frame as text without colour
      codes, and assert on colours by token where it matters
- [ ] Tests (`test/tui-shell.test.ts`): the home screen over ledgers made by the mock, the command menu filters and
      runs `/help`, history, the footer matches the keys that work, narrow and tiny terminals, no escape codes under
      `NO_COLOR`, the alternate screen restored after a thrown error
