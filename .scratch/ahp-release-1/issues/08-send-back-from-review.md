# 08: Send-back from review

**What to build:** A review step that returns "changes requested" sends back the immediately preceding agent step, with the findings attached as evidence in a new handoff revision, spending that step's retry budget (ADR 0004). Review steps outside evaluation are labelled as structural verification.

**Blocked by:** 04

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Review steps output a verdict `approved | changes_requested` plus findings as required output fields
- [ ] `changes_requested` returns the preceding agent step to `ready` with a new revision carrying the findings
- [ ] Send-back spends the preceding step's `verification_failed` budget; exhausted → run fails
- [ ] Static validation rejects send-back further than one step back
- [ ] Reports label review verification "structural verification"
