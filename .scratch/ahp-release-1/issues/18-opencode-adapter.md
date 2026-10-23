# 18: OpenCode adapter (native ACP)

**What to build:** A developer can assign steps to OpenCode, driven through its native ACP mode, passing the conformance suite.

**Blocked by:** 12, 14

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Drives `opencode acp` over stdio; no third-party bridge
- [ ] Uses ACP `session/cancel` for graceful cancel; `request_permission` treated as cooperative only
- [ ] Model reporting level declared from what ACP session config exposes
- [ ] Tool-call log captured for recovery reports
- [ ] Passes the conformance suite on Windows native and Linux (WSL2); results recorded as matrix cells
