# 12: Adapter conformance suite and support matrix tooling

**What to build:** One conformance suite (seam 2) that any adapter can be run against, passing for the mock adapter in CI, plus tooling that records a run's results as a support matrix cell.

**Blocked by:** 07, 11

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Suite covers spawn and normalized events, graceful and forced cancel, failure classification, requested vs reported model, usage source labelling, and that each declared capability holds at its declared level
- [ ] Runs against the mock adapter in CI on all three OSes
- [ ] Can be run locally against a real adapter by the maintainer; never part of CI for real adapters
- [ ] Records a result per adapter × OS label (e.g. "Windows", "Linux (WSL2)") with tool version and date
- [ ] Mock results are labelled and excluded from the published matrix's evidence
