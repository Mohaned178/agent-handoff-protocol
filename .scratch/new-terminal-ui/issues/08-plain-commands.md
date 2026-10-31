# 08: Plain commands and the ported tests

**Implement with:** Sonnet 5.5, effort high

**What to build:** The non-interactive commands of spec D7, written from zero in `src/commands/` with brief line output,
for CI, scripts, pipes and agents. The tests that guard engine behaviour through a real `ahp` child process move onto
them, keeping everything they assert.

**Blocked by:** 04 (for `receiptOf`)

**Status:** todo

- [ ] One parser (`node:util` `parseArgs`), one usage text; an unknown flag refused with that command's usage line
- [ ] `ahp run <workflow>`, `ahp approve <run> [<gate>]`, `ahp reject <run> [<gate>] --reason`, `ahp recover
      <run|attempt> [--policy adopt|abort]`, `ahp runs [--all]`, `ahp inspect [<run>]`, `ahp doctor`, `ahp eval
      <suite>`, `ahp bench <bench-file> [--engine <id>]` and `ahp bench report <dir>... [--eval <dir>...]` (from the
      inference evaluation, same output and `--json`), `ahp clean`, `ahp demo --yes`, `ahp "<task>" --yes` with today's flags (`--check`, `--plan`,
      `--<step>`, `--<step>-model`, `--<step>-effort`, `--push`, `--mock`, `--no-precheck`); `--json` where it exists
      today, its shape unchanged; the gate optional when one gate waits
- [ ] Output: a line per ended step, the receipt from `receiptOf`, one `next:` line; no colour or animation; exit codes
      unchanged (0 passed, 1 failed, 2 usage, 4 waiting for a person)
- [ ] Port, keeping each assertion about the ledger, exit codes and remotes: `cli.test.ts`, `cli-approval`,
      `cli-cancel` (Linux and macOS only, as today), `cli-capabilities`, `cli-external`, `cli-ledger`, `cli-recovery`,
      `cli-retry`, `cli-review`, `cli-eval`, and the bench's CLI test (`cli-bench`)
- [ ] `docs/troubleshooting.md` updated for every message these commands print
