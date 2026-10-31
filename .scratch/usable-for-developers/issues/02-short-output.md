# 02: Short output

**What to build:** Everything `ahp "<task>"`, `ahp run`, `ahp approve` and `ahp reject` print in a terminal, said
briefly: what a developer needs to decide or act, and nothing they did not ask for. Details stay one flag away.

**Blocked by:** none (spec D4 and D5 decide the defaults)

**Status:** done (2026-10-31)

- [x] A text budget, checked by tests on the rendered output (a fake terminal, as `test/cli-live.test.ts` has): the
      summary at most 7 lines, a step's line one line (two with what it changed), the receipt at most 4 lines plus one
      for usage, no line wider than the terminal's columns (cut with "…", never wrapped)
- [x] The summary (`formatTaskSummary`): sources as a dim word after the value ("npm test · package.json"), not a
      parenthesis; the result row says "branch ahp/x, local" or "pushed to origin"; uncommitted files one short line
- [x] The live view (`live.ts`): a retry or send-back is one line ("↻ implement  check failed, retrying (2/3)"); its
      evidence, findings and failing output only when the step finally fails, or with `--verbose`
- [x] The receipt (`receipt.ts`): one line of outcome ("✓ verified: npm test passed · 1 retry · 1 send-back,
      approved after"), then only what failed or was refused, one line each; usage on one line per tool
      ("codex 18.2k in · 2.1k out · cost not reported"); the full receipt stays in `ahp inspect`
- [x] The run's end: the outcome last, then one "next" line (spec: "suggest the next command"), e.g. "merge it:
      git merge ahp/fix-the-cart-total" or "decide later: ahp approve <run> approve"
- [x] The honesty rules (spec D5) as short labels on screen and in full in `ahp inspect` and `docs/how-it-works.md`;
      no on-screen line claims more than the long form did ("reported done", never "done")
- [x] Colour: green for passed, red for failed, yellow for a retry or a wait, dim for sources and times; nothing else
      coloured; none without a TTY or with `NO_COLOR` (as today)
- [x] `--verbose` and the plain event log (no terminal, CI) are unchanged: scripts and tests that read them keep working
- [x] Tests: the budget above on the mock's runs (clean pass, a retry, a send-back, a failure, a gate), and that
      nothing the long form says is lost from `ahp inspect`

## Notes

- Research and the four complaints it answers: `.scratch/cli-ux/research.md`.
- No new dependency is needed: `live.ts` already draws in place; @clack/prompts is a reference for the look, not a
  replacement for `@inquirer/prompts`.

## Implementation notes (2026-10-31)

Seen first in a capture of real compact output (scratch script, mock runs). What changed:

- **Summary** (`formatTaskSummary`): sources as a word after the value (`package.json`, `--check`, `typed by you`),
  `mock` / `scripted, not a real agent`, `default model`, `· your default`, `branch ahp/x, local only`, the install row
  left out when there is none, uncommitted files one short line. Six lines for implement → review.
- **Live view** (`live.ts`): one heading line (workflow · repo · run); a retry is one line with the first failing line
  of its check (`failureLineOf`); a send-back one line with its findings joined; a review's verdict on its own step
  line; no "passed on attempt N"; a failed step one detail line ("retry budget spent: <first failing line>"); the
  publish step says "made branch ahp/x"; lines cut to the terminal's width with "…"; an unknown attempt one line, its
  recovery report and commands left to `ahp inspect` and the run's "next" line; the gate's heading carries what it
  would approve and its diff leaves out git's metadata lines (`formatDiff`'s `brief`).
- **End of run** (`endOfRun` in `main.ts`, `formatBriefReceipt` and `nextStepOf` in `receipt.ts`): a line per check
  ("✓ implement: `npm test` passed · after one failed attempt · sent back once, approved after"), a line per refusal,
  a line of usage per tool ("usage: codex 18.2k in · 2.1k out (as reported; <source>)", or "reported none"), a
  "next:" line, and "scripted mock agents: their results are not evidence". The plain log and `--verbose` keep the
  full receipt and note; `ahp inspect` keeps the full receipt at its top.
- **Honesty rules in full** in `docs/how-it-works.md`, "What a run's end says" (spec D5).

Found while doing it and fixed: **`--mock` left an attempt unknown** when the project's check failed (the mock had one
script per step, so the retry could not start and a 20-line recovery report followed); `mockScripts` now covers every
attempt the default budget allows. **"run succeeded in 0s"** after a decision at a gate: the time now runs from the
run's creation when the view goes on from a gate.

Not done, on purpose: the summary is not coloured (it is printed before the live view, through `io.stdout`); colour
stays as it was in the live view (green ✓, red ✗, yellow ↻ ↩ !, dim details).

## Comments

- 2026-10-31: first green CI run with this ticket: 41148100744 (commit `9b926d8`), all three systems.
