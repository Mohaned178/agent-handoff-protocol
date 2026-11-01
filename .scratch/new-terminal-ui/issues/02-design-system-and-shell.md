# 02: Design system and app shell

**Implement with:** Opus 5.5, effort high

**What to build:** The base every screen stands on: the black-and-green theme, the frame, the prompt input with the
slash-command menu, the screen router, the footer of keys, and a test harness. The home screen shows recent runs, read
only. No agent runs yet.

**Blocked by:** 01, spec D1, D2, D3, D5

**Status:** done (2026-11-02)

- [x] Dependencies pinned exactly: `ink` 8, `react` 19, `@types/react`; dev `ink-testing-library` 4;
      `npm audit --omit=dev` clean; `test/package.test.ts` updated for the tarball (`ink-testing-library` was
      installed for the check below, then removed: see note 1)
- [x] First, a five-minute check that `ink-testing-library` 4.0.0 (published 2024, peer `@types/react >=18`) renders
      an Ink 8 component. If it does not, the harness writes frames through Ink's own `render` to a fake stdout instead,
      noted in the ticket
- [x] `src/tui/h.ts` (the `h` helper, spec D2); `node src/tui/dev.ts` starts the app from source
- [x] `src/tui/theme.ts`: the spec's palette tokens, truecolor with the 256-colour fallback (from `COLORTERM`), none
      under `NO_COLOR`/`TERM=dumb`/no TTY; components take tokens, never raw colours
- [x] Components: `Frame` (title line, body, footer, black background painted to every cell), `Prompt` (a bordered
      input: editing, history with ↑↓ when empty, paste of several lines, Enter submits, `\` + Enter for a new line),
      `CommandMenu` (opens on `/`, filtered as you type, Enter runs, Esc closes), `Footer` (the keys of the current
      screen, from one table per screen so they can never drift from what works), `Spinner` (off with
      `AHP_NO_ANIMATION=1`), `Picker` (a list with ↑↓, Enter, type to filter)
- [x] Router: a small state machine over screens (`welcome`, `home`, `summary`, `run`, `runs`, `tools`, `settings`,
      `help`); `esc` back, `?` help, `ctrl+c` handled by the screen (never Ink's default exit)
- [x] Alternate screen on entry, restored on every exit path (normal, thrown error, signal); the cursor shown again
- [x] Home (spec "Home: the prompt"): repo and branch, "waiting for you" and "Recent" from `listRuns` (a run that cannot
      be read is listed with its problem), the prompt (Enter says "running tasks comes in ticket 05" for now), the
      status line of the default step roles from `castRoles`
- [x] Size: panes and the sidebar fold below 110 columns; refuses below 80×20 with the spec's message; every line cut
      to the width with "…"
- [x] Test harness `test/helpers/tui.ts`: render a screen, type, press keys, read the last frame as text without colour
      codes, and assert on colours by token where it matters
- [x] Tests (`test/tui-shell.test.ts`): the home screen over ledgers made by the mock, the command menu filters and
      runs `/help`, history, the footer matches the keys that work, narrow and tiny terminals, no escape codes under
      `NO_COLOR`, the alternate screen restored after a thrown error

## Implementation notes (2026-11-02)

Implemented by Opus 5.5, as planned. Before this ticket the maintainer said "go" (D1 to D10 adopted, recorded in the
spec's `Status:`), and local `main` was fast-forwarded to `inference-evaluation` (its tickets 01 to 06; 00's spike and
07 stay open).

1. **Harness on Ink's own `render`.** The check passed: `ink-testing-library` 4.0.0 renders an Ink 8 component and
   delivers input. But its stdout is fixed at 100 columns and has no rows, and this app's layout depends on both (the
   80×20 refusal, the fold at 110). So `test/helpers/tui.ts` does what the library does (Ink's `render` with
   `debug: true` to a fake stdout and stdin) with a size the test chooses and a `resize`. With nothing using it,
   `ink-testing-library` was removed again rather than kept as a dependency nobody imports.
2. **Colours read back as tokens.** Chalk writes no colour under Vitest (stdout is not a TTY), so the harness sets
   `chalk.level = 3` (Ink's own chalk, hoisted). Then whether colour is written is the theme's decision alone, and
   `colorAt(raw, text)` maps the codes back to palette tokens (several share a colour, e.g. `accent` and `added`).
3. **Colour mode.** `NO_COLOR` counts only when non-empty (no-color.org). Besides `COLORTERM=truecolor|24bit`,
   Windows Terminal (`WT_SESSION` set) counts as truecolor: the maintainer's terminal draws 24-bit colour whether or not
   it sets `COLORTERM`. With no colour, bold is off too and the cursor is a thin bar (`▏`) instead of reverse video,
   so not one escape code is written (tested over every write).
4. **Black on every cell.** The canvas paints `bg` over `columns × rows`; Ink does not paint a border's cells, so the
   prompt's border sets `borderBackgroundColor` too. The selected row of a menu or picker is `surface`, as the palette
   says.
5. **The alternate screen is AHP's, not Ink's `alternateScreen` option.** `runFullScreen` (`src/tui/terminal.ts`)
   writes enter and restore itself, restores on a normal exit, a thrown error (printed to stderr after the restore, exit
   code 1), a signal (SIGINT, SIGTERM, SIGHUP, and SIGBREAK on Windows: exit 128 + the signal's number) and process
   `exit`; signals and `exit` are injectable so tests drive them. Ink's option is skipped when Ink thinks it is not
   interactive, which would have left those paths untested.
6. **`patchConsole: false`.** Ink's console patching fails under Vitest (`console.Console is not a constructor`), and
   nothing in the app writes to the console (agents run as child processes and their output goes to files).
7. **One key table per screen** (`src/tui/keys.ts`): bindings carry `when` (applies now) and `footer` (shown), the
   input handler dispatches through the table and the footer prints it, so the footer shows the keys that work in the
   current state (on home: `/ commands ? help ctrl+c quit` when empty, `enter run task esc clear ctrl+c clear` with text,
   `enter run command ↑↓ move esc close` in the menu). Typing goes to the prompt when no binding matches. The help
   screen lists home's keys by calling `homeKeys` itself over three states, so it cannot drift either.
8. **Keys decided here.** `?` and `/` act only while the prompt is empty (otherwise they are typed). `ctrl+c` on home
   clears the text, and quits when there is none; on other screens it quits (ticket 04 makes it cancel on the run
   screen, through the run's `signal`). `esc` on home closes the menu or clears the text, and does nothing when the
   prompt is empty (home is the bottom of the stack). Opening a screen already in the stack brings it forward.
9. **Home stays mounted** under the other screens (`display: none`, input off), so the prompt's text and history
   survive a visit to help or a terminal too small for a moment. History lives for the session only.
10. **Slash commands not built yet** say which ticket builds them (`/model comes in ticket 05.`); `/runs`, `/tools` and
    `/settings` open their screens, which say "This screen comes in ticket 07." An unknown command is one `error` line.
    The menu shows as many commands as fit (`rows − 14`, at least 3).
11. **What home lists.** "Waiting for you": runs in `waiting_approval` or `needs_recovery`, and a run whose process
    stopped partway (pending or running with no live lock). No key decides them yet (ticket 06), so the rows show no
    `[enter]`. Recent: the other runs, newest first, eight of them, then "N older runs: /runs lists them". A run is
    "verified" only when every agent step with a check succeeded, otherwise "not verified" or "not verified: no
    check"; a mock run ends with "· mock"; an unreadable ledger shows its problem. The title is the workflow's name as
    the ledger holds it (a task run's slug), never rewritten.
12. **Runs are read when home comes on screen**, not polled: following ledgers as they grow is ticket 04's.
13. **The status line** is `rolesLine(castRoles(diagnose(), saved defaults))`: each step's model and effort if
    requested, else its tool's name, or `mock`. While `diagnose` runs it says "checking the tools on this machine…".
14. **`node src/tui/dev.ts`** opens only when stdout and stdin are TTYs and `CI` is unset (the old compact view's rule,
    plus stdin for the keys); otherwise it says so and exits 2.
15. **Spinner** frames are the old live view's braille set at 80 ms; under `AHP_NO_ANIMATION=1` it is a still `•`.
16. **`Picker`** is built and tested on its own; ticket 05 is the first screen to use it. It exports `pickerKeys` so a
    screen holding one can put its keys in the footer.
17. **`@types/react` is a runtime dependency**, as this ticket lists it: Ink 8 declares it as an (optional) peer.
