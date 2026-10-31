# 06: Reflection

**What to build:** Condition `C3r`: plan → implement → reflect → review. In the reflect step, the implement agent
critiques its own result against the task and constraints, and fixes it.

**Blocked by:** none

**Status:** open

- [ ] `reflect` is an ordinary agent step:
  - cast to the implement agent
  - requires `summary`, `decisions`, `constraints` and `reflection`
  - verified by the acceptance check, with the suite's retry budget
- [ ] Review's `sendBackTo` stays the step immediately before it (`reflect`), as the protocol requires
- [ ] `CONDITIONS`, condition names (report and wizard), casting, `GATED_CONDITIONS`, `workflowFor`
- [ ] `COMPARISONS`: `C3r vs C3`
- [ ] Tests: the workflow's shape, a run end to end on the mock
