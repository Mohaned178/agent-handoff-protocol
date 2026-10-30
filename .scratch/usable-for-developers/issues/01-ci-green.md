# 01: CI green on all three systems, and kept green

**What to build:** A CI run that passes on Windows, Linux and macOS, and a habit that keeps it so, because a release
(ticket 07) is cut only from a green commit.

**Blocked by:** none

**Status:** planned

- [ ] The two tests that exceed 60 s on the hosted Windows runner (run 41143276777) pass there: `test/cli-task.test.ts`
      "pushes to origin with --push once approved" and `test/evaluation-conditions.test.ts` "tells every condition's
      first step the task and its constraints...". First look at why they are slow (each runs real git and several
      agent processes); give a test a longer limit only where its work is inherently that long, and say so beside it
- [ ] No retries in Vitest: a retried test hides the next flake
- [ ] The failures fixed on 2026-10-31 (the first-commit tests had no git identity on CI, `f8745a5`) stay fixed: a
      CI step that runs the suite with an empty global git config, or the identity set only by the tests that need it
- [ ] CI's run time per system written in the ticket's notes, so a later slowdown is noticed
- [ ] Mark the one-command run's tickets 01 to 05 done after the first green run, with its ID and per-system test
      counts (the project's convention)

## Notes

- Core CI uses only the mock adapter and fake tools; it never needs a credential.
