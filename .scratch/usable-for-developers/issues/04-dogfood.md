# 04: The maintainer uses it on real work

**What to build:** Nothing in code. Five to ten real tasks run through `ahp "<task>"` by the maintainer, so the first
public version has met real projects and real agents, and every problem found becomes a line in ticket 05.

**Blocked by:** 02 and 03 (so the run is judged on the output it will ship with); needs the maintainer

**Status:** planned

- [ ] Tasks from real projects (not this repository's pilot fixtures), small to medium: a bug with a failing test, a
      small feature with tests, a refactor, one project with no tests (review only), one in a non-Node language
- [ ] Each of the three tools implements at least once and reviews at least once; Windows for all, WSL2 for some
- [ ] For each run, a line in this ticket: task, tools, outcome, time, reported usage, and what was confusing or broke
      (copy the terminal output for anything that broke; never the agent's credentials or a private repository's code)
- [ ] One receipt that shows a check catching something, kept for the README (ticket 06)
- [ ] Each problem filed as a checkbox in ticket 05, worst first
- [ ] Done when at least five runs finished and no problem in ticket 05 is marked "blocker"

## Notes

- The usage counts against the maintainer's own plans; pick tasks that are worth doing anyway.
- A run that goes badly is the point: it is found here, not by the first outside user.
