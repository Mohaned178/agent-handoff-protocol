# 06: Docs a developer reads in five minutes

**What to build:** A README whose first screen gets a developer from nothing to a run in three commands, a
troubleshooting page for what ticket 03 cannot fix in the message alone, and one real receipt.

**Blocked by:** 03 and 04 (the errors and the real receipt); 07 for the install line

**Status:** planned

- [ ] Quickstart: `npm i -g <package>`, `ahp doctor`, `ahp "<task>"`; `ahp demo` as the free first look
- [ ] The opening receipt replaced by a real one from ticket 04 (its run ID and date beside it), and the
      "illustrative" label removed
- [ ] `docs/troubleshooting.md`: one entry per failure ticket 03 lists, each as symptom → cause → command, and the
      Windows entries moved here from ticket 03: a path too long (AHP worktrees set `core.longpaths`), a locked file
      (`EBUSY`), PowerShell quoting of a task that contains quotes
- [ ] "What it costs": AHP is free; each step is an agent run on the person's own plan; how many attempts a run can
      take at most (the retry budgets), and that `ahp inspect` shows what each tool reported
- [ ] `ahp --help` shortened to the commands a new user needs first, with "ahp help all" (or `--help --all`) for the
      rest. *Decision for this ticket:* the exact split; recommendation: task, demo, doctor, runs, inspect, approve,
      reject first
- [ ] A short recording of a real run in the README (an asciinema cast or a GIF). *Decision for this ticket:* whether
      a binary GIF belongs in the repository; recommendation: an asciinema link, nothing binary committed
- [ ] Every claim in the README checked against what the code does on that day (the README already avoids claiming
      better results; keep that until the pilot has one)

## Notes

- `docs/how-it-works.md` keeps the details and the honesty rules in full (ticket 02, spec D5).
