# 25: Redraw the workflow diagram

**What to build:** Replace the superseded deck-era workflow diagram with one drawn from the spec, so the docs no longer show a web platform, inference engines or a Tester agent.

**Blocked by:** 10

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · medium

- [ ] Shows the reference scenario: plan (Claude Code) → implement (Codex; hidden tests) → review (OpenCode; send-back) → approval gate → AHP pushes or opens a PR
- [ ] Shows verification in a verification worktree, the ledger, retry with handoff revisions, and the `unknown` → `needs_recovery` path
- [ ] Uses glossary terms only; no web platform, inference engines, per-tool-call policy, Tester or sandbox
- [ ] Superseded banner and CLAUDE.md note removed
