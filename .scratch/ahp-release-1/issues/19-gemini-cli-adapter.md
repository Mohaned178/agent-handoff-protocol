# 19: Gemini CLI adapter (native ACP)

**What to build:** A developer with paid Gemini access (API key or Code Assist licence) can assign steps to Gemini CLI, driven through its native ACP mode, passing the conformance suite. Needs paid access to test; schedule last among adapters.

**Blocked by:** 12, 14

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Drives `gemini --acp`; no third-party bridge
- [ ] Uses ACP `session/cancel` for graceful cancel; `request_permission` treated as cooperative only
- [ ] `doctor` and docs state that Gemini CLI needs paid access
- [ ] Tool-call log captured for recovery reports
- [ ] Passes the conformance suite on Windows native and Linux (WSL2); results recorded as matrix cells
