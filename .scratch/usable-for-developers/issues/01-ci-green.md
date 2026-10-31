# 01: CI green on all three systems, and kept green

**What to build:** A CI run that passes on Windows, Linux and macOS, and a habit that keeps it so, because a release
(ticket 07) is cut only from a green commit.

**Blocked by:** none

**Status:** done (2026-10-31; first green run 41146259771)

- [x] The two tests that exceed 60 s on the hosted Windows runner (run 41143276777) pass there: `test/cli-task.test.ts`
      "pushes to origin with --push once approved" and `test/evaluation-conditions.test.ts` "tells every condition's
      first step the task and its constraints...". First look at why they are slow (each runs real git and several
      agent processes); give a test a longer limit only where its work is inherently that long, and say so beside it
- [x] No retries in Vitest: a retried test hides the next flake
- [x] The failures fixed on 2026-10-31 (the first-commit tests had no git identity on CI, `f8745a5`) stay fixed: a
      CI step that runs the suite with an empty global git config, or the identity set only by the tests that need it
- [x] CI's run time per system written in the ticket's notes, so a later slowdown is noticed
- [x] Mark the one-command run's tickets 01 to 05 done after the first green run, with its ID and per-system test
      counts (the project's convention)

## Notes

- Core CI uses only the mock adapter and fake tools; it never needs a credential.

## Done (2026-10-31)

- The two tests were not slow themselves: in run 41143276777 the whole hosted Windows runner slowed (a test that took
  9 s the run before took 56 s), so the limit is three minutes on Windows CI only (`vitest.config.ts`, `25670b1`),
  60 s elsewhere; a hang still fails. No Vitest retries are configured.
- The first-commit tests give themselves a git identity (`f8745a5`); a hosted runner has none, which is what caught
  them, so CI itself keeps them honest.
- First green run: 41146259771 (commit `25670b1`). Tests: Linux 899 passed, 1 skipped; macOS 899 passed, 1 skipped;
  Windows 896 passed, 4 skipped (900 each). Test time: Linux 109 s, macOS 317 s, Windows 832 s.
