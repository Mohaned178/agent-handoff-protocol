# 08: Plain commands and the ported tests

**Implement with:** Sonnet 5.5, effort high

**What to build:** The non-interactive commands of spec D7, written from zero in `src/commands/` with brief line output,
for CI, scripts, pipes and agents. The tests that guard engine behaviour through a real `ahp` child process move onto
them, keeping everything they assert.

**Blocked by:** 04 (for `receiptOf`)

**Status:** done (2026-11-02)

- [x] One parser (`node:util` `parseArgs`), one usage text; an unknown flag refused with that command's usage line
- [x] `ahp run <workflow>`, `ahp approve <run> [<gate>]`, `ahp reject <run> [<gate>] --reason`, `ahp recover
      <run|attempt> [--policy adopt|abort]`, `ahp runs [--all]`, `ahp inspect [<run>]`, `ahp doctor`, `ahp eval
      <suite>`, `ahp bench <bench-file> [--engine <id>]` and `ahp bench report <dir>... [--eval <dir>...]` (from the
      inference evaluation, same output and `--json`), `ahp clean`, `ahp demo --yes`, `ahp "<task>" --yes` with today's flags (`--check`, `--plan`,
      `--<step>`, `--<step>-model`, `--<step>-effort`, `--push`, `--mock`, `--no-precheck`); `--json` where it exists
      today, its shape unchanged; the gate optional when one gate waits
- [x] Output: a line per ended step, the receipt from `receiptOf`, one `next:` line; no colour or animation; exit codes
      unchanged (0 passed, 1 failed, 2 usage, 4 waiting for a person)
- [x] Port, keeping each assertion about the ledger, exit codes and remotes: `cli.test.ts`, `cli-approval`,
      `cli-cancel` (Linux and macOS only, as today), `cli-capabilities`, `cli-external`, `cli-ledger`, `cli-recovery`,
      `cli-retry`, `cli-review`, `cli-eval`, and the bench's CLI test (`cli-bench`)
- [x] `docs/troubleshooting.md` updated for every message these commands print

## Implementation notes (2026-11-02)

1. **Plain commands live in `src/commands/main.ts`** (parser `args.ts`, one `COMMAND_SPECS` table feeding usage and errors); `src/commands/bin.ts` runs them, but `ahp` still ships `src/cli/bin.ts` until ticket 09.
2. **Ported tests keep their assertions** and call `plain()` from `test/helpers/cli.ts`; `ahp()` (old CLI) stays for the presentation tests ticket 09 deletes.
3. **Full suite:** 1405 passed; `bench-verified` timed out once at 60 s under full-suite load and passed alone in 20 s (a load flake, not a change of this ticket).

4. **Independent of the old layer.** Nothing in `src/commands/` imports `src/cli/`: `inspect-text.ts` (`formatRun`, `formatRuns`, `formatUnresumed` and the `describe*` pieces), `receipt-text.ts`, `bench-text.ts`, `evaluation-text.ts` and `doctor-text.ts` are copies of the old formatters minus `formatEvent`, so deleting `src/cli/` costs nothing. `inspect` keeps the old wording line for line, because the ledger, capability, protected-path and lock tests pin it.
5. **Parser.** A lenient pre-parse over every option finds the command word (`ahp --yes "fix it"` works), then that command's own options are parsed strictly. An unknown option, a missing or an extra argument is answered with that command's usage line (`usage: ahp runs [--all] [--json] [--repo <dir>]`), an unknown command with the whole text. `--help` and `help` print one text; `help all` and `--help --all` are gone (`runs --all` stays). `ahp` with no arguments prints it and exits 0 (opening the app on a terminal is 09's wiring). `setup`, `settings` and `init` already answer "has moved into the app" (exit 2) in this entry.
6. **Flags dropped, flags kept.** Dropped: `--diff` and `--verbose` (plain output is brief on purpose; `ahp inspect` holds every attempt and `git diff` the code), `--clear` (settings left with the app). Kept beyond the ticket's list: `--no-check` (a project with no check could not run without a terminal otherwise), `--save` (a `.mjs` name, as the app's "save as workflow"), `--repo`, `--out`, `--seed`, `--engine`, `--eval`. `demo --real` is kept and, because it spends the person's own usage, needs `--yes`; plain `demo` runs the mock as before.
7. **Output.** The run's ID is printed the moment it exists (`run <id>: created · <workflow>`: the crash tests read it), then a line per step that ends, per retry, reroute, send-back (with the findings), rejection, wait for a person, unknown attempt, recovery decision, cancel and handoff refusal; the recovery report of an unknown attempt is printed whole because adopt or abort is decided from it. Plumbing (attempt created, running, verifying, snapshot, handoff issued) is not printed; its facts are asserted through the ledger or `inspect` instead. The end is `run <id>: <state> [mock]`, the receipt, **one** `next:` line and the mock note. `nextStepOf` says nothing for a run waiting at a gate (the app decides it in place), so the plain layer composes that `next:` from `describeApprovalChoices`; `nextStepOf` and `receipt.test.ts` are unchanged.
8. **The gate is optional**, and it changes one old assertion on purpose: `cli-approval`'s "leave out the step → exit 2" became "leave out the run → exit 2", with two new tests (the unnamed gate is decided; a run waiting at none is refused with `run <id> is not waiting for approval: it is <state>`, exit 1).
9. **Moves, so note 2 reads right.** Every assertion about the ledger, exit codes, remotes and `inspect` text is unchanged. Text that was a streamed event moved by one rule: a fact a CI reader needs stays on a run line; plumbing is asserted from the ledger or `inspect` (`attempt running/verifying`, `handoff issued/accepted`, `structural verification`, `exited error (exit code 3)`, `verification inconclusive` twice, `checked the remote: … already done` → `external_action_checked` with `done: true`, `exited cancelled (…forced…)` → `inspect`).
10. **`ahp "<task>" --yes`** has nobody to ask, so what cannot be worked out is an error that names the flag, and a folder that is not a repository is a usage error (the app offers `git init`). `prepareTask` does everything up to starting the agents (summary, first real-agents notice, the check run once on the last commit, `--save`) and `taskCommand` runs what it returns; that split lets the tests cast real (fake) tools and read the summary without starting an agent.
11. **Coverage that 09 would otherwise delete** has a home in `test/commands-task.test.ts` (summary rows and sources, the uncommitted note, `--plan`, branch numbering, the check run once first, step flags and their refusals, saved defaults and fallbacks, the first real-agents notice once, no tool, `--yes`, `--check`, `--no-check`, `--push`, `--save`, the refusals), `test/commands-runs.test.ts` (`runs`, `inspect` with no ID, a broken ledger, the 20-run cap, usage in the receipt, the repository line, the home-folder refusal, no repository, a missing remote, `doctor`, `demo`) and `test/commands-clean.test.ts`.
12. **Ctrl+C.** `cli-cancel.test.ts`'s child-process test is Linux and macOS only and was not run: WSL on this machine has no Node. A second test in the same file starts `main` in the test process, emits `SIGINT` once the attempt runs and checks exit 130, `run_cancel_requested` after `attempt_running`, the run ending and the lines; it runs on Windows and passes there.
13. **Under load.** A full run with default workers timed out `evaluation-schedule` (two tests) and others at 60 s and failed one `tui-task` test; every one passed alone (`evaluation*` together with `--maxWorkers=3`: 149 passed; `tui-task`: 18 passed), so these are load flakes like note 3's.
