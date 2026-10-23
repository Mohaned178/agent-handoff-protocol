# 11: Capabilities, network stance, model and usage reporting

**What to build:** Adapters declare what they can apply on each OS and how strongly; steps request capabilities and a network stance; the runtime rejects handoffs that cannot be satisfied and every report shows the enforcement level actually applied, the requested vs reported model, and usage labelled with its source.

**Blocked by:** 02

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Adapter contract static declaration: transport kind, model reporting level (enumerable / pass-through / not exposed), graceful cancel support, capabilities with enforcement level per OS, required login kind
- [ ] Steps declare capability requests and a network stance (default `deny`; implement may opt in to package registries)
- [ ] Rejection reason "capability unsatisfiable at the required enforcement level on this OS"
- [ ] Each attempt records applied capabilities with `enforced_by_tool | cooperative | none`; reports show them
- [ ] Each attempt records `requested_model` and `reported_model` (`unknown` when not reported)
- [ ] Usage is recorded only when the adapter reports it, with its source; never estimated
- [ ] Docs and messages never describe prompt instructions or ACP permission requests as enforcement
