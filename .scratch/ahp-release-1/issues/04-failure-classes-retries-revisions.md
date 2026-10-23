# 04: Failure classes, retries and handoff revisions

**What to build:** When an attempt fails, the runtime classifies it and retries within budget. A failed verification is retried with its evidence attached in a new handoff revision; a transient failure is retried with backoff under the same revision. Exhausted budgets reroute when configured, otherwise the step fails.

**Blocked by:** 02, 03

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · xhigh

- [ ] Failure classes: `rejected`, `config/auth`, `transient`, `agent_error`, `verification_failed`, `inconclusive`, `unknown`
- [ ] `rejected` and `config/auth`: no retry; `config/auth` surfaced to the user
- [ ] `agent_error` + `verification_failed` share a default budget of 2 retries per step; configurable
- [ ] `transient` has a separate default budget of 5, exponential backoff, capped total wait
- [ ] `inconclusive`: validator re-run once, then escalate
- [ ] Same-input retry = new attempt under the same revision; changed-input retry = new revision, old one `superseded`
- [ ] Idempotency key is (handoff ID, revision, attempt ID); every retry gets a new workspace
- [ ] Reroute to an alternative adapter under the same contract, off by default
- [ ] `unknown` is never retried (handling arrives in 06)

## Implementer notes

- Make time injectable (a clock and a sleep function passed to the runtime) so backoff tests run instantly; tests must never really sleep.
- Write one test per failure class using a mock script that produces it, asserting the resulting attempt count, revisions and final step state from the ledger.
- Classification is a pure function from an ended attempt (exit code, stop reason, adapter-reported error kind, verdict) to a failure class; test it as a table.
- Budgets are counted from ledger events by replay, never from in-memory counters, so a restart sees the same remaining budget.

## Comments

2026-10-24, from ticket 01: as a placeholder, `src/runtime/run.ts` ends the step as `failed` / `agent_error` when the agent exits non-zero and skips verification (the snapshot is still committed). Your notes include `verdict` as a classification input, so decide deliberately whether a non-zero exit still gets verified, and replace the placeholder rather than inheriting it.
