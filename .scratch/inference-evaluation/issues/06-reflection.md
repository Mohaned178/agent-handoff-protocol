# 06: Reflection

**Implement with:** Sonnet 5.5, effort medium

**What to build:** Condition `C3r`: plan → implement → reflect → review. In the reflect step, the implement agent
critiques its own result against the task and constraints, and fixes it.

**Blocked by:** none

**Status:** done (2026-11-01)

- [x] `reflect` is an ordinary agent step:
  - cast to the implement agent
  - requires `summary`, `decisions`, `constraints` and `reflection`
  - verified by the acceptance check, with the suite's retry budget
- [x] Review's `sendBackTo` stays the step immediately before it (`reflect`), as the protocol requires
- [x] `CONDITIONS`, condition names (report and wizard), casting, `GATED_CONDITIONS`, `workflowFor`
- [x] `COMPARISONS`: `C3r vs C3`
- [x] Tests: the workflow's shape, a run end to end on the mock

## Implementation notes (2026-11-01)

1. `reflect` is added inside the existing C2/C3min/C3/C3c case of `workflowFor` rather than a case of its own, so its words and capability requests stay shared with C3.
2. Its instructions (`REFLECT_TEXT`) name the decisions and constraints it was handed, ask for a fix, and ask for C3's fields and a `reflection`. C3r's other steps keep C3's words.
3. The pilot suites and `pilot/local/common.mjs` do not run C3r: choosing conditions for the real run is the maintainer's (ticket 07).
4. A mock agent source serves two steps of C3r, and its scripts are indexed per step, so tests give one script that reports both steps' fields.
