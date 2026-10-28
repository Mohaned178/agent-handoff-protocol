# 23: Pilot suite and terms-of-service review

**What to build:** A ready-to-run pilot suite of 5–8 authored tasks and a dated terms-of-service review per tool. Does not run the pilot: that waits for the pilot budget decision (design doc §9.9).

**Blocked by:** 21, 22

**Status:** implemented and committed; waiting on the maintainer to read OpenAI's and OpenCode's own terms and add them to the review

**Model:** Sonnet 5.5 · high

- [x] 5–8 tasks in small purpose-built repos, each with hidden tests, planted early constraints and, for review, seeded defects
- [x] Pilot configuration: 2 agent combinations, 3 repeats per cell
- [x] Suite freezes and runs end to end with the mock adapter
- [ ] Dated terms-of-service review in the docs for each of the four tools, covering automated/headless use with subscriptions and API keys (`docs/terms-review-2026-10-28.md`: written, with 38 quotes checked once by a script against the saved pages, which are not kept; **partly met**, since OpenAI's own terms and OpenCode's could not be retrieved and are listed as not retrieved: see decision 8)
- [x] Estimated pilot cost from spike usage numbers, stated as an estimate

## Implementer notes

- Each task must be solvable in under an hour by a competent developer, and its hidden tests must fail on the untouched fixture (proves they discriminate).
- Each planted constraint is stated once, early, in the task prompt, and checked deterministically at the end.
- The terms review quotes the relevant sentences with their URLs and the date read; it gives no legal conclusions.

## Decisions to confirm

Each with a recommendation; answer "do recommendation" to adopt them all.

1. **The pilot lives in `pilot/` at the repository root** (`tasks/`, `reference/`, two suite files, `common.mjs`), outside `src/` and `test/` so `tsc` and Vitest never see fixture files. *Recommended: adopt.* Docs: `docs/pilot.md`.
2. **Two combinations, as two suite files** (a suite casts one agent per role). A is the reference scenario's tools (plan Claude Code, implement Codex, review OpenCode); B rotates the roles (plan OpenCode, implement Claude Code, review Codex) so no tool has the same role in both. Gemini CLI is left out: it has never run a turn. *Recommended: adopt.*
3. **Six tasks** (`password-reset`, `orders-listing`, `csv-export`, `config-merge`, `retry-backoff`, `inventory-reservation`): plain Node, no dependencies, so no `install` and no network, verified by `node --test`, each with one or two planted constraints checked by a pattern or an invariant script in `hidden/`, and at least one seeded defect in the fixture that the hidden tests make a difference to. *Recommended: adopt.*
4. **Reference solutions and "violations" live in `pilot/reference/`, not in the task directories.** They prove the hidden tests discriminate and every constraint's check can fail; they are never frozen with a task nor given to an agent. *Recommended: adopt.*
5. **The suites leave `model`, `spendCap`, `maxIncidentRate` and `toolVersions` unset.** They are the budget decision (design doc §9, item 9, open until step 5), the very thing the pilot measures (the incident rate), or a day-of-the-pilot fact (versions). *Recommended: adopt, and set them when the budget is known.*
6. **Seeded defects are not scored** (ticket 20 only records them), so the pilot does not measure review detection and `docs/pilot.md` says so. *Recommended: keep; scoring them is a separate ticket if wanted.*
7. **The cost estimate is a floor in attempts and spike figures, with no dollar figure for Codex or OpenCode.** 468 to 1,044 attempts over the two combinations (the top is every trial using every attempt its budgets allow; a send-back spends only the implement step's retry budget, so a review can run up to 5 times in a C3 trial); Claude Code about $4.86 to $27.32 at the spike's list-price figures; Codex 10.3 to 41.6 million input tokens; the spike's tasks were trivial, so real attempts will cost more. *Recommended: adopt; re-estimate from the first real trials.*
8. **The terms review could not retrieve OpenAI's terms (HTTP 403 to `curl`, and 429 from the web archive) or OpenCode's own (404).** They are listed as not retrieved, with nothing filled in. *Recommended: the maintainer reads them in a browser before the pilot and adds the sentences to `docs/terms-review-2026-10-28.md`.*
9. **A discrepancy for the maintainer (not acted on):** Gemini CLI's own quota page now describes a free tier, for a Google login and for an API key, while the repository says in several places (spec, design doc §9 item 1, ticket 19, `docs/adapters/gemini-cli.md`, CLAUDE.md) that it needs paid access. *Recommended: try a free AI Studio API key with `npm run conformance -- run gemini-cli --only spawn_and_exit` before assuming paid access is needed; if it works, ticket 19 can finish without a paid plan, and the unpaid-use data terms (quoted in the review) apply.*
10. **The pilot's tests take about two minutes on Windows** (thirteen of the tests run trials: six per-task discrimination tests, six end-to-end tests and the freeze test); every condition runs end to end on `password-reset` only, C0 and C3 on the rest. *Recommended: adopt; trim further if CI time matters.*

**Confirmed by the maintainer on 2026-10-28 ("do recommendation"): decisions 1 to 10 above stand as recommended; reopen one only with a new decision.** Still open for this ticket, both the maintainer's to do: reading OpenAI's terms and OpenCode's own in a browser and adding what they say, with the date, to `docs/terms-review-2026-10-28.md` (decision 8; the fourth box stays unchecked until then), and trying a free Gemini API key as decision 9 suggests.

## Comments

- The full-size suite A (repeats 3, all five conditions, mock agents in place of the tools) was run by hand with `ahp eval --seed 7`: 163 trials were scored (all passes, no incident), interleaved with their baseline trials as scheduled, and then the evaluation stopped with `task_changed`, which is the freeze check working: two fixture comments were changed while the run was going, after a review of this ticket. It was not run again to the end; no report was kept, and mock results are not evidence.
- Not done, by the ticket: running the pilot. It waits for the budget decision.
