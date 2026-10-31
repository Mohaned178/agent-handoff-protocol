# 08: Platform coverage

**What to build:** Each adapter's support-matrix cell recorded where the maintainer can record it, and a clear way for
a Mac user to record macOS, so the README's "tested on" is as wide as it can honestly be.

**Blocked by:** none (independent of the rest); needs the maintainer's logins

**Status:** in progress (2026-10-31): the docs and the generated table are done; the WSL2 suites need the maintainer's logins

- [ ] Codex and OpenCode conformance suites run in WSL2 (`npm run conformance -- run codex|opencode`), results
      recorded, `docs/support-matrix.md` regenerated
- [ ] `ahp "<task>"` run once in WSL2 with each tool (part of ticket 04's runs is enough)
- [x] `CONTRIBUTING.md` (or a section of it): how someone with a Mac runs the conformance suite and sends the result
      file in a pull request; until one arrives, macOS stays "untested" everywhere
- [x] The README's "Supported tools" table read from the support matrix, not written by hand

## Notes

- Never claim an adapter works on a system it was not tested on (CLAUDE.md, platform facts).

## Implementation notes (2026-10-31)

- CONTRIBUTING.md, "Recording a system the maintainer cannot": the steps for a Mac (or native Linux) user, from login
  to a pull request with the result file and the regenerated pages.
- The README's table is generated: `renderSupportedTools`/`withSupportedTools` (`src/conformance/publish.ts`)
  write it between the `supported-tools` markers from the same cells as the matrix, naming a system only where the
  cell is `passed`; `npm run conformance -- matrix --write` (no file named) rewrites it with the matrix page, and
  `test/support-matrix.test.ts` fails when it is stale. The column is now "Conformance suite passed on".
- Left for the maintainer: `npm run conformance -- run codex|opencode` in WSL2, then `matrix --write`; one
  `ahp "<task>"` per tool in WSL2 (with ticket 04).
