# 22: Evaluation safeguards

**What to build:** Evaluation cannot silently overspend, produce numbers from flaky cells, or compare conditions that differ in hidden ways.

**Blocked by:** 11, 20

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · medium

- [ ] `ahp eval` stops starting new trials when reported spend reaches a configured cap; docs tell the evaluator to set provider-console spend limits
- [ ] A cell whose harness incident rate exceeds a configured threshold is marked invalid
- [ ] A suite is rejected if a task's network stance differs across conditions
- [ ] Tool versions are pinned per suite and recorded per trial; a version mismatch is reported
- [ ] Evaluation expects API-key logins configured in each tool, and says so in `ahp eval` output
