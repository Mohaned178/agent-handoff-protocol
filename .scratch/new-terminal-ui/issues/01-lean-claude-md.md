# 01: A lean CLAUDE.md

**Implement with:** Sonnet 5.5, effort medium

**What to build:** `CLAUDE.md` is 70 KB, and every agent reads it before every ticket. Most of it is the history of each
ticket. Cut it to what an agent needs in order to work correctly, so the tickets that follow are cheaper and better
implemented.

**Blocked by:** 00

**Status:** todo

- [ ] Keep: commands, code layout (one paragraph per module), the rules the design depends on, platform facts, the test
      conventions (fake clock, `GONE_PID`, mock scripts and retry budget, fakes for every real tool), the open decisions
      pointer, the agent-skills section
- [ ] Move the per-ticket detail into the module docs it describes (`docs/how-it-works.md`, `docs/adapters/*.md`,
      `docs/evaluation.md`) or leave it to the tickets in `.scratch/`, which already hold it; nothing true is lost:
      each fact removed from CLAUDE.md is either in a doc it links to or in the code's own comments
- [ ] Target: under 15 KB; each module paragraph ends with "details: <doc>"
- [ ] The terminal-layer paragraphs (`live.ts`, `decideHere`, `ahp setup`, the one-command run's CLI details) shrink to
      one line pointing at `.scratch/new-terminal-ui/spec.md`, since that layer is being replaced
- [ ] The inference evaluation stays: the scope lines naming ADR 0007 and, once it exists, the `src/inference/` module
      paragraph (details: `docs/inference-evaluation.md`)
- [ ] No code changes; `npm test` still passes (some tests read docs)
