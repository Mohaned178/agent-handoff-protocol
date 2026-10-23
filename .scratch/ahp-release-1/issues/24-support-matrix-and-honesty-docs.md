# 24: Support matrix publication and honesty docs

**What to build:** The published support matrix and the user-facing docs that state AHP's limits plainly.

**Blocked by:** 15, 16, 18, 19

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · medium

- [ ] Matrix shows core OS support (CI) separately from adapter × OS cells
- [ ] Adapter cells for Windows and "Linux (WSL2)" filled from recorded conformance results with tool version and date; macOS adapter cells marked untested
- [ ] Every adapter passes on at least one OS; any cell without a recorded result is untested
- [ ] Docs: a worktree is workspace isolation, not a security boundary; verification runs agent-written code on the host; subscription use falls under each vendor's terms; AHP stores no credentials
