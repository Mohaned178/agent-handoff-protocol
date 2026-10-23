# 16: Codex adapter

**What to build:** A developer can assign steps to Codex CLI through the transport the spike chose (Codex SDK or `codex exec --json`), passing the conformance suite.

**Blocked by:** 12, 14

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Uses the spike's chosen transport; never `codex app-server`
- [ ] Sandbox and approval settings mapped to capabilities, with enforcement levels measured per OS, not copied across
- [ ] Requested vs reported model and usage recorded where emitted
- [ ] Passes the conformance suite on Windows native and Linux (WSL2); results recorded as matrix cells
