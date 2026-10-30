# Research: terminal output of tools like AHP (2026-10-31)

Asked by the maintainer ("the ui of cli is so bad"; "research for cli for apps like this first"), before any redesign.
The four sources below were read on 2026-10-31; nothing here was measured on AHP's users.

## What the guides and comparable tools do

**clig.dev (Command Line Interface Guidelines)**, the most cited guide:
- "Display output on success, but keep it brief." Default output minimal; developer-only detail behind `--verbose`.
- "Use color with intention", "Don't overuse it"; symbols "where it makes things clearer", not so many that it feels
  like a toy. No colour or animation when stdout is not a terminal, `NO_COLOR` is set or `TERM=dumb`.
- Print something within 100 ms; show progress for anything slow; on failure show the logs that were hidden.
- "If you change state, tell the user"; "Suggest commands the user should run" next.
- Errors rewritten for humans, the most important line **last**, red used sparingly.
- Prompts only on a TTY, every prompt also a flag, `--no-input` honoured, Ctrl+C always works.

**Nx and Turborepo (task runners: the closest shape to AHP's steps).** Locally a live view per task; in CI successful
tasks folded and failed ones expanded. Nx's `summary` style prints only counts and one line per failing task, naming
the file that holds its full output, and is Nx's default when an AI agent drives it.

**@clack/prompts (Astro, Svelte's `create` tools).** A session framed by `intro` and `outro`; one spinner per long step
that is replaced by a one-line result; `tasks` for sequential steps (✓ on success, a red ✗ on failure); `note` for a
short "next steps" box; `taskLog` streams a subprocess's lines while it runs, then collapses to its result.

**Progress (Evil Martians' CLI UX article).** A spinner with a status line for work of unknown length; no progress
bars for single steps; clear spinners once a step ends. Seirdy's post adds that animated spinners are hard for screen
readers: offer a way to turn animation off.

**Claude Code itself** (issues and cheat sheets, not official docs): tool output collapsed to one line, expanded on
demand (Ctrl+O); users keep asking for *more* collapsing by default.

## What this says about AHP today (the maintainer's four complaints)

| Part | What the guides say | What AHP does now |
|---|---|---|
| Too much text | brief on success; detail behind `--verbose` | long sentences in every block: the receipt heading's "(from the run's ledger: an agent's report is a claim, a check decides)", the usage heading's "(per adapter, not summed across adapters; nothing is estimated)", the mock note, file paths |
| Task summary | short labels, the one decision last | six rows plus parenthetical sources; fine in shape, wordy in content |
| Live run view | one line per step, spinner replaced by a result, failures expanded | already this shape (`live.ts`), but retry and send-back lines carry full evidence inline, and the end repeats it |
| Receipt | an `outro`-style summary: counts, then what failed, then next steps | a heading sentence, one line per fact, usage as a paragraph; the honesty rules are repeated in every block rather than stated once in the docs |

The honesty rules (a report is a claim; usage is never estimated or summed) must stay true, but they need not be
printed in full on every run: a short label ("reported", "as each tool reported it") plus the docs can carry them.

## Sources

- https://clig.dev/
- https://www.npmjs.com/package/@clack/prompts and https://unpkg.com/@clack/prompts@1.7.0/README.md
- https://nx.dev/docs/reference/nx-commands.md and https://turborepo.dev/blog/turbo-1-13-0
- https://evilmartians.com/chronicles/cli-ux-best-practices-3-patterns-for-improving-progress-displays
- https://github.com/anthropics/claude-code/issues/17092
