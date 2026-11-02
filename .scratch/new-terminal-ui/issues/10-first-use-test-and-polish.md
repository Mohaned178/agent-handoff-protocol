# 10: First-use test and polish

**Implement with:** Opus 5.5, effort high (the test itself is the maintainer's)

**What to build:** The check that the app is one a developer would choose: the maintainer uses it on real work, and
what gets in the way is fixed.

**Blocked by:** 09

**Status:** todo

- [ ] The maintainer, on Windows Terminal, with real tools logged in: first open from a fresh `AHP_HOME`; three real
      tasks in a real project (one that passes, one where the check fails at first, one rejected at the gate); one run
      on Linux (WSL2)
- [ ] Measured and written in Comments: seconds from `ahp` to the first task running; keys pressed; every moment of "what
      do I do now?"; every number on screen the maintainer could not explain
- [ ] Targets: first task running within 60 seconds of a first open; no run ID or flag typed; every screen's next action
      in its footer
- [ ] Fixes for what was found, each with a test; the screens' text checked against `docs/how-it-works.md`
- [ ] Also on Windows: conhost (the old console) degrades to 256 colours without broken frames; a resize mid-run redraws

## Checklist for the maintainer (prepared 2026-11-02)

Fill each `…` in Comments below as you go; one line per thing that got in the way is enough. Then hand the Comments
back, and each finding gets a fix with its test.

**Setup (Windows Terminal, PowerShell).**

1. In the checkout on `new-terminal-ui`: `npm run build; npm link` (so `ahp` is this branch).
2. A fresh home: `$env:AHP_HOME = "$env:TEMP\ahp-first-use"; Remove-Item -Recurse -Force $env:AHP_HOME -ErrorAction Ignore`.
3. `claude`, `codex`, `opencode` logged in (check in a different window; don't open `ahp` yet).
4. A real project with a test command, committed and clean. Start a stopwatch as you press Enter on `ahp`.

**A. First open** (target: first task running ≤ 60 s, Enter keeps every default, no run ID or flag typed)

- [ ] Welcome lists the three tools with versions and "logged in". Anything shown you could not explain?
- [ ] "Who does what?": Enter keeps the defaults. Is every model/effort shown one you recognise?
- [ ] Home: type task 1, Enter → summary. Is each answer's source (package.json, your default…) right?
- [ ] Enter → the run starts. **Stop the stopwatch at the first activity line.** Count keys pressed since `ahp`.

**B. Task 1: one that passes**

- [ ] Live diff appears within ~1 s of the agent's first edit; newest file expanded, older ones folded.
- [ ] Sidebar (≥ 110 columns): each tool's tokens labelled with the tool; "not reported" where it said nothing; never 0,
      never a total across tools. Narrow the window below 110: `u` toggles it.
- [ ] Gate: footer says `a approve  r reject`; the diff is the one you expect. `a`.
- [ ] Receipt: "verified" (not "done"), usage per tool with its source, one `next:` line you could run as is.

**C. Task 2: the check fails at first** (pick a task the agent is likely to get wrong once, or break a test first)

- [ ] The retry is one `↻` line; `enter` on it shows the failing output. Is it clear what failed and why it retries?
- [ ] Retries count in the sidebar (`retries 1/2`) matches the timeline.

**D. Task 3: rejected at the gate**

- [ ] `r`, type a reason, Enter. The step before the gate goes back with it; the next attempt starts on its own.
- [ ] Then approve or let it end; the receipt says "sent back once".

**E. Around the runs**

- [ ] `esc` from a live run → home shows it running; Enter reopens it. Ctrl+C on the run asks "Cancel the run? y/n"
      (try `n`).
- [ ] `/runs`, `/tools`, `/settings`, `/clean`: does each footer tell you the next key?
- [ ] Resize the window mid-run (wider, narrower, below 80×20 and back): it redraws, no torn frame.

**F. conhost** (Win+R → `conhost.exe`, then in it: `$env:AHP_HOME=…; ahp`)

- [ ] 256 colours (no `WT_SESSION`): black and green still, frames not broken, ✓ ✗ ↻ ! ○ readable.
- [ ] `$env:NO_COLOR=1; ahp`: no colour at all, the symbols carry the meaning.

**G. Linux (WSL2)**: one run of task 1 from the WSL shell with its own `AHP_HOME`; note anything that differs.

## Comments

- Seconds from `ahp` to the first task running: …
- Keys pressed until then: …
- Moments of "what do I do now?" (screen, what you wanted, what you tried): …
- Numbers on screen you could not explain (screen, number, label): …
- conhost: …
- Resize: …
- WSL2: …
- Anything else: …

## Done before the test (2026-11-02)

- The app's keys checked against `docs/how-it-works.md` "The app": the summary's `tab` and `p` were missing there, and
  home's `tab` reads "the next run that waits" only when several wait (one waiting run opens with Enter). Both fixed in
  the doc; the screens were right.
