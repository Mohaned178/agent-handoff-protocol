# 08: Send-back from review

**What to build:** A review step that returns "changes requested" sends back the immediately preceding agent step, with the findings attached as evidence in a new handoff revision, spending that step's retry budget (ADR 0004). Review steps outside evaluation are labelled as structural verification.

**Blocked by:** 04

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [x] Review steps output a verdict `approved | changes_requested` plus findings as required output fields
- [x] `changes_requested` returns the preceding agent step to `ready` with a new revision carrying the findings
- [x] Send-back spends the preceding step's `verification_failed` budget; exhausted → run fails
- [x] Static validation rejects send-back further than one step back
- [x] Reports label review verification "structural verification"

## Comments

2026-10-26, implementation notes.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **A review step is declared with `review: { sendBackTo: "<step id>" }`.** The ticket's "rejects send-back further than one step back" only means something if the target is named, so the property names it and validation insists it is the step immediately before (and rejects a first step, an unknown step, itself and a later one). Its `verification` is still an object, so a review writes `verification: {}`. *Recommended: keep.*
2. **`verdict` and `findings` are required of every review step without being listed** (`requiredOutputFieldsOf`, added to whatever `verification.requiredOutputFields` lists). They are in the handoff's acceptance contract, and handed on as context to the next step, which is what ticket 09's gate will show. A required field is present only when non-blank, so an approving review must still write something in `findings`. *Recommended: keep. Making `findings` optional on approval would mean the next step's `requires` could not list it.*
3. **A verdict that is neither `approved` nor `changes_requested` fails verification** (`review_verdict` evidence, `verdict: null`), and so does `changes_requested` with blank findings (the required-fields evidence), so a send-back never carries empty evidence. The reviewer is retried within its own budget and told the allowed values in a `review_verdict` handoff evidence. Whitespace around the verdict is ignored; case is not. *Recommended: keep.*
4. **A review that exhausts the preceding step's budget fails the review step as `verification_failed`, and the run fails.** The ticket and ADR 0004 say so; `reroute` is not offered (it would hand a verified, succeeded step to another agent). The failing step is the review's, not the sent-back step's, which stays `succeeded`: its own verification passed. `ahp` says "changes requested, and the retry budget of step X is spent, so it cannot be sent back again". *Recommended: keep.*
5. **The sent-back step starts again from its base commit, not from the result that was reviewed**, because a send-back is the existing `verification_failed` retry (ticket 04: every retry is a new workspace from the step's base commit). The findings reach the agent; the code they refer to does not. *Recommended: keep for now; if real reviews turn out to want the previous result, it is a change to `stepBase`, a new decision and an ADR note.*
6. **The review step's own retry usage is cumulative across rounds**, and its attempt numbers count across rounds, so a mock review that is sent through two rounds needs two scripts. *Recommended: keep (cheaper, and the review is not meant to be asked many times).*

**Shapes:**

- Protocol: `StepDefinition.review`, `REVIEW_VERDICTS`, `REVIEW_OUTPUT_FIELDS`, `requiredOutputFieldsOf` / `reviewVerdictOf` / `reviewFindingsOf` (`src/protocol/review.ts`), the `review_verdict` verification evidence, two handoff evidence kinds (`review_findings`, `review_verdict`; schemas regenerated), the `step_sent_back` event and `AttemptView.sentBack`.
- `step_sent_back { stepId, attemptId, reviewStepId, reviewAttemptId }` is its own event rather than a `retry_scheduled`/`attempt_failed`, which replay only accepts for an attempt that failed. The findings are not copied into it: replay reads them from the review attempt's reported output, and refuses the event unless the review's attempt passed verification, asked for changes with findings, and the target is the `succeeded` step immediately before. Replay's effects: the target goes `succeeded → ready` and spends `retryUsage.retries`; its sent-back attempt gets `sentBack` and a `retry` of change `evidence`, so the executor issues the next revision through the path a failed verification uses; the review step goes `blocked`. No attempt that passed is given a failure class.
- The review step, once its predecessor succeeds again, gets a **fresh first handoff** from the new sender (`handsOnLatestResult`): the one it was reviewed under pointed at the replaced attempt and snapshot.
- Reports: the commandless verification label already read "structural verification" (glossary); `ahp run` streams the send-back with the findings, `ahp inspect` shows `sent back by step … ` with them, the `review_verdict` evidence and the exhausted-budget line.

**Not done:**

- The handoff contract does not state the allowed verdicts; an adapter's prompt rendering (tickets 15, 16, 18, 19) must, or the workflow's `instructions` must. A wrong verdict is retried with the allowed values as evidence.
- "Outside evaluation" is not distinguished: nothing in evaluation exists yet (ticket 20). Whether a review inside evaluation gets a command is its decision.
- A review with a `verification.command` is verified by that command and is not labelled structural, since it is not.
- The approval gate's reject (ticket 09) reuses `step_sent_back`'s idea but not its event: a gate has no review attempt. It will need its own event and a handoff evidence kind for the approver's reason.
