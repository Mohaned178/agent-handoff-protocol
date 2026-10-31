# 09: Production basics

**What to build:** What a tool that developers depend on needs besides working: a promise about versions, a way to
report a security problem, a way to report a bug that gets the facts, and no lost runs on upgrade.

**Blocked by:** 07 (there is a published version to make promises about)

**Status:** done (2026-10-31) except what waits for the published version: nothing is published yet

- [x] Versioning policy in the README: semver for the CLI and SDK; 0.x may break with a changelog entry saying how to
      move; the protocol and ledger versions are separate and a run recorded by an older AHP still replays or is
      refused with a message naming the version (never misread)
- [x] A test that ledgers written by the previous release replay with the new one (fixtures kept per release)
- [x] `SECURITY.md`: how to report privately (GitHub security advisories), what is in scope (AHP's own code, the
      ledger, external actions), and the limits already in `docs/limits.md` (a worktree is not a security boundary)
- [x] Issue templates: bug (asks for `ahp --version`, `ahp doctor --json` with nothing secret in it, the OS, the
      command and its output) and feature request; `ahp doctor` prints what a bug report needs
- [x] A support statement: alpha, maintained by one person, answered on GitHub issues, no guarantee of response time
- [x] `npm audit` clean in CI on the published dependencies; dependabot (or renovate) for them
- [x] *Decision for this ticket:* a code of conduct and contribution guide beyond ticket 08's section.
      Recommendation: the Contributor Covenant as is, and CONTRIBUTING.md with setup, tests and the ticket flow

## Notes

- Nothing here adds telemetry (spec D6).

## Implementation notes (2026-10-31)

- Versioning and support: the README's "Versions and support". Replay now refuses a run recorded under a newer
  protocol (`isNewerProtocol`, `src/protocol/version.ts`: a higher major, or a higher minor under 1.0) with both
  versions named, and reads any older one.
- `test/ledger-releases.test.ts` replays every ledger under `test/fixtures/ledgers/<version>/` and checks it against
  what it must replay to; 0.1.0's is an approved `ahp demo` run (send-back, gate, push; it names the Windows user
  "pc" in its paths, which cannot be edited without breaking the chain). CONTRIBUTING.md's release steps add one per
  release.
- `SECURITY.md` (private advisories, scope, the limits as out of scope); `.github/ISSUE_TEMPLATE/` (bug asks for the
  version, system, command, output and `ahp doctor --json`; feature; blank issues off, links to the advisory and
  troubleshooting). `ahp doctor` now starts with `ahp <version> (alpha)` (JSON: `ahp`) and ends with where a bug
  goes and what to attach.
- CI runs `npm audit --omit=dev` on Ubuntu (clean on 2026-10-31); `.github/dependabot.yml` for npm (weekly, dev
  dependencies grouped) and actions (monthly).
- Decision (recommendation taken): `CODE_OF_CONDUCT.md` adopts the Contributor Covenant 2.1 by reference (its text
  is linked, not copied); reports by email to the address on the maintainer's GitHub profile. CONTRIBUTING.md has
  setup, tests, the ticket flow and releasing.
