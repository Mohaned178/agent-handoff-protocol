# 27: Evaluation: a gated single agent (C0V), a two-agent pipeline (C3min), and acceptance tests apart from hidden tests

**What to build:** The evaluation must be able to show that AHP's pipeline adds nothing beyond a verify-and-retry loop that one agent can already have. It needs two new conditions and one split of the task's tests.

**Blocked by:** 21, 22, 23

**Status:** done

**Model:** Opus 5.5 · high

**Why (2026-10-29 review, "Does AHP deserve to exist?").**
- **No condition gives one agent C3's check and retry.** C0 has no check and no retry. C3 adds the check, retry, more agents and structured handoffs all at once. A C3 win could not be told apart from the effect of a verify-and-retry loop, which a developer gets from a Claude Code `Stop` hook without AHP.
- **C3 retried against the oracle it is scored by.** The hidden tests were C3's implement acceptance. The output was withheld from the agent, but the pass or fail result still reached it. That is a signal no real developer has. The hidden tests were also readable in C3's run ledger inside the trial repository (ticket 21, decision 19).

- [x] Tasks take `verification.acceptance`: a command the gated conditions run on the agent's result in a fresh verification worktree, over what the fixture holds (its visible tests), with no hidden tests in place
- [x] Hidden tests reach no workflow: only the independent validators use them
- [x] C0V: one agent (the `implement` one), the task's acceptance check, protected paths and a retry budget
- [x] C3min: implement → review (send-back), no plan step; acceptance check and retry as in C3
- [x] C3 uses the acceptance check instead of the hidden tests
- [x] A suite running C0V, C3min or C3 is refused when a task has no `acceptance`
- [x] Comparisons: C3min against C0V, C3 against C0V, C0V against C0 and C3 against C3min, before the existing ones
- [x] The baseline is labelled as a ceiling (it picks a pass with the hidden tests, which no developer can do)
- [x] The pilot tasks get `acceptance` (their visible `node --test`), checked against the reference solutions
- [x] Docs: `docs/evaluation.md`, `docs/pilot.md`, glossary, design doc §7, CLAUDE.md

## Comments

2026-10-29, implementation notes. Code in `src/evaluation/` (`events.ts`, `task.ts`, `conditions.ts`, `suite.ts`, `report.ts`) and `src/setup/wizard.ts`; pilot tasks' `task.json`; docs `docs/evaluation.md`, `docs/pilot.md`, `GLOSSARY.md` (Condition, Matched-budget baseline, Acceptance check), design doc §7, CLAUDE.md; tests `test/evaluation-conditions.test.ts` (new: C0V, C3min, the refusal, the comparison order) and updates to the task, scoring, lifecycle, C3 and pilot tests. Nothing here ran a real tool.

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **The acceptance check is its own field, `verification.acceptance`, not the scoring command run without the hidden tests.** *Recommended: adopt.* A scoring command may need the hidden files to exist at all (the test helper's `node check-greeting.mjs` does), so reusing it would fail every gated trial on such a task. The pilot's tasks happen to use `node --test` for both.
2. **In the pilot the acceptance check catches regressions only.** Each fixture's visible tests pass before any change (checked on all six), so the check never says the new feature is missing. *Recommended: keep it for the pilot and say so (done in `docs/pilot.md`).* It is what a developer's `Stop` hook running `npm test` gives, so it is the fair rival. Tasks whose visible tests also cover the feature (test-first) are a second stratum to author for the full suite, not now.
3. **C0V's one step gets the same per-step retry budget as each C3 step (default 2): at most 3 attempts against C3's 11.** *Recommended: adopt, and compare cost per verified success, not attempts.* Giving C0V C3's whole budget would match attempts but not what a developer's loop does. The baseline already covers "one agent given C3's attempts".
4. **The default stays every condition, now seven, which raises the pilot estimate from 468–1,044 to 576–1,440 attempts.** *Recommended: list `conditions: ["C0", "C0V", "C1", "C3min", "C3"]` in both pilot suites, leaving out C2 and the baseline (108 and 54 to 198 attempts per combination).* **This reopens ticket 21 decision 5 for the pilot, so it is not applied until you confirm it.** C2 answers a question that only matters if C3 beats C0V, and the baseline is a ceiling, not a rival.
5. **`ahp setup` pre-ticks C0V, C3min and C3** (it ticked C3 alone). *Recommended: adopt*: the decisive comparison is offered by default.
6. **Up to ten comparisons, the four new ones first, still with no correction for multiple comparisons.** *Recommended: adopt now, and name the one primary comparison (C3min against C0V) in the pre-registration (next step), not in code.*
7. **A retry's evidence now carries the acceptance check's output.** Before, the hidden tests' output was withheld. *Recommended: adopt*: it is the visible check, which a developer's agent would read too.

2026-10-29, a first real run, not evidence (one trial per condition on one task). `ahp eval` with Claude Code 2.1.312 (`haiku`, reported `claude-haiku-5-5`) in every role, on `password-reset`, conditions C0, C0V, C3min and C3, seed 27, no harness incidents, $0.077 reported in all (list price, not a charge). Hidden tests: C0 fail (1 attempt, $0.008), C0V pass (2 attempts, $0.013: the first edited the protected visible test file and the acceptance check refused it), C3min pass (3 attempts, $0.022), C3 fail (7 attempts, $0.034: the review found the seeded `findByEmail` defect and sent implement back twice, and the implementer declined both times to touch `users.js` as outside its scope). No planted constraint was broken. Kept outside the repository; the report is the run's `report.txt`.

2026-10-29, done. First green CI run after the push: run 40801872356 on `dbfa35f`. Ubuntu, Windows and macOS all succeeded: 846 passed and 1 skipped on Ubuntu and on macOS, 843 passed and 4 skipped on Windows (847 tests in all; the skips are the ones that need another OS). The decisions above are not yet confirmed.

**Confirmed by the maintainer on 2026-10-29 ("do recommendation"): decisions 1 to 7 above stand as recommended; reopen one only with a new decision.** That includes decision 4, which reopens ticket 21 decision 5 for the pilot only: both pilot suites now list `conditions` from `pilot/common.mjs` (C0, C0V, C1, C3min, C3), so C2 and the matched-budget baseline are out of the pilot (90 trials a suite; 360 to 936 attempts over both combinations, from 576 to 1,440). The default for any other suite stays every condition. Decision 6's primary comparison (C3min against C0V) goes into the pre-registration.
