# 06: Docs a developer reads in five minutes

**What to build:** A README whose first screen gets a developer from nothing to a run in three commands, a
troubleshooting page for what ticket 03 cannot fix in the message alone, and one real receipt.

**Blocked by:** 03 and 04 (the errors and the real receipt); 07 for the install line

**Status:** in progress (2026-10-31): everything that does not need ticket 04 or 07 is done

- [x] Quickstart: `npm i -g <package>`, `ahp doctor`, `ahp "<task>"`; `ahp demo` as the free first look (the
      install line is the GitHub one until ticket 07 publishes the package: change it then)
- [ ] The opening receipt replaced by a real one from ticket 04 (its run ID and date beside it), and the
      "illustrative" label removed (waits for ticket 04)
- [x] `docs/troubleshooting.md`: one entry per failure ticket 03 lists, each as symptom → cause → command, and the
      Windows entries moved here from ticket 03: a path too long (AHP worktrees set `core.longpaths`), a locked file
      (`EBUSY`), PowerShell quoting of a task that contains quotes
- [x] "What it costs": AHP is free; each step is an agent run on the person's own plan; how many attempts a run can
      take at most (the retry budgets), and that `ahp inspect` shows what each tool reported
- [x] `ahp --help` shortened to the commands a new user needs first, with "ahp help all" (or `--help --all`) for the
      rest. *Decision for this ticket:* the exact split; recommendation: task, demo, doctor, runs, inspect, approve,
      reject first (taken)
- [ ] A short recording of a real run in the README (an asciinema cast or a GIF). *Decision for this ticket:* whether
      a binary GIF belongs in the repository; recommendation: an asciinema link, nothing binary committed (waits for
      ticket 04: a recording of a real run)
- [x] Every claim in the README checked against what the code does on that day (the README already avoids claiming
      better results; keep that until the pilot has one)

## Notes

- `docs/how-it-works.md` keeps the details and the honesty rules in full (ticket 02, spec D5).

## Implementation notes (2026-10-31)

- `--help` prints `SHORT_USAGE` (`src/cli/main.ts`): task, demo and doctor under "Start here", runs, inspect, approve
  and reject under "Follow a run", and the six task options a first run uses; `--help --all` prints the whole `USAGE`
  as before. An unknown or missing command also prints the short one. `ahp` alone points to both.
- The PowerShell entry is measured, not recalled: Windows PowerShell 5.1.26100 drops double quotes inside an argument
  passed to a program (`'fix the "total" bug'` arrives as `fix the total bug`) and needs `\"`; PowerShell 7.6.9 passes
  them as typed and would pass `\"` literally.
- "What it costs" is read from `decideAfterFailure` and replay: send-backs and gate rejections spend implement's
  `verification_failed` budget (2), so review runs at most three times; review's own budget is not reset by a
  send-back, so its 2 retries are for the whole run.
- Claims checked: the support note and table match `docs/support-matrix.md`; the receipt and run output stay labelled
  illustrative until ticket 04 gives a real one.
