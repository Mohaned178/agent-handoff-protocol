# 07: Publish 0.1.0

**What to build:** `npm i -g <package>` installs a prebuilt `ahp` (spec D1, D2), published from a tagged CI job on a
green commit, with a changelog.

**Blocked by:** 01 (green CI), 05 (no blocker left), 06 (the docs the package points to); spec D1 to D3 decided

**Status:** prepared (2026-10-31): everything up to the publish itself; the tag, the npm token and the install check wait for the maintainer and for 05

- [x] `package.json`: the name from D1, version 0.1.0, `private` removed, `repository`, `homepage`, `bugs`, `keywords`,
      `license`; `files` holds `bin`, `dist`, `schemas`, `README.md`, `LICENSE` and nothing else (`npm pack --dry-run`
      checked by a test or a CI step)
- [x] Prebuilt: `prepare` no longer builds on install from the registry (it may still build for a GitHub install);
      `prepublishOnly` runs typecheck, tests and build
- [x] A release workflow on a `v*` tag: build, test on the three systems, `npm publish --provenance --access public`
      with an npm token in the repository's secrets (the maintainer creates the token; AHP never sees it)
- [x] `CHANGELOG.md` from 0.1.0, written for users (what changed for them), not a commit list
- [x] `ahp --version` prints the version and "alpha"; the README says alpha (D3)
- [ ] The installed package checked from outside the repository on Windows and in WSL2: install, `ahp doctor`,
      `ahp demo`, uninstall
- [x] *Decision for this ticket:* whether to tell users when a newer version exists. Recommendation: no automatic
      check (it is a network call AHP does not otherwise make, spec D6); the changelog and GitHub releases say it

## Notes

- `agent-handoff-protocol` and `ahp` are other people's packages on npm (checked 2026-10-31); `@mohaned178/ahp`,
  `ahp-cli` and `ahp-agents` were free that day.

## Implementation notes (2026-10-31)

- `package.json` is `@mohaned178/ahp` 0.1.0, public, with `publishConfig` (`access: public`, `provenance`); `files`
  lists bin, dist, schemas, README.md and LICENSE. `test/package.test.ts` runs `npm pack --dry-run --json
  --ignore-scripts` (the scripts would build) and refuses any other path.
- Prebuilt: npm runs `prepare` for a git or local install, never for the installed package from the registry, so
  `prepare` stays for the GitHub install and `dist/` is in the tarball. `prepublishOnly` runs typecheck, tests, build.
- `.github/workflows/release.yml`: on a `v*` tag, the tests on the three systems, then on Ubuntu a check that the tag
  names `package.json`'s version, `npm audit --omit=dev` and `npm publish --provenance --access public` with
  `NODE_AUTH_TOKEN: secrets.NPM_TOKEN`. Nothing has been tagged or published.
- `CHANGELOG.md`: 0.1.0 "(unreleased)"; date it in the release commit.
- `ahp --version` prints `0.1.0 (alpha)`; the README's note says alpha.
- Decision (recommendation taken): no update check. The README's support section says AHP sends nothing anywhere.
- The README's install line stays `github:Mohaned178/agent-handoff-protocol` until the package is published (a step
  of "Releasing" in CONTRIBUTING.md), so the README never names a package that does not exist yet.
- Left for the maintainer: create the npm token as the `NPM_TOKEN` secret, tag `v0.1.0` once 05 has no blocker, and
  the installed-package check on Windows and WSL2 (CONTRIBUTING.md, "Releasing", step 4).
