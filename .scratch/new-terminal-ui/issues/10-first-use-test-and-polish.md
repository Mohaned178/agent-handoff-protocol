# 10: First-use test and polish

**Implement with:** Opus 5.5, effort high (the test itself is the maintainer's)

**What to build:** The check that the app is one a developer would choose: the maintainer uses it on real work, and
what gets in the way is fixed.

**Blocked by:** 09

**Status:** todo

- [ ] The maintainer, on Windows Terminal, with real tools logged in: first open from a fresh `AHP_HOME`; three real
      tasks in a real project (one that passes, one where the check fails at first, one rejected at the gate); one run
      on Linux (WSL2)
- [ ] Measured and written in Comments: seconds from `ahp` to the first task running; keys pressed; every moment of "what
      do I do now?"; every number on screen the maintainer could not explain
- [ ] Targets: first task running within 60 seconds of a first open; no run ID or flag typed; every screen's next action
      in its footer
- [ ] Fixes for what was found, each with a test; the screens' text checked against `docs/how-it-works.md`
- [ ] Also on Windows: conhost (the old console) degrades to 256 colours without broken frames; a resize mid-run redraws
