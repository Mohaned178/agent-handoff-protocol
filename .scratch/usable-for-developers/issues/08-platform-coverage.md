# 08: Platform coverage

**What to build:** Each adapter's support-matrix cell recorded where the maintainer can record it, and a clear way for
a Mac user to record macOS, so the README's "tested on" is as wide as it can honestly be.

**Blocked by:** none (independent of the rest); needs the maintainer's logins

**Status:** planned

- [ ] Codex and OpenCode conformance suites run in WSL2 (`npm run conformance -- run codex|opencode`), results
      recorded, `docs/support-matrix.md` regenerated
- [ ] `ahp "<task>"` run once in WSL2 with each tool (part of ticket 04's runs is enough)
- [ ] `CONTRIBUTING.md` (or a section of it): how someone with a Mac runs the conformance suite and sends the result
      file in a pull request; until one arrives, macOS stays "untested" everywhere
- [ ] The README's "Supported tools" table read from the support matrix, not written by hand

## Notes

- Never claim an adapter works on a system it was not tested on (CLAUDE.md, platform facts).
