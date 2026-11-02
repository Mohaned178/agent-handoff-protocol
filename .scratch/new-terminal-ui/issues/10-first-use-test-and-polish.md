# 10: First-use test and polish

**Implement with:** Opus 5.5, effort high (the test itself is the maintainer's)

**What to build:** The check that the app is one a developer would choose: the maintainer uses it on real work, and
what gets in the way is fixed.

**Blocked by:** 09

**Status:** in progress (2026-11-02): Windows run and fixes done by Claude with the maintainer's leave; the WSL2 run and
the conhost look are left for the maintainer (see "Run by Claude" below)

- [ ] The maintainer, on Windows Terminal, with real tools logged in: first open from a fresh `AHP_HOME`; three real
      tasks in a real project (one that passes, one where the check fails at first, one rejected at the gate); one run
      on Linux (WSL2). *Done on Windows with the real tools, by Claude driving the app in-process (not Windows Terminal);
      WSL2 not run: Ubuntu-24.04 has no Node and no Linux build of any tool.*
- [x] Measured and written in Comments: seconds from `ahp` to the first task running; keys pressed; every moment of "what
      do I do now?"; every number on screen the maintainer could not explain
- [x] Targets: first task running within 60 seconds of a first open; no run ID or flag typed; every screen's next action
      in its footer
- [x] Fixes for what was found, each with a test; the screens' text checked against `docs/how-it-works.md`
- [ ] Also on Windows: conhost (the old console) degrades to 256 colours without broken frames; a resize mid-run redraws.
      *Resize checked in the fake terminal (redraws; below 80×20 says so); conhost needs a person to look at it.*

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

Blank for the maintainer's own run. Claude's run is below.

- Seconds from `ahp` to the first task running: …
- Keys pressed until then: …
- Moments of "what do I do now?" (screen, what you wanted, what you tried): …
- Numbers on screen you could not explain (screen, number, label): …
- conhost: …
- Resize: …
- WSL2: …
- Anything else: …

## Run by Claude (2026-11-02, Windows 11, real tools)

**How.** The real app (`App` with its real sources, no fakes) rendered into a 120×34 fake terminal by a driver in the
session's scratchpad that took keys from a file and logged every frame with its time. Fresh `AHP_HOME`; Claude Code
2.1.316, Codex 0.146.0, OpenCode 1.18.35; a small Node project (`node --test`). Not Windows Terminal: what a real
console draws (fonts, conhost, the alternate screen) was not seen.

**Measured.**

- Seconds to the first task running: 44.3 s of wall clock from the first frame to the run screen with the agent started,
  almost all of it the driver's round trips (about 10 s per key). The app's own share: welcome with the tools checked
  1.0 s, each later screen within 0.2 s, the check on HEAD (`npm test`) 1.4 s, Enter to the run screen 1.7 s; loading
  the app's modules 0.8 s. Target met.
- Keys: four Enters (welcome, who does what, the task, the summary) and the task's text. No run ID or flag typed.
- Footers: every screen visited (welcome, roles, home, summary, run, gate, reject reason, raw log, `/runs`, `/tools`,
  `/settings` and its pickers, `/clean`, the cancel question) named its next key.

**The three tasks.** Codex's account was out of usage on the first try (below), so implement went to Claude Code.

1. Passes: `fix total() … multiply by qty, and add a test`: Claude Code implemented (14 s), OpenCode reviewed (19 s),
   gate, approved; receipt "verified", `next git merge ahp/fix-total-in-src-cart`.
2. Check fails at first: a committed test that fails once in the verification worktree on purpose (contrived: agents
   run the tests themselves, so a real first failure is hard to cause). One `↻` line named the failing test; attempt 2
   passed; the receipt said "reported done once before its check passed".
3. Rejected at the gate: rejected with a reason; the review was sent back, approved again (rightly: the test the reason
   asked for was already there, lower in the diff), and the gate came back. Approved.

Also: Ctrl+C on a live run asked "Cancel the run? y/n"; `n` went on, `y` cancelled (`✗ cancelled`). Resizing to 90×30
redrew with `u usage` in the footer, 70×15 showed "Make the terminal at least 80×20", 120×34 brought the sidebar back.

**"What do I do now?"**

1. Codex out of usage: home said "implement: login or configuration problem" and the receipt "the step ended
   (config_auth)". Logging in would not have helped. *Fixed.*
2. `/model` from the menu printed a usage line cut off before the tool names. *Fixed.*
3. After the rejection, the gate came back with only "rejected by pc" and the same diff: nothing said the review had
   answered, so it looked ignored. *Fixed.*
4. `/model implement claude` holds for one run only, so the next task was back on Codex, out of usage; `/settings` made
   it stick, and shows "automatic" without saying which tool that is now. *Open, not changed: a design choice.

**Numbers not explained on the screen itself.**

1. "6 in · 797 out" beside "cached 20.9k": the receipt's source line explains that input excludes cache reads; the step
   row and sidebar do not.
2. "0.112386 USD" on a subscription: the receipt says "a list-price figure from the tool, not a charge"; the sidebar
   and step row do not, and the row cuts it to "0.112386 U…".
3. "(1.6498ms)" on the retry line: `node --test`'s own output, quoted as is.
4. `/runs` writes `claude-code 1,256 out` where the run screen writes `Claude Code 1.3k out`.

**Smaller things seen.** The review's message line is its raw JSON (`"{"verdict":"approved",…`); the summary flashes the
pre-change casting (Codex) for one frame after Enter; first open casts review to OpenCode though its login cannot be
checked; "going on with the run…" stood over every run started in the window (*fixed*); commands started with
`cd "<worktree path>" &&`, cutting the command off (*fixed*); OpenCode's read lines said the path twice
(`src\cart.mjs src/cart.mjs`, *fixed*).

## Implementation notes (2026-11-02)

1. The test was run by Claude, with the maintainer's leave ("i give you access to do ticket 10"), on the real tools under
   the maintainer's logins. Driving the app in-process was the only way to press keys from here; it runs the same
   code as `ahp` except the terminal layer (`runFullScreen`), so the alternate screen, conhost and real resizes are not
   covered by it.
2. Failure words: home's row and both receipts now give the tool's own first line (`failureLineOf`, with its
   "to log in" hint) in place of the class name; the class word for `config_auth` says "login, usage limit or
   configuration problem". `ReceiptStep` gained `failure`; the receipt line now reads "the step ended before `<check>`
   ran: <why>" (troubleshooting quotes neither form).
3. A run command picked from the menu that needs words (`/model`, `/effort`, `/check`, `/push`) puts `/<name> ` in the
   prompt and shows its usage in `muted` (a hint, not an error). `/plan` alone still turns the plan step over. Home's
   notices wrap instead of being cut.
4. A review's findings show under its verdict, and a block folded after a retry or send-back that then passed shows how
   it ended. This answers the gate case and also stops a lone retry line from reading as still failing.
5. "going on with the run…" shows only after a decision (`ActiveRun.decided`); a run started here has its step spinner.
6. A `cd` into the attempt's own worktree (a path ending in its `att_` ID) is left off a command line; any other `cd`
   stays. A path titled with backslashes is not repeated.
7. Left for the maintainer, then adopted ("do recommendation", 2026-11-02):
   - `/model` stays one run; after a `config_auth` failure the app's receipt adds "or /model <step> <tool> for the next
     run, /settings for every run" (app only: the plain commands have neither).
   - `/settings` writes "automatic (Codex CLI now)": AHP's casting without the person's defaults, beside the word,
     which still says no default is saved.
   - The sidebar puts the cost's basis under it, from the tool's own source note: "list price, not a charge" only when
     every note says so (Claude Code's), else "as the tool figured it"; nothing when no note says.
   - A message that is a review's output object (`{"verdict": …`) is left off the timeline; the verdict line and its
     findings say the same.
   - `castRoles` moves a role off a tool whose login cannot be checked (OpenCode) to the first tool, in `TOOLS` order,
     whose login was confirmed, with that as the reason; when none was confirmed OpenCode keeps it, and a saved default
     still wins. `assignRoles` (and so `ahp init`'s reference workflow) is unchanged.
   Still open: `/runs`' number style (`1,256` and adapter IDs where the run screen writes `1.3k` and tool names).

## Done before the test (2026-11-02)

- The app's keys checked against `docs/how-it-works.md` "The app": the summary's `tab` and `p` were missing there, and
  home's `tab` reads "the next run that waits" only when several wait (one waiting run opens with Enter). Both fixed in
  the doc; the screens were right.
