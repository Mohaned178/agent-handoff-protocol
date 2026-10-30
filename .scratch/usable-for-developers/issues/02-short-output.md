# 02: Short output

**What to build:** Everything `ahp "<task>"`, `ahp run`, `ahp approve` and `ahp reject` print in a terminal, said
briefly: what a developer needs to decide or act, and nothing they did not ask for. Details stay one flag away.

**Blocked by:** none (spec D4 and D5 decide the defaults)

**Status:** planned

- [ ] A text budget, checked by tests on the rendered output (a fake terminal, as `test/cli-live.test.ts` has): the
      summary at most 7 lines, a step's line one line (two with what it changed), the receipt at most 4 lines plus one
      for usage, no line wider than the terminal's columns (cut with "…", never wrapped)
- [ ] The summary (`formatTaskSummary`): sources as a dim word after the value ("npm test · package.json"), not a
      parenthesis; the result row says "branch ahp/x, local" or "pushed to origin"; uncommitted files one short line
- [ ] The live view (`live.ts`): a retry or send-back is one line ("↻ implement  check failed, retrying (2/3)"); its
      evidence, findings and failing output only when the step finally fails, or with `--verbose`
- [ ] The receipt (`receipt.ts`): one line of outcome ("✓ verified: npm test passed · 1 retry · 1 send-back,
      approved after"), then only what failed or was refused, one line each; usage on one line per tool
      ("codex 18.2k in · 2.1k out · cost not reported"); the full receipt stays in `ahp inspect`
- [ ] The run's end: the outcome last, then one "next" line (spec: "suggest the next command"), e.g. "merge it:
      git merge ahp/fix-the-cart-total" or "decide later: ahp approve <run> approve"
- [ ] The honesty rules (spec D5) as short labels on screen and in full in `ahp inspect` and `docs/how-it-works.md`;
      no on-screen line claims more than the long form did ("reported done", never "done")
- [ ] Colour: green for passed, red for failed, yellow for a retry or a wait, dim for sources and times; nothing else
      coloured; none without a TTY or with `NO_COLOR` (as today)
- [ ] `--verbose` and the plain event log (no terminal, CI) are unchanged: scripts and tests that read them keep working
- [ ] Tests: the budget above on the mock's runs (clean pass, a retry, a send-back, a failure, a gate), and that
      nothing the long form says is lost from `ahp inspect`

## Notes

- Research and the four complaints it answers: `.scratch/cli-ux/research.md`.
- No new dependency is needed: `live.ts` already draws in place; @clack/prompts is a reference for the look, not a
  replacement for `@inquirer/prompts`.
