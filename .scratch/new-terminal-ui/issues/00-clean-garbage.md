# 00: Clean the garbage

**Implement with:** Haiku 5.5, effort low

**What to build:** Nothing new. Remove what is left over from development and dogfooding, so the rebuild starts from a
clean tree. Each item was found on 2026-10-31; look at each before removing it.

**Blocked by:** the maintainer's yes on the list below

**Status:** done (2026-10-31, commit b5521be)

Local, ignored by git (not in any commit):
- [x] `ahp.workflow.mjs`, `ahp-runs.workflow.mjs`, `ahp-slug.workflow.mjs`, `new-ahp.workflow.mjs`,
      `new-new-ahp.workflow.mjs` at the root (old dogfood workflows, 28 to 29 Oct)
- [x] `smoke-run/` (two evaluation directories from a smoke run)
- [x] `dist/` (a stale build from 28 Oct; `npm run build` remakes it)

Git:
- [x] Local branches merged into `main`: `ahp/add-a-no-check-option`, `ahp/add-help-as-a-command`,
      `ahp/add-test-troubleshooting-test-ts`, `ahp/refactor-with-no-change-in` (`git branch -d`, which refuses an
      unmerged one)
- [x] Remote branch `origin/ahp/smarter-slug`: kept, by the maintainer's decision (2026-10-31)
- [x] The 25 attempt worktrees under `C:\Users\pc\AppData\Local\ahp\worktrees\` whose runs have ended
      (`git worktree remove --force`, then `git worktree prune`); first list each run's state with `ahp runs` and keep
      any run that waits for a person. Snapshots under `refs/ahp/` and the ledgers stay (`ahp inspect` needs them)

Tracked, ask before removing:
- [x] `skills-lock.json`: a lock of agent skills installed from `mattpocock/skills`, not used by AHP; move out of the
      repository or keep, the maintainer decides
- [x] `AHP-presentation.pdf` (350 KB, the superseded original deck): move to `docs/design/` or keep at the root

Done when:
- [x] `git status` is clean apart from the intended deletions, `npm run typecheck` and `npm test` pass
- [x] One commit, `chore: remove leftovers` (b5521be), listing what was removed
