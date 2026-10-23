# 14: Transport spike on native Windows

**What to build:** A dated written report, per tool, comparing its vendor-maintained transport options on native Windows (ADR 0001), so that each adapter's transport is chosen on evidence. Run under the maintainer's own logins; Gemini CLI only if paid access is available, otherwise recorded as not run.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] For each tool and candidate transport: cancellation behaviour, permission requests, model listing/reporting, usage reporting, output stability, exit/stop semantics
- [ ] Claude Code: headless `claude -p` stream-json, including how hooks and deny rules behave on Windows
- [ ] Codex: Codex SDK vs `codex exec --json`, with a recommendation; app-server not evaluated
- [ ] OpenCode and Gemini CLI: native ACP vs headless
- [ ] Records tool versions, date, and whether each tool's sandbox/enforcement differs on native Windows
- [ ] Records approximate usage per attempt where reported, as input to the pilot budget
- [ ] Every unconfirmed point marked as such; no mock results

## Implementer notes

- Run each tool by hand-written throwaway scripts in a scratch folder, not inside AHP's source; the report is the deliverable.
- Use a tiny disposable git repo per experiment; never point a tool at a real project.
- If a tool asks for login, payment, or a terms acceptance, stop and ask the user; never log in or accept on their behalf.
- Keep calls few (a handful per tool) so usage stays within normal individual use.
