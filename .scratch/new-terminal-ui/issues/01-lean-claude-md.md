# 01: A lean CLAUDE.md

**Implement with:** Sonnet 5.5, effort medium

**What to build:** `CLAUDE.md` is 70 KB, and every agent reads it before every ticket. Most of it is the history of each
ticket. Cut it to what an agent needs in order to work correctly, so the tickets that follow are cheaper and better
implemented.

**Blocked by:** 00

**Status:** done (2026-11-01)

- [x] Keep: commands, code layout (one paragraph per module), the rules the design depends on, platform facts, the test
      conventions (fake clock, `GONE_PID`, mock scripts and retry budget, fakes for every real tool), the open decisions
      pointer, the agent-skills section
- [x] Move the per-ticket detail into the module docs it describes (`docs/how-it-works.md`, `docs/adapters/*.md`,
      `docs/evaluation.md`) or leave it to the tickets in `.scratch/`, which already hold it; nothing true is lost:
      each fact removed from CLAUDE.md is either in a doc it links to or in the code's own comments
- [x] Target: under 15 KB; each module paragraph ends with "details: <doc>"
- [x] The terminal-layer paragraphs (`live.ts`, `decideHere`, `ahp setup`, the one-command run's CLI details) shrink to
      one line pointing at `.scratch/new-terminal-ui/spec.md`, since that layer is being replaced
- [x] The inference evaluation stays: the scope lines naming ADR 0007 and, once it exists, the `src/inference/` module
      paragraph (details: `docs/inference-evaluation.md`)
- [x] No code changes; `npm test` still passes (some tests read docs)

## Implementation notes (2026-11-01)

1. **Size:** 86,780 bytes to 14,961 bytes. The long form is kept in git at commit `644ff82` and is the record of
   anything not named below.
2. **No doc was extended.** The per-ticket detail was left to the tickets (the second option of the second checkbox);
   each module paragraph points to the tickets that hold it. Some details of the usability fixes from the first-user test
   (2026-10-28) and the compact view are only in the old CLAUDE.md, now at `644ff82`, and in the code; the terminal
   layer they describe is replaced by this feature, so they were not moved.
3. **Inference evaluation:** `docs/inference-evaluation.md` does not exist yet (inference ticket 07), so the `inference`
   paragraph points at ADR 0007 and `.scratch/inference-evaluation/spec.md` and names the doc as coming. Change it when 07
   lands.
4. **Branch:** `inference-evaluation` has not been merged into `main`, so `new-terminal-ui` was made from its head (it
   contains `main`). Rebase onto `main` once the inference work is merged. The uncommitted files of inference ticket 00
   were left out of the commit.
5. **Tests that read docs:** none read CLAUDE.md. `npm run typecheck` is clean. Two full `npm test` runs on Windows each
   had 60 s timeouts in the slow evaluation tests (`bench-verified`, `evaluation-metrics`, `evaluation-schedule`), a
   different test each time; the three files pass when run alone (21 tests). They are unrelated to this change and
   look load-dependent.
