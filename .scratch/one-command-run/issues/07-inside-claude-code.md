# 07: AHP from inside Claude Code (later)

**What to build:** A way to hand a task to AHP without leaving Claude Code, for people who live there: "run this through
AHP" in a Claude Code session starts a one-command run and reports its receipt.

**Blocked by:** 02, 04, and a decision on the form

**Status:** idea, not scheduled

- [ ] Decide the form: an MCP server exposing `run_task`, `run_status`, `approve`, `reject`; or a Claude Code plugin with
      a slash command that calls `ahp "<task>" --yes`; or a skill. The approval must stay a person's (ADR 0003): a tool
      call an agent can make is not a person approving
- [ ] Whichever form: the approval is shown to the person in the terminal or a page, never answered by the model
- [ ] Documented as an integration, not an adapter: Claude Code is the caller here, not a step's agent

## Notes

- Not before tickets 02 and 04: there is nothing worth calling until a run is one sentence and its result is readable.

## Recommendation (2026-10-31), awaiting the maintainer

Observed in a Claude Code session (2.x, 2026-10-31): the commands it runs get `CLAUDECODE` and `AI_AGENT` in their
environment and no terminal on stdin.

1. **Form: a skill, not an MCP server.** One `SKILL.md` shipped in this repository (for example
   `integrations/claude-code/ahp/SKILL.md`, copied to `~/.claude/skills/` or packed as a plugin later). It tells Claude
   Code to run `ahp "<task>" --yes` (with any `--implement`/`--review`/`--check` flags the person named) in the
   background, relay the summary, and when the run stops at the gate (exit code 4) relay the receipt and tell the person
   the exact `ahp approve` / `ahp reject` command to run **in their own terminal**; it never runs either itself. An MCP
   server would need an `approve` tool, which is a model approving, or a long-running process for no gain.
2. **AHP side: `ahp approve` and `ahp reject` refuse inside a coding agent's session** (`CLAUDECODE` or `AI_AGENT`
   set, and a marker AHP sets for its own step agents), saying to run them in your own terminal. Documented as
   cooperative: an agent can unset a variable, so this is a guard against an agent approving by mistake, never
   enforcement (ADR 0003). It also stops one of AHP's own step agents approving its run.
3. **Documented as an integration, not an adapter** (Claude Code is the caller here, not a step's agent), in
   `docs/integrations/claude-code.md`.

Cost: one markdown file, a guard of a few lines with its tests, one doc page; no new dependency.
