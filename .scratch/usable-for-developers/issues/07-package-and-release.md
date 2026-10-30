# 07: Publish 0.1.0

**What to build:** `npm i -g <package>` installs a prebuilt `ahp` (spec D1, D2), published from a tagged CI job on a
green commit, with a changelog.

**Blocked by:** 01 (green CI), 05 (no blocker left), 06 (the docs the package points to); spec D1 to D3 decided

**Status:** planned

- [ ] `package.json`: the name from D1, version 0.1.0, `private` removed, `repository`, `homepage`, `bugs`, `keywords`,
      `license`; `files` holds `bin`, `dist`, `schemas`, `README.md`, `LICENSE` and nothing else (`npm pack --dry-run`
      checked by a test or a CI step)
- [ ] Prebuilt: `prepare` no longer builds on install from the registry (it may still build for a GitHub install);
      `prepublishOnly` runs typecheck, tests and build
- [ ] A release workflow on a `v*` tag: build, test on the three systems, `npm publish --provenance --access public`
      with an npm token in the repository's secrets (the maintainer creates the token; AHP never sees it)
- [ ] `CHANGELOG.md` from 0.1.0, written for users (what changed for them), not a commit list
- [ ] `ahp --version` prints the version and "alpha"; the README says alpha (D3)
- [ ] The installed package checked from outside the repository on Windows and in WSL2: install, `ahp doctor`,
      `ahp demo`, uninstall
- [ ] *Decision for this ticket:* whether to tell users when a newer version exists. Recommendation: no automatic
      check (it is a network call AHP does not otherwise make, spec D6); the changelog and GitHub releases say it

## Notes

- `agent-handoff-protocol` and `ahp` are other people's packages on npm (checked 2026-10-31); `@mohaned178/ahp`,
  `ahp-cli` and `ahp-agents` were free that day.
