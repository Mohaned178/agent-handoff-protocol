# 23: Pilot suite and terms-of-service review

**What to build:** A ready-to-run pilot suite of 5–8 authored tasks and a dated terms-of-service review per tool. Does not run the pilot: that waits for the pilot budget decision (design doc §9.9).

**Blocked by:** 21, 22

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] 5–8 tasks in small purpose-built repos, each with hidden tests, planted early constraints and, for review, seeded defects
- [ ] Pilot configuration: 2 agent combinations, 3 repeats per cell
- [ ] Suite freezes and runs end to end with the mock adapter
- [ ] Dated terms-of-service review in the docs for each of the four tools, covering automated/headless use with subscriptions and API keys
- [ ] Estimated pilot cost from spike usage numbers, stated as an estimate

## Implementer notes

- Each task must be solvable in under an hour by a competent developer, and its hidden tests must fail on the untouched fixture (proves they discriminate).
- Each planted constraint is stated once, early, in the task prompt, and checked deterministically at the end.
- The terms review quotes the relevant sentences with their URLs and the date read; it gives no legal conclusions.
