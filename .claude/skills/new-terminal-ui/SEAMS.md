# Seams per ticket

These are the locations found on 2026-10-31. Line numbers drift, so search by name if one has moved. Reuse what is listed here: the app is a new face on code that already works.

## 00: Clean the garbage

Done (commit b5521be).

## 01: A lean CLAUDE.md

- **Target:** CLAUDE.md under 15 KB. It has grown since the ticket was written: the inference-evaluation scope lines from ADR 0007 are new, so keep them.
- **Where facts go:**
  - Move each removed fact into the doc it describes: `docs/how-it-works.md`, `docs/adapters/*.md`, `docs/evaluation.md`, `docs/limits.md`.
  - Or leave it to the `.scratch/<feature>/` tickets, which already hold it.
  - Delete nothing true without a home.
- **Before cutting:** some tests read docs, so search `test/` for the doc names first.

## 02: Design system and app shell

- **Recent runs:** `listRuns` (`src/sdk/run.ts:181`), newest first. A ledger that cannot be read comes back with `problem`.
- **Status line roles:** `castRoles(report, defaults)` (`src/setup/infer.ts:117`), with `report` from `diagnose` (`src/doctor/doctor.ts:90`) and `defaults` from `readSettings(settingsPath())` (`src/setup/settings.ts:36`, `src/runtime/paths.ts:49`).
- **TTY detection to replace:** `src/cli/live.ts:14` (`Terminal`) and `defaultIo` in `src/cli/main.ts`. Compare their rules: compact only on a TTY with `CI` unset. The new app keeps the same rule for when it opens.
- **New files:**
  - `src/tui/h.ts`, `theme.ts`, `components/*.ts`, `router.ts`, `screens/home.ts`, `dev.ts`
  - `test/helpers/tui.ts`, `test/tui-shell.test.ts`
- **Package:** `test/package.test.ts` checks the tarball's `files` and dependencies, so update it with the new ones.

## 03: Activity log from every adapter

- **Today's log:**
  - `AttemptInput.toolCallLog` (`src/adapters/contract.ts:72`)
  - `ToolCallLogEntry` (`src/protocol/index.ts`, near :576)
  - the writer `toolCallLogger` (`src/adapters/acp/tool-calls.ts:62`)
  - the path `toolCallLogPath` (`src/runtime/paths.ts:119`), passed at `src/runtime/run.ts` (search `toolCallLog`)
- **Recovery:** `buildRecoveryReport` (`src/runtime/recovery.ts:31`) reads the last 100 lines. `ahp recover` prints them.
- **Claude Code:** `ClaudeStream` (`src/adapters/claude-code/stream.ts`). `rate_limit_event` is noted at :121 as sent on healthy runs too, so it is a `limit` entry, never an error.
- **Codex:** `CodexStream` (`src/adapters/codex/stream.ts`). Usage arrives only at `turn.completed`.
- **OpenCode:**
  - `AcpTurn` (`src/adapters/opencode/turn.ts`): `usage_update` near :80, and `redacted` from `acp/tool-calls.ts`
  - the adapter in `src/adapters/opencode/index.ts`
- **Mock:** `src/adapters/mock/`. Scripts gain an `activity` list.
- **Tests:** fixtures in `test/fixtures/{claude-code,codex,opencode}/`. Rename `test/tool-call-log.test.ts` to `test/activity-log.test.ts`.

## 04: Run screen with live coding

- **State:** `RunView` and `replay` (`src/ledger/replay.ts:120`), read with `readCheckedLedger` (`src/ledger/chain.ts:107`). Follow the ledger's growth from an offset, and leave a torn tail out as `readLedger` does.
- **Receipt:** `formatReceipt` (`src/cli/receipt.ts:197`), `formatBriefReceipt` (:157) and `nextStepOf` (:175). Pull a pure `receiptOf(RunView)` out of them. The old text renders from it until ticket 09, and `test/receipt.test.ts` must keep passing.
- **Limits:**
  - `resolveTimeout` (`src/runtime/timeout.ts:13`) gives the total and idle limits.
  - `StepView.retryUsage` gives the retries used.
- **Usage:** `summarizeUsage` (`src/runtime/usage.ts`), per adapter and never summed across adapters.
- **Live diff:**
  - A worktree's path is `worktreePath(root, runId, attemptId)` (`src/runtime/paths.ts:96`).
  - The base is the attempt's base commit in the ledger.
  - `changesBetween` (`src/cli/diff.ts`) shows how `--numstat` is read today.
- **Transcript:** `transcriptPaths` (`src/runtime/paths.ts:109`), used by `l` for the raw log.

## 05: First open and the task flow

- **Inference:**
  - `inferCommands(dir)` (`src/setup/infer.ts:108`)
  - `branchFor` (:132)
  - `buildTaskRun` (`src/setup/task.ts:67`)
  - `formatTaskSummary` in the same file shows what the summary must say
- **Models and effort:**
  - `effortsFor` (`src/setup/models.ts:15`)
  - `KNOWN_MODELS` (:35)
  - `offeredByOpenCode` (:59)
  - `castRole` (`src/setup/wizard.ts:93`), the question order to copy, not import
- **Saved defaults:** `saveStepDefault` (`src/setup/settings.ts:76`). Add `firstOpenDone` beside `realAgentsNoticed`, read as missing for older files.
- **Repository readiness:** `readyRepository` (`src/cli/main.ts:682`) mixes questions with logic. Move the logic into `src/setup/` with no printing, and give it a test of its own.
- **Precheck:** `precheck` (`src/cli/precheck.ts:14`).
- **Today's flow to read for behaviour:**
  - `taskCommand` (`src/cli/main.ts:825`)
  - `changeStep` (:936)
  - `setupCommand` (:644)
  - `checkStepFlags` and `withStepFlags`
- **Running:** `runWorkflow` (`src/sdk/run.ts:49`), with `signal` and `onEvent`.
- **Mock:** `mockScripts` (search `src/setup/`).

## 06: Decisions in the app

- `approveStep` and `rejectStep` (`src/sdk/run.ts:94,107`).
- `recoverAttempt` (`src/sdk/run.ts:79`) and `resumeRun` (:63), whose runtime side is `src/runtime/resume.ts:55,86`.
- `pendingApprovalOf` (`src/runtime/approval.ts:89`) gives the gate's diff from the pinned commit, never a worktree.
- **Today's in-place decision** to read for behaviour: `decideHere` (`src/cli/main.ts:552`) and `followRun` (:404).
- **Lock state:** `readLockState` (`src/ledger/lock.ts:134`) tells "held by a live process" from "stale".
- **Test helpers:**
  - `addBareRemote` (`test/helpers/repo.ts`)
  - `truncateLedgerAfter` and `appendLedgerEvent` (`test/helpers/ledger.ts`)
  - `startRun` (`test/helpers/process.ts`)

## 07: Runs, tools, settings and clean

- `/tools`:
  - `diagnose` (`src/doctor/doctor.ts:90`)
  - `TOOLS` with `install` and `logIn` (`src/doctor/tools.ts`)
  - `levelOn` for the declared levels
  - `formatDoctor` in `src/cli/format-doctor.ts` shows today's facts
- **Save as workflow:** `renderTaskWorkflow` and `buildTaskWorkflow` (`src/doctor/init.ts`), written exclusively (`flag: "wx"`).
- **Clean:**
  - Worktrees live under `<AHP_HOME>/worktrees/<run>/`.
  - A run's state comes from `listRuns`.
  - Keep any run in `needs_recovery` or `waiting_approval`.
  - Remove with `git worktree remove --force`, then `git worktree prune`, through the git helpers in `src/runtime/workspace.ts`.

## 08: Plain commands

- **Today's commands to port:** `src/cli/main.ts`, with `parseArgs` near :250, `USAGE` at :65 and `SHORT_USAGE` at :145.
- **Behaviour to keep:**
  - exit codes: 0 passed, 1 failed, 2 usage, 4 waiting
  - `--json` shapes unchanged
- **Child-process tests:** `test/helpers/cli.ts`, `startAhp`. List each assertion of the tests named in the ticket before porting, and tick it off after.

## 09: Switch over and delete

- **Entry:** `src/cli/bin.ts`, and `bin/ahp.mjs`, which loads `dist/cli/bin.js` (keep that path or update `bin/ahp.mjs` and `package.json` `files`).
- **Before deleting a file:** `grep -rn "from \"../cli/<file>"` across `src/` and `test/`. Nothing may import a deleted file.
- **Docs:**
  - README (the generated `supported-tools` block stays between its markers)
  - `docs/how-it-works.md`
  - `docs/troubleshooting.md`
  - `CHANGELOG.md`
  - CLAUDE.md

## 10: First-use test and polish

The maintainer runs the test. Prepare a checklist from the ticket, then fix what they report, one test per fix.
