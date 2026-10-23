# 15: Claude Code adapter

**What to build:** A developer can assign steps to Claude Code. The adapter runs the unmodified `claude` binary headless under the user's existing login (ADR 0001) and passes the conformance suite on Windows and Linux (WSL2).

**Blocked by:** 12, 14

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [ ] Uses headless `claude -p` with stream-json output; never the Agent SDK; never adds or removes `--bare`
- [ ] Capabilities applied via settings, deny rules and `PreToolUse` hooks written as Node scripts; enforcement levels declared per OS from spike evidence
- [ ] Requested model passed through; reported model and usage recorded where emitted
- [ ] Cancellation recorded as forced on Windows headless
- [ ] Passes the conformance suite on Windows native and Linux (WSL2, worktrees in the Linux filesystem); results recorded as matrix cells
- [ ] Docs state subscription use falls under Anthropic's terms and is the user's responsibility
