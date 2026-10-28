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
- **Still not met: "Every adapter passes on at least one OS".** Decision taken (recommendation adopted): a subject may declare scenarios its tool cannot be made to do (`ConformanceSubject.unprovokable`); their checks are recorded `unprovokable` (new `CheckStatus`, no suite bump since it only loosens), do not block `passed` and are named on the cell. Declared for `claude-code` (`rate_limited`, `no_model_report`, `no_usage_report`). No cell is `passed` yet because that needs a real re-run by the maintainer (`npm run conformance -- run claude-code`, then `matrix --write`); codex now requests no model (`requestedModel: null`, new) so `model:reported` is a report and not an echo, and declares the same three unprovokable, so it too needs only a real re-run; opencode still requests its free-tier model (an unpinned default may not be free, unconfirmed) so `model:reported` is skipped as an echo, and `failure:agent_error` and `failure:config_auth` have no provokers; Gemini CLI has never run (ticket 19).
