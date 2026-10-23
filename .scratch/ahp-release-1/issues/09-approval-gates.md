# 09: Approval gates and `ahp approve` / `ahp reject`

**What to build:** A run reaching an approval gate stops in `waiting_approval` and the runtime process exits. The human approver inspects what they are approving, then runs `ahp approve` to resume or `ahp reject --reason` to send back the preceding agent step.

**Blocked by:** 05, 08

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Approval gate is a step kind with no coding agent; step state `ready → waiting_approval → succeeded | failed`
- [ ] Run enters `waiting_approval` and the runtime process exits
- [ ] `ahp inspect` shows the verified diff, verification evidence and review findings for a waiting gate
- [ ] `ahp approve <run> <step>` takes the lock, records the decision and resumes the run
- [ ] `ahp reject <run> <step> --reason` records the decision and sends back the preceding agent step with the reason as evidence
- [ ] Decisions record who and when; commands refuse when the step is not waiting
- [ ] Approve and reject only; there is no edit
