# 24: Support matrix publication and honesty docs

**What to build:** The published support matrix and the user-facing docs that state AHP's limits plainly.

**Blocked by:** 15, 16, 18, 19

**Status:** in-progress (the third criterion is not met)

**Model:** Sonnet 5.5 · medium

- [x] Matrix shows core OS support (CI) separately from adapter × OS cells
- [x] Adapter cells for Windows and "Linux (WSL2)" filled from recorded conformance results with tool version and date; macOS adapter cells marked untested
- [ ] Every adapter passes on at least one OS; any cell without a recorded result is untested
- [x] Docs: a worktree is workspace isolation, not a security boundary; verification runs agent-written code on the host; subscription use falls under each vendor's terms; AHP stores no credentials

## Notes

- Published as `docs/support-matrix.md` (generated: `npm run conformance -- matrix --write`; `test/support-matrix.test.ts` fails when it is stale) and `docs/limits.md`.
- **Not met: "Every adapter passes on at least one OS".** No cell is `passed`: the suite skips checks no tool could be made to do (`failure:transient`, `model:not_reported`, `usage:not_reported`, and per adapter some more), so every recorded result is `untested`, and Gemini CLI has no result at all (ticket 19). The page says so and shows `untested`; nothing is rounded up. Closing this needs a decision: provokers for those checks, or a rule that a skipped check the tool cannot be made to do does not block `passed`.
