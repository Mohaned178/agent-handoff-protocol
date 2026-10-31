# 05: First open and the task flow

**Implement with:** Sonnet 5.5, effort high

**What to build:** The first-open screens, and the path from a sentence in the prompt to a running run, with every
step's tool, model and effort one key away (spec "First open", "Summary", D6, D9).

**Blocked by:** 04

**Status:** todo

- [ ] First open (no `settings.json`, or `firstOpenDone` unset): the welcome screen (logo, one sentence, the tools found
      by `diagnose` with version and login, the install or log-in command for one that is not ready), then "Who does
      what?" (each role's tool, model and effort, prefilled from `castRoles`; Enter keeps them, saving
      `settings.json` with `firstOpenDone`), then home; `ahp` opened later skips both
- [ ] No usable tool: the second screen offers `m` try it on the mock; the app then marks every run "mock" and the
      receipt says mock output is not evidence
- [ ] Repository readiness as screens (spec's edge-state table): not a repository, no first commit, no git identity,
      the home folder; the logic stays in `src/setup/` with no printing
- [ ] Prompt → summary: `infer.ts`, `castRoles` with the saved defaults, `branchFor`, `buildTaskRun`; each answer with
      its source in `muted`; a project with no check asks for one in place
- [ ] Choosing per step: `Tab` cycles the steps on the summary; `enter` on one opens the picker for its tool, then
      model (default first, then listed or known, then typed), then effort (only where the tool has one); OpenCode's
      access question once, never claimed to be checked; `p` adds or removes the plan step; then "use this next time?"
      (default no) saves to `settings.json`
- [ ] The same from the prompt: `/model implement codex gpt-5.6`, `/effort review high`, `/plan on`, `/check <cmd>`,
      `/push origin` change the next run (and say so on the status line)
- [ ] Run: the precheck on HEAD (a failure asks "run it anyway?"), the one-time real-agents notice, then `runWorkflow`
      in this process with a `signal`, and the run screen opens on it
- [ ] Cancel: `ctrl+c` while a run goes asks "Cancel the run? y/n"; `esc` goes home with the run still going (shown at
      the top with its spinner); quitting with a run going asks "A run is going. Cancel it and quit?"
- [ ] Tests (`test/tui-first-open.test.ts`, `test/tui-task.test.ts`): first open with fake tools logged in, logged out,
      none; a task to a passing mock run; changing implement's model and effort, saved and not saved; slash commands;
      no check; the precheck failing; cancel from the run screen and from home; quit with a run going
