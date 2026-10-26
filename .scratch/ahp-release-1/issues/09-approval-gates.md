# 09: Approval gates and `ahp approve` / `ahp reject`

**What to build:** A run reaching an approval gate stops in `waiting_approval` and the runtime process exits. The human approver inspects what they are approving, then runs `ahp approve` to resume or `ahp reject --reason` to send back the preceding agent step.

**Blocked by:** 05, 08

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [x] Approval gate is a step kind with no coding agent; step state `ready → waiting_approval → succeeded | failed`
- [x] Run enters `waiting_approval` and the runtime process exits
- [x] `ahp inspect` shows the verified diff, verification evidence and review findings for a waiting gate
- [x] `ahp approve <run> <step>` takes the lock, records the decision and resumes the run
- [x] `ahp reject <run> <step> --reason` records the decision and sends back the preceding agent step with the reason as evidence
- [x] Decisions record who and when; commands refuse when the step is not waiting
- [x] Approve and reject only; there is no edit

## Comments

2026-10-26, implementation notes.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **A gate is declared `{ id, approval: {} }`** and takes nothing else (no `agent`, `verification`, `retry`…: validation names each). It cannot be the first step or follow another gate, because a rejection sends back the step immediately before it and that step must have a coding agent (ADR 0004); a review's `sendBackTo` cannot name a gate. *Recommended: keep.*
2. **A rejection sends back the step immediately before the gate, as ADR 0004 and the ticket say. In the reference scenario (plan → implement → review → gate) that is the review, not implement:** the review is run again under a new handoff revision carrying the approver's reason, and if it then asks for changes, its own send-back reaches implement. I did not invent a walk-back through the review. To reject straight to implement, put the gate before the review. *Recommended: keep; if the reference scenario should reject to implement, that is a new decision and an ADR 0004 amendment.*
3. **The request is bound to the verified result.** `approval_requested` records the attempt, its snapshot commit and the paths changed between the **run's base commit** and that commit (what a later push would publish; ticket 10 needs the approved commit). `ahp inspect` adds the unified diff of the same range, read from the pinned snapshot (never a worktree; no external diff or textconv program runs; 64 KiB shown), the attempt's verification evidence, and the findings of every review before the gate. *Recommended: keep the run-base range; per-step diffs would hide earlier steps' changes from the approver.*
4. **A step after a gate receives the result of the agent step before it** (`senderIndex` looks through gates): its base commit, handoff `from` and context fields are that step's. *Recommended: keep.*
5. **The approver's reason reaches the agent whole, as `approval_rejected` evidence, without the approver's name** (the ledger and `ahp inspect` have it). It stays with the step if the next attempt fails verification and is retried, like a review's findings. *Recommended: keep.*
6. **A rejection with none of the preceding step's retry budget left fails the gate (`verification_failed`) and the run**, as a review does (ticket 08, decision 4); the decision is still recorded. It is not refused up front: "do not ship this" is a legitimate answer. *Recommended: keep.*
7. **Exit code 4 is a run stopped at an approval gate** (3 stays a recovery decision), from `ahp run`, `recover`, `approve` and `reject`. *Recommended: keep.*
8. **`ahp approve`/`ahp reject` are `approveStep`/`rejectStep` in the SDK**, take the same options as `recoverAttempt` (a reject runs an agent in the deciding process, so Ctrl+C cancels it), and record `run_resumed` before the decision. A decision cut off before the run moved on is finished by `ahp recover <run>`; deciding again is refused with that hint. *Recommended: keep.*

**Shapes:**

- Protocol: `ApprovalGateDefinition`, `WorkflowStepDefinition` (agent-step `StepDefinition` keeps its name), `isApprovalGate`, `StepState` gains `waiting_approval`, `StepView.kind` (`agent | review | approval_gate`) and `StepView.approvals`, three events (`approval_requested`, `approval_decided { decision, reason, user }`, `approval_sent_back`), `AttemptView.sentBack` is now a union of `{ kind: "review", … }` and `{ kind: "approval", gateStepId, reason, user, decidedAt }`, and the handoff evidence kind `approval_rejected` (schema regenerated).
- Replay enforces the rules: a request only for a ready gate after a succeeded, verified step, once, not after a cancel; a decision once per request, a rejection with a non-blank reason; a send-back only of the step immediately before, spending its retry; a gate `succeeded` only after an approval and `failed` only after a rejection; no handoff or attempt for a gate.
- The executor's `advanceGate` is a case of state → next action like the rest: `blocked → step_ready → approval_requested` (run `waiting_approval`, `drive` returns, the process exits and releases the lock), and, once a decision is recorded, `step_terminal succeeded`, `approval_sent_back` or `step_terminal failed`. `decideApproval` lives in `src/runtime/approval.ts`.

**Not done:**

- Nothing waits for or notifies the approver; no timeout on a request (`waiting_approval` is the state, per the spec).
- The diff is truncated at 64 KiB in `inspect` (`git diff` gives the rest); binary files show as git shows them.
- Evaluation runs have no gates (ticket 20 enforces that; nothing in the workflow format forbids one yet).
- External actions (ticket 10) will read the approved commit from the request; the check that the commit pushed is the approved one is theirs.

**Confirmed by the maintainer on 2026-10-26 ("do recommendation"): decisions 1 to 8 above stand as recommended; reopen one only with a new decision.**
