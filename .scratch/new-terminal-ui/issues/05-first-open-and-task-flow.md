# 05: First open and the task flow

**Implement with:** Sonnet 5.5, effort high

**What to build:** The first-open screens, and the path from a sentence in the prompt to a running run, with every
step's tool, model and effort one key away (spec "First open", "Summary", D6, D9).

**Blocked by:** 04

**Status:** done (2026-11-02)

- [x] First open (no `settings.json`, or `firstOpenDone` unset): the welcome screen (logo, one sentence, the tools found
      by `diagnose` with version and login, the install or log-in command for one that is not ready), then "Who does
      what?" (each role's tool, model and effort, prefilled from `castRoles`; Enter keeps them, saving
      `settings.json` with `firstOpenDone`), then home; `ahp` opened later skips both
- [x] No usable tool: the second screen offers `m` try it on the mock; the app then marks every run "mock" and the
      receipt says mock output is not evidence
- [x] Repository readiness as screens (spec's edge-state table): not a repository, no first commit, no git identity,
      the home folder; the logic stays in `src/setup/` with no printing
- [x] Prompt → summary: `infer.ts`, `castRoles` with the saved defaults, `branchFor`, `buildTaskRun`; each answer with
      its source in `muted`; a project with no check asks for one in place
- [x] Choosing per step: `Tab` cycles the steps on the summary; `enter` on one opens the picker for its tool, then
      model (default first, then listed or known, then typed), then effort (only where the tool has one); OpenCode's
      access question once, never claimed to be checked; `p` adds or removes the plan step; then "use this next time?"
      (default no) saves to `settings.json`
- [x] The same from the prompt: `/model implement codex gpt-5.6`, `/effort review high`, `/plan on`, `/check <cmd>`,
      `/push origin` change the next run (and say so on the status line)
- [x] Run: the precheck on HEAD (a failure asks "run it anyway?"), the one-time real-agents notice, then `runWorkflow`
      in this process with a `signal`, and the run screen opens on it
- [x] Cancel: `ctrl+c` while a run goes asks "Cancel the run? y/n"; `esc` goes home with the run still going (shown at
      the top with its spinner); quitting with a run going asks "A run is going. Cancel it and quit?"
- [x] Tests (`test/tui-first-open.test.ts`, `test/tui-task.test.ts`): first open with fake tools logged in, logged out,
      none; a task to a passing mock run; changing implement's model and effort, saved and not saved; slash commands;
      no check; the precheck failing; cancel from the run screen and from home; quit with a run going

## Implementation notes (2026-11-02)

1. **First open saves only the steps the person changed**, plus `firstOpenDone`. Saving the casting AHP worked out would
   make it "your default" from then on and stop it following the tools found. `readSettings` now reads the flag even
   when `steps` is missing, so `saveStepDefault` and `markRealAgentsNoticed` no longer erase it (tested).
   `ahp settings --clear` removes the file, so first open shows again after it.
2. **Enter and the pick keys.** The spec's mockup (`enter change`, `ctrl+s save and start`) and the ticket (`enter keeps
   them`) disagree. With no step picked, Enter keeps and goes on; ↑↓ or Tab picks a step and Enter then changes it;
   `ctrl+s` always saves and goes on. The summary works the same way (Tab picks, Enter then changes; with nothing
   picked, Enter runs).
3. **No tool is never silently the mock.** `castRoles` falls back to the mock; the app does not: the home status says
   no tool is usable, the summary shows each tool's install and log-in command and offers `m`. The mock then lasts the
   session (`TaskSession.mock`) and is named on the summary title, the status line, the run header and the home rows.
4. **Overrides last one run.** `/model`, `/effort`, `/plan`, `/check`, `/push` and the summary's changes are held in a
   `TaskSession` above the screens and forgotten when a run starts (the mock stays). The status line puts what changed
   first, because it is cut at the right. `/model` and `/effort` without arguments say how to write them; the lists are
   the summary's Tab.
5. **Readiness is checked at open, after first open**, not at submit as the old CLI did: the spec's table gives Esc as
   quit, which only makes sense as a gate. The logic is in `src/setup/repository.ts` (`inspectRepository`,
   `prepareRepository`, no printing, own test); the old `readyRepository` uses it with the same messages. `precheck`
   moved to `src/setup/precheck.ts`.
6. **`TaskRunner`** (`src/tui/task-runner.ts`) owns the run started in this window: one at a time, cancelled through
   its `signal`, the run ID taken from the first event. `dev.ts` shares it with `runFullScreen`'s new `beforeExit`, so
   a SIGTERM or a closed window cancels the run before ahp ends (as the old `cancelOnInterrupt` did). Ctrl+C in the
   app is a key, not a signal, because the terminal is in raw mode.
7. **The cancel and quit questions are a screen of their own** (`screens/confirm.ts`) that covers the others while
   asked, so no other key can be taken for the answer. Quitting waits for the run's cancel to be recorded.
8. **A precheck the person left (Esc) is dropped** when it answers. The real-agents notice shows on the first summary
   with real tools and is recorded when a run starts.
9. **Tool cache.** `diagnose` is read once and kept 30 s, shared by home and the task screens; `r` on the welcome
   screen reads it again.
10. **Existing tests changed on purpose:** `tui-shell` marks first open done, gives the app a `task` source over a PATH
    with no tool, and its task, `/effort` and no-tool status assertions moved with the behaviour.
11. **Not here:** deciding a gate or an unknown attempt (ticket 06): a run that reaches the gate stops there and shows
    "waiting for your approval". `docs/troubleshooting.md` is untouched (tickets 08 and 09 own it).

