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
