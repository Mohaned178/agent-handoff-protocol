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
