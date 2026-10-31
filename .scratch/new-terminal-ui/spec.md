# Spec: a new terminal app, from zero

**Status:** draft (2026-10-31); decisions D1 to D10 wait for the maintainer ("go" adopts every recommendation); to be
built after `.scratch/inference-evaluation/` (see "Build order")

Asked for by the maintainer on 2026-10-31:

> i want to build new ui terminal for the project also i want to build easy command to use; i want to delete the
> current one and make new one from the zero

and, the same day, after a first draft:

> pick color black and green; i want user to choose the model for implement and plan and review and all; i want him to
> choose effort also i want to see limit and tokens; i want him to see live coding; i want him to do task easy; i want
> him when he open ahp for first time he see it easy to use like claude code and open code and all cli; act as senior
> ui/ux; i want the app become use-able and developer want to choose him to finish their job; clean any garbage from
> the project before you start

Answers given: a **full-screen app**; **just `ahp`** opens it (`ahp "<task>"` stays as a shortcut); delete **only the
terminal layer** (the engine stays and is driven through the SDK); **spec and tickets first**.

Background: `.scratch/cli-ux/research.md`, `.scratch/usable-for-developers/spec.md`.

## Problem

The terminal layer grew one feature at a time (`src/cli/main.ts` 1,095 lines, `format.ts` 784, about 3,700 lines over
14 commands). It prints a scrolling log, needs the next command to be known (`ahp runs`, `ahp inspect`, `ahp approve
<run> <step>`), and shows nothing of what an agent is doing between "started" and "ended". A developer who has used
Claude Code or OpenCode expects to open the tool, type what they want, and watch it work. AHP should feel like that,
and add what those tools lack: several agents, each step checked, nothing landing before you approve the diff.

## Design (the senior UI/UX pass)

### Principles

1. **One input, like Claude Code and OpenCode.** The app opens on a prompt. Type a task, press Enter. Everything else
   is a slash command (`/model`) or a key shown on screen. Nothing needs a run ID or a flag typed in.
2. **Show the work, not the log.** While a step runs you see the code being written (the live diff), the commands it
   runs, its messages, and the tokens and limits as the tool reports them. Events become a timeline, not lines of text.
3. **The next action is always visible.** The footer lists the keys that work right now; a run waiting for you is at
   the top of the screen with the one key that decides it.
4. **Smart defaults, every choice one step away.** AHP works out the check, the install, the tools, the models and the
   branch; the summary shows each answer and where it came from; `Tab` or `/model` changes any of them.
5. **Honest numbers.** Tokens, cost and limits only as each tool reported them, labelled with the tool; "not reported"
   where it said nothing; never summed across tools, never estimated. "Reported done" and "verified" are different words
   on screen, always.
6. **Calm.** Black background, one accent (green). Red and amber appear only for a failure or a wait. Animation is one
   spinner; `AHP_NO_ANIMATION=1` stops it.

### Palette (black and green)

| Token | Truecolor | 256-colour fallback | Used for |
|---|---|---|---|
| `bg` | `#000000` | 16 | the whole screen |
| `surface` | `#0c1a11` | 233 | the input box, the selected row, the sidebar |
| `border` | `#1d3b28` | 236 | frames and separators |
| `accent` | `#22e07a` | 41 | the prompt caret, ✓, the spinner, focused borders, keys in the footer |
| `text` | `#d4f7e0` | 194 | body text (a light green-white: pure green is tiring to read for long) |
| `muted` | `#5e8f72` | 65 | sources, times, hints, "not reported" |
| `added` / `removed` | `#22e07a` / `#ff6b6b` | 41 / 203 | diff lines |
| `warn` | `#f5c451` | 221 | a retry, a wait for you |
| `error` | `#ff5f56` | 203 | a failure, a refusal |

`NO_COLOR`, `TERM=dumb` or no TTY: no colour at all, symbols carry the meaning (✓ ✗ ↻ ! ○). A light terminal theme is
out of scope for the first release; the app paints its own black background.

### First open (under 30 seconds, three screens, each one Enter)

```
                     ▄▀█ █ █ █▀█
                     █▀█ █▀█ █▀▀   agent handoff
     Several coding agents, one task, checked before anything lands.

  Tools on this machine
   ✓ Claude Code  2.1.311   logged in
   ✓ Codex        0.146.0   logged in
   ✗ OpenCode     not installed   npm i -g opencode-ai

                                         enter continue   q quit
```

```
  Who does what?   (you can change this any time with /model)

   plan       Claude Code   opus      effort high
 ❯ implement  Codex         gpt-5.6   effort medium
   review     Claude Code   sonnet    effort default

               ↑↓ pick   enter change   tab next   ctrl+s save and start
```

Then the home screen. Nothing on these screens needs reading to get through them: Enter keeps every default. A tool
not logged in shows the command that logs it in; with no tool at all, the second screen offers "try it on the mock"
(marked as a mock everywhere after).

### Home: the prompt

```
 AHP  my-repo · main                                                 ? help
──────────────────────────────────────────────────────────────────────────
 ! waiting for you   run 7f3a  add password reset   approve the diff  [enter]

 Recent
 ✓ update readme            2h ago   verified · branch ahp/update-readme
 ✗ migrate config           1d ago   implement: npm test failed 3 times

╭──────────────────────────────────────────────────────────────────────────╮
│ ❯ describe a task, e.g. "fix the failing login test"                     │
╰──────────────────────────────────────────────────────────────────────────╯
 plan opus·high  implement gpt-5.6·medium  review sonnet    / commands  tab steps
```

Slash commands (a menu opens on `/`, filtered as you type): `/model` (a step's tool and model), `/effort`, `/plan`
(on or off), `/check` (the check command), `/push` (where the result goes), `/runs`, `/tools`, `/settings`, `/clean`
(old runs' worktrees), `/help`, `/quit`.

### Summary: one look, one key

```
 fix the bug where the cart total ignores quantity

   check      npm test                      package.json
   install    npm ci                        package-lock.json
   implement  Codex · gpt-5.6 · medium      your default
   review     Claude Code · sonnet          your default
   result     branch ahp/fix-the-cart-total, local, after you approve

                enter run   tab change a step   p add a plan step   esc edit
```

### Run: live coding

```
 AHP  run 8d41 · fix the cart total · 1m12s                               │ Usage
──────────────────────────────────────────────────────────────────────────│ Claude Code
 ✓ plan       Claude Code · opus · high       14s   3.1k in · 0.8k out    │  3.1k in · 0.8k out
 ⠋ implement  Codex · gpt-5.6 · medium        58s                         │  limit: allowed (5h)
   │ ● reading src/cart.ts                                                │ Codex
   │ ✎ src/cart.ts  +1 −1                                                 │  tokens at turn end
   │   12 − const total = items.reduce((s, i) => s + i.price, 0)          │
   │   12 + const total = items.reduce((s, i) => s + i.price * i.qty, 0)  │ Limits (AHP)
   │ $ npm test                     ✗ 1 failing                           │  attempt 1m/20m
   │ "The quantity was ignored in the reducer; fixing the test next."     │  idle 3s/10m
 ○ review     Claude Code · sonnet                                        │  retries 0/2
 ○ approve → branch ahp/fix-the-cart-total                                │
──────────────────────────────────────────────────────────────────────────│
 ↑↓ step  enter expand  d full diff  l raw log  ctrl+c cancel
```

- **The live diff** is the agent's worktree read with `git diff` about once a second (read only; every tool, the mock
  included). Files appear as they change; the newest change is expanded, older ones fold to one line.
- **Activity** (what it reads, edits, runs, says) comes from a per-attempt activity log each adapter appends to (D4).
- **The sidebar** (≥ 110 columns; below that, `u` toggles it over the timeline) shows, per tool, the tokens and cost as
  reported so far and the limits each tool reports: Claude Code's plan-limit status and window, OpenCode's context
  window used of its size, "not reported" for what a tool does not say. Then AHP's own limits: the attempt's time and
  idle limits, the retry budget used.
- A retry is one line (`↻ implement  npm test failed, retrying 2/3`); its failing output opens with `enter`.
- The gate: the timeline's last block becomes the diff from the run's base, and the footer becomes
  `a approve   r reject (with a reason)   ↑↓ scroll`.
- The end: a receipt block (checks verified or not, what was sent back, usage per tool with its source, one "next"
  line, e.g. `git merge ahp/fix-the-cart-total`), and the prompt comes back.

### Empty, error and edge states

| Situation | What the screen shows |
|---|---|
| Not a git repository | "This folder isn't a git repository." `enter` git init + first commit, `esc` quit |
| No git identity | the two `git config` commands to run, nothing else asked |
| No usable tool | each tool's install and log-in command; `m` try the mock |
| Project has no check | the summary asks: a command, or "none: review only, not verified" |
| Check fails on HEAD before the run | "npm test already fails on main (3 failing)." `enter` run anyway, `esc` back |
| A tool's login expired mid-run | the step fails with the log-in command on its line |
| Terminal smaller than 80×20 | "Make the terminal at least 80×20, or use `ahp run`." |
| Another process holds the run | "run 7f3a is running in another terminal (PID 4120)"; read only |

## Rules kept from the design (the rebuild may not drop any)

Success is a passing check; usage and limits only as reported, with the source, never summed or estimated; models as
requested and as reported; mock output is never evidence and says so; only AHP pushes, and only after an approval; the
run screen is a view over files the runtime owns (the ledger, the activity log, the worktree), so it opens a run started
anywhere; Ctrl+C cancels through `run_cancel_requested`; a git worktree is not a security boundary.

## Decisions (recommendation first; "go" adopts all)

**D1. Library: Ink 8 + React 19**, tested with `ink-testing-library` 4 (versions checked on npm 2026-10-31). Layout,
focus and input are built in, and frames render to strings in tests.

**D2. No JSX:** views use `h(Box, {...}, ...)` over `React.createElement`, so `node src/cli/bin.ts` still runs from
source with Node's type stripping.

**D3. Layout like OpenCode:** a full-screen timeline, a prompt at the bottom, a sidebar for usage and limits on wide
terminals. This replaces the first draft's two-pane lazygit layout: the maintainer asked for "like claude code and open
code", and a prompt is what those users already know.

**D4. An activity log per attempt.** The tool-call log (`AttemptInput.toolCallLog`, OpenCode only today) becomes an
activity log every adapter appends to: tool calls, the agent's messages (first 300 characters), usage as it arrives,
limit reports. It is a file the runtime owns (`<runs>/<run>/activity/<attempt>.jsonl`), so the screen reads it like the
ledger and it survives a crash. No input or output of a tool call is kept beyond a title and paths (as today). Claude
Code and OpenCode stream usage and limits; Codex writes usage only at the end of its turn, and the screen says so.
`buildRecoveryReport` and `ahp recover` read it as they read the tool-call log now.

**D5. Black background painted by the app**, light themes later. The palette above, with the 256-colour fallback.

**D6. Choosing tools, models and effort:** in the first-open screen, the summary (`Tab`), `/model` and `/effort`
(this run), and `/settings` (the default). The model list is the tool's default first, then what the tool lists
(`opencode models`) or AHP knows (`KNOWN_MODELS`), then any name typed; effort only for tools that have one (Claude
Code, Codex), as `effortsFor` says today.

**D7. A small plain mode stays:** `ahp run`, `approve`, `reject`, `recover`, `runs`, `inspect`, `doctor`, `eval`,
`bench` and `bench report` (added by the inference evaluation, ADR 0007),
`ahp "<task>" --yes`, with `--json` where it exists today. CI, scripts, agents and the crash tests need them. `ahp
setup`, `ahp settings` and `ahp init` go (the app replaces them).

**D8. Kept logic:** the non-UI code in `src/setup/` (`infer.ts`, `settings.ts`, `models.ts`, `buildTaskRun`,
`prepareDemo`, the precheck) and a pure `receiptOf(RunView)` returning data stay; all presentation is deleted.

**D9. Quitting during a run:** `esc` goes home and the run continues in this process; quitting asks "A run is going.
Cancel it and quit?". No background daemon.

**D10. Old runs' worktrees:** AHP never removes an attempt's worktree (27 are on the maintainer's disk). `/clean` and
`ahp clean` remove the worktrees of runs that have ended, never one a run waiting for a person may need (an unknown
attempt's, for adopt); snapshots under `refs/ahp/` and ledgers are kept.

## Out of scope

A bench screen (`ahp bench` stays plain); local engines in `/tools` or in the model picker (an `opencode` step on a
local engine is set in a workflow file, inference-evaluation ticket 03); runs that outlive the app; a web UI; mouse;
light themes; changing a step's tool mid-run; an evaluation screen (`ahp
eval` stays plain); `@file` mentions in the prompt.

## Build order (main stays green)

**After the inference evaluation** (decided 2026-10-31): `.scratch/inference-evaluation/` lands first, on its branch
`inference-evaluation`. Start this feature from a `main` that includes that work, so `ahp bench` is already in the old CLI
when ticket 08 ports the plain commands. What that work changes here:

- **Ticket 01:** keep CLAUDE.md's inference-evaluation scope lines and its module paragraph (`src/inference/`).
- **Ticket 03:** tool-call counts (`trial_ended.toolCalls`) are read from the tool-call log. Renaming it to the activity
  log moves that reader to the `tool_call` entries, and keeps the old `tool-calls/` path readable.
- **Ticket 08:** `ahp bench` and `ahp bench report` join the commands written from zero, with their tests.
- **Ticket 09:** `src/setup/wizard.ts` holds the conditions list, which then includes `C3c` and `C3r`. It is deleted
  with the wizard. `src/cli/format-evaluation.ts` gains the new trial fields (tool calls, handoff bytes), and its
  replacement keeps them.

New code beside the old (`src/tui/`, `src/commands/`); `src/cli/bin.ts` switches in ticket 09, which deletes the old
layer. Until then `node src/tui/dev.ts` starts the new app.

## Tickets and who implements them

Model choice: **Opus 5.5** where a ticket sets an architecture later tickets build on, or crosses the adapters;
**Sonnet 5.5** for screens and ports on a settled base; **Haiku 5.5** for mechanical work with a clear list.

| # | Ticket | Model | Effort | Why this model |
|---|---|---|---|---|
| 00 | Clean the garbage | Haiku 5.5 | low | a list of files, branches and worktrees to remove, checked by the tests passing |
| 01 | A lean CLAUDE.md | Sonnet 5.5 | medium | judgment over what every agent must know vs. history; no code |
| 02 | Design system and app shell | Opus 5.5 | high | the theme, layout, input, router and test harness every screen uses |
| 03 | Activity log from every adapter | Opus 5.5 | high | crosses three adapters, the runtime and recovery; the honesty rules live here |
| 04 | Run screen with live coding | Opus 5.5 | high | live diff, timeline and sidebar over three files at once; performance on Windows |
| 05 | First open and the task flow | Sonnet 5.5 | high | screens over existing logic (`infer`, `castRoles`, `buildTaskRun`) |
| 06 | Decisions in the app | Sonnet 5.5 | medium | SDK calls exist; screens and refusals |
| 07 | Runs, tools, settings, clean | Sonnet 5.5 | medium | list and form screens; `ahp clean` is small |
| 08 | Plain commands and ported tests | Sonnet 5.5 | high | many tests to port without losing what they assert |
| 09 | Switch over, delete the old, docs | Sonnet 5.5 | medium | deletion is mechanical, the docs and CLAUDE.md are not |
| 10 | First-use test and polish | Opus 5.5 | high | the maintainer tries it on real work; fixes cross the app |
