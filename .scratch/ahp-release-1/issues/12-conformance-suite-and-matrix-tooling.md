# 12: Adapter conformance suite and support matrix tooling

**What to build:** One conformance suite (seam 2) that any adapter can be run against, passing for the mock adapter in CI, plus tooling that records a run's results as a support matrix cell.

**Blocked by:** 07, 11

**Status:** done

**Model:** Sonnet 5.5 · high

- [x] Suite covers spawn and normalized events, graceful and forced cancel, failure classification, requested vs reported model, usage source labelling, and that each declared capability holds at its declared level
- [x] Runs against the mock adapter in CI on all three OSes
- [x] Can be run locally against a real adapter by the maintainer; never part of CI for real adapters
- [x] Records a result per adapter × OS label (e.g. "Windows", "Linux (WSL2)") with tool version and date
- [x] Mock results are labelled and excluded from the published matrix's evidence

## Comments

2026-10-27, implementation notes.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **The suite is a library function that returns data, `runConformance(subject, options)` in `src/conformance/`, not a Vitest `describe`.** The ticket needs a result it can record as a matrix cell, which a test block cannot give; `src/` is compiled to `dist/` and must not import a dev dependency. CI calls it from `test/conformance.test.ts`; the maintainer calls it from `npm run conformance -- run <adapter>` (`scripts/conformance.ts`, not an `ahp` command: it is for adapter authors and the maintainer, not for users). *Recommended: keep.*
2. **A check ends `passed`, `failed`, `skipped` (could not be provoked) or `not_applicable` (declared `none`); a result is `passed` only with no failed and no skipped check, otherwise `failed` or `untested`.** A real tool cannot be made to hit a rate limit or lose its login on demand, so an adapter's *subject* supplies a provoker per scenario (the mock's are scripts); a behaviour with no provoker is skipped, never passed, and the cell stays untested. That keeps "never claim an adapter works where it was not tested" true by construction. *Recommended: keep.*
3. **Each declared level is checked on the system the suite runs on only (`levelOn(..., platform)`), and what is checked depends on the level.** `enforced_by_tool`: an agent tries to break it (write under `read_only`, write outside `write_scope`, create a branch, request a local listener under a network stance) and the evidence is what it left behind (workspace diff, shared refs, requests received). A control run first has the same agent try with every level recorded as `none` and it must succeed, otherwise the check is skipped: an agent that crashes or a probe that breaks nothing must not pass as enforcement. `cooperative`: only that the attempt accepts the request, and the detail says this is not enforcement and that the suite cannot observe whether the agent was asked. `none`: not applicable. So the mock's capability checks pass as "accepted at cooperative", and nothing says it enforces anything. *Recommended: keep.*
4. **A new check, `declaration:refuses_above_declared`: an attempt recorded at `enforced_by_tool` for a capability the adapter declares weaker must make `startAttempt` throw.** This is the contract's own rule (ticket 11, decision 3), which nothing checked. The mock now enforces it against `this.declaration`, so a wrapper built by spreading `mockAdapter` under another declaration is held to that one and the existing wrapper tests are unchanged. *Recommended: keep.*
5. **"Normalized events" is read as the normalization of `AttemptExit`** (pid, exit code and signal, reported output, stop reason, error, model, usage): the contract has no event stream and none was invented. *Recommended: keep.*
6. **Cancel is two checks.** `cancel:stops_agent` expects the way the declaration implies (transport if `gracefulCancel`, else SIGTERM / `signal` on Linux and macOS and a tree kill on Windows, as `test/cancel.test.ts` does). `cancel:forced_tree` has the agent start a process that ignores every signal, list its processes' PIDs in a file, and hang; it expects a forced tree kill and then looks at the PIDs itself, so an adapter that reports a stop it did not make fails. The suite kills any process it started when a check ends. *Recommended: keep.*
7. **Model and usage are two checks each: the tool says something / says nothing.** A reported model must be what the tool said (exactly, when the subject can make it say a model) and a model the tool did not name must be null even though one was requested (so an adapter that echoes the request fails), and a reported model equal to the request, when the subject cannot make the tool say another, is skipped (an echo cannot be told from a report; a subject may set `requestedModel` to a model its tool accepts); usage must be a report `isUsageReport` accepts with a source, with every number the tool did not give null (never 0), and no usage when the tool gave none. A real tool's subject cannot always control these, and then they are skipped. *Recommended: keep.*
8. **A real adapter is refused when `CI` or `GITHUB_ACTIONS` is set, and when no tool version is known; the mock needs neither.** The tool version comes from the subject (`toolVersion()`, for adapters 15 to 19 to implement) or `--tool-version`; the contract gets no new method, and a version is never made up. `mock` comes from the declaration, not from a flag, so a result cannot be passed off. *Recommended: keep.*
9. **Records: one JSON file per adapter × OS label in `conformance/results/`, replaced by a later run on the same system; the OS label is `Windows`, `Linux (WSL2)`, `Linux` or `macOS`.** WSL2 is told from Linux by `WSL_DISTRO_NAME` or `microsoft` in `/proc/version`. A result carries `SUITE_VERSION`, bumped when a check is added or made stricter (a test pins the list of check IDs), and the matrix reads an older pass, or a result missing a current check, as untested. The mock is recorded only when `--out` is given, and a run with `--only` is never recorded. Git history is the record of earlier runs. *Recommended: keep.*
10. **The matrix has three cell states, `passed (version, date)`, `failed (version, date): checks` and `untested`, though the spec names two.** A failing run hidden as "untested" would hide that it was tried. `matrixOf(results, adapters)` takes the adapter names (which adapters the matrix lists, and their names, are ticket 24's); mock results are never counted, and the latest result per cell wins. *Recommended: keep.*

**Shapes:** `src/conformance/` (`subject.ts`: `ConformanceSubject`, `SCENARIOS`, `Provoker`; `run.ts`: `runConformance`, `ConformanceOptions` with `clock`, `platform`, `env`, `toolVersion`, `osLabel`, `timeoutMs`, `only`; `result.ts`: `ConformanceResult` and its Zod schema, `outcomeOf`, `osLabelOf`, `SUITE_VERSION`; `matrix.ts`: `recordResult`, `readResults`, `matrixOf`, `renderMatrix`), exported from `src/index.ts`. Mock: `mockSubject` (`src/adapters/mock/conformance.ts`), and the script gains `fetchUrl`. `scripts/conformance.ts` (`npm run conformance -- run|matrix`; exit 0 passed, 1 failed, 2 refused, 3 untested).

**Not done:**

- No real adapter exists yet (tickets 15 to 19), so no real subject, no recorded result and no published matrix; each adapter ticket adds its subject to `scripts/conformance.ts` with its provokers, and the matrix is published by ticket 24. How a real tool is made to hang, ignore signals or list its process tree is each adapter's; the convention is in `src/conformance/subject.ts`.
- A `cooperative` level cannot be falsified by behaviour, so it is checked as accepted only. Network stances at `enforced_by_tool` are probed with one local listener, which also stands for "a host that is not a registry"; a registry being reachable under `package_registries` is not checked.
- The CI jobs are unchanged: `npm test` already runs the mock's suite on the three operating systems.

**Confirmed by the maintainer on 2026-10-27 ("do recommendation"): decisions 1 to 10 above stand as recommended; reopen one only with a new decision.**

First green CI run: GitHub Actions run 40530744508 (commit 856af90). 439 tests passed on Linux and macOS (1 skipped: the signal test). Windows had 437 passed and 3 skipped: the signal test, the POSIX resolution test and the Ctrl+C CLI test.
