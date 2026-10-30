# 09: Production basics

**What to build:** What a tool that developers depend on needs besides working: a promise about versions, a way to
report a security problem, a way to report a bug that gets the facts, and no lost runs on upgrade.

**Blocked by:** 07 (there is a published version to make promises about)

**Status:** planned

- [ ] Versioning policy in the README: semver for the CLI and SDK; 0.x may break with a changelog entry saying how to
      move; the protocol and ledger versions are separate and a run recorded by an older AHP still replays or is
      refused with a message naming the version (never misread)
- [ ] A test that ledgers written by the previous release replay with the new one (fixtures kept per release)
- [ ] `SECURITY.md`: how to report privately (GitHub security advisories), what is in scope (AHP's own code, the
      ledger, external actions), and the limits already in `docs/limits.md` (a worktree is not a security boundary)
- [ ] Issue templates: bug (asks for `ahp --version`, `ahp doctor --json` with nothing secret in it, the OS, the
      command and its output) and feature request; `ahp doctor` prints what a bug report needs
- [ ] A support statement: alpha, maintained by one person, answered on GitHub issues, no guarantee of response time
- [ ] `npm audit` clean in CI on the published dependencies; dependabot (or renovate) for them
- [ ] *Decision for this ticket:* a code of conduct and contribution guide beyond ticket 08's section.
      Recommendation: the Contributor Covenant as is, and CONTRIBUTING.md with setup, tests and the ticket flow

## Notes

- Nothing here adds telemetry (spec D6).
