# 04: Tool-call measures in evaluation

**Implement with:** Sonnet 5.5, effort medium

**What to build:** Count each trial's tool calls from the attempts' tool-call logs and report them per condition and
adapter.

**Blocked by:** none

**Status:** done (2026-11-01)

- [x] `trial_ended.toolCalls`: `{ total, completed, failed, refused }`. Each call's last status counts, read by
      `toolCallId`. It is null when no attempt of the trial kept a log; a missing log is never counted as 0
- [x] Report: per condition and adapter, the sums over the trials that kept a log, and how many did
- [x] Older ledgers replay (`?? null`)
- [x] Tests: a trial with an OpenCode-like log, and a mock trial with none

## Implementation notes (2026-11-01)

1. `toolCalls` also carries `attempts`: `{ attemptId, adapter, total, completed, failed, refused }` for each attempt that
   kept a log. The report must sum per adapter, and a C3 trial mixes adapters, so totals alone could not say whose calls
   they were. The four named totals are the sums of `attempts`; an attempt with no log is absent from it, not 0.
2. `refused` counts calls AHP answered `permission: "rejected"` at any point, so it overlaps `failed` (a refused edit is
   usually reported failed afterwards). A call whose last status is still pending counts only in `total`. The synthetic
   `permission_requested` status never replaces a status the tool gave.
3. The report sums over every ended trial that kept a log, whatever its outcome (as usage does), not only scored ones:
   the calls happened. `ToolCallSummary` says how many trials and attempts that was; the text line also names how many
   trials the condition ended, so a partial count is not read as a full one.
4. The mock cannot write a log, so `MockAttemptScript.toolCallLog` (entries of `toolCallId`, `status`, `permission`) makes
   it append one to `AttemptInput.toolCallLog` as ACP adapters do. Without it the mock keeps no log, so mock trials give null.
5. The count is read once the run is over, from `toolCallLogPath` only. When the terminal app's activity log lands, this
   reads that path too (ticket text). A log that cannot be read leaves the count null and never reclassifies the trial.
6. `replay.ts` and `format-evaluation.ts` needed no change: the field is optional and `?? null`/`?.` in the report.
