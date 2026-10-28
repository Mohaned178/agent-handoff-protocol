# 26: Interactive setup (`ahp setup`)

**What to build:** An interactive terminal command that sets up either a workflow (for `ahp run`) or an evaluation suite (for `ahp eval`), choosing the tool and the model of each step in menus, writes the file and offers to start it.

**Blocked by:** 13, 20

**Status:** done

**Model:** Opus 5.5

Asked for by the maintainer on 2026-10-28, after the first real end-to-end run ("i want to see interactive ui in terminal and choose which model"). Not in the release-1 spec; decided in chat: both kinds of file, models listed by each tool where it can, `@inquirer/prompts` for the menus.

- [x] `ahp setup` asks: workflow or evaluation; for each role (plan, implement, review; only implement when C0 and the baseline alone run) the tool, from what `ahp doctor` found (a tool that cannot be used is shown with the reason and cannot be picked), then the model
- [x] Models: the tool's own default first (no model requested), then the tool's list (`opencode models`, free models first) or the names AHP knows (Claude Code's aliases; for Codex and Gemini CLI the names this project's runs used, labelled as such), then a name typed in
- [x] Effort, asked after the model only for a tool whose adapter has one (`effortsFor`: Claude Code's `CLAUDE_CODE_EFFORTS`, Codex's `CODEX_EFFORTS`; OpenCode and Gemini CLI have none and are not asked), the tool's default first; written as the agent's `options.effort` (added on the maintainer's request, 2026-10-28)
- [x] Workflow: the reference scenario `ahp init` writes, with the chosen models (`RoleAssignment.model`), validated before it is written; the mock is offered there only
- [x] Evaluation: tasks found under `pilot/tasks` (or typed), conditions (a baseline without C3 is refused), repeats, an optional spend cap in USD; validated with `validateSuite` before it is written
- [x] Never replaces a file: an existing name is asked for again, and the write is exclusive
- [x] Offers to start it, through the same `run`/`eval` commands; refuses without a terminal (usage error); Ctrl+C at a question exits 130 with nothing started

## Notes

- Code: `src/setup/` (`wizard.ts` behind a `Prompter`, `prompter.ts` the real menus, `models.ts`); tests `test/setup.test.ts` drive the wizard with scripted answers. The menus themselves (`terminalPrompter`) are not tested: they are the library's.
- The Codex and Gemini names are not a catalogue and may go stale; the typed-in choice is the way around that.
