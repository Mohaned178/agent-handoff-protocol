# 03: An activity log from every adapter

**Implement with:** Opus 5.5, effort high

**What to build:** What the run screen needs in order to show live work: each attempt's tool calls, the agent's
messages, its usage as it arrives and the limits its tool reports, in a file the runtime owns (spec D4). No screen.

**Blocked by:** 01, spec D4

**Status:** done (2026-11-02)

- [x] `ActivityEntry` (a closed union in `src/adapters/contract.ts`): `tool_call` (today's `ToolCallLogEntry`: kind,
      title, status, workspace-relative paths, AHP's permission answer), `message` (the agent's text, first 300
      characters, `redacted` as OpenCode's errors are), `usage` (a `UsageReport` so far, with `source`), `limit`
      (`{ tool, kind: "plan_limit" | "context_window", status?, window?, used?, size? }` exactly as the tool said it)
- [x] `AttemptInput.activityLog` replaces `toolCallLog`; path `<runs>/<run>/activity/<attempt>.jsonl`
      (`activityLogPath`); appended as each thing happens, never rewritten; a write that fails never fails the attempt
- [x] Claude Code (`ClaudeStream`): tool calls from `tool_use`/`tool_result`, messages from assistant text, usage from
      each assistant `message.usage`, `limit` from `rate_limit_event` (`status`, `rateLimitType`)
- [x] Codex (`CodexStream`): tool calls from `command_execution` and `file_change` items, messages from `agent_message`,
      usage only at `turn.completed` (no estimate in between)
- [x] OpenCode: today's tool calls, messages from `agent_message_chunk` (joined, then cut), `usage_update` as `usage`
      (cost above zero only, as today) and as a `limit` of kind `context_window` (`used`, `size`)
- [x] The mock: scripts can emit entries, so tests and `--mock` runs show activity
- [x] `buildRecoveryReport` reads the last 100 entries (`RecoveryReport.activity`, `null` for an attempt that wrote
      none); old runs with a `tool-calls/` file still read (`?? `, no ledger change)
- [x] The reported usage on `attempt_exited` is unchanged: the log is for watching, the ledger stays the record
- [x] Tests: each adapter against its fake tool and captured fixture writes the entries above in order; a torn last line
      is skipped; a message with an `sk-` key is redacted; the mock's entries; recovery reads them;
      `test/tool-call-log.test.ts` moves to `test/activity-log.test.ts`
- [x] `docs/adapters/*.md`: what each tool reports live and what it does not
- [x] The evaluation's tool-call counts (`trial_ended.toolCalls`, inference-evaluation ticket 04) read the `tool_call`
      entries of the activity log, unchanged in what they count; a trial of an older run still counts from
      `tool-calls/`; `test/evaluation-metrics.test.ts` passes unchanged
- [x] OpenCode on a local engine (`opencode({ localEndpoint })`, inference-evaluation ticket 03) writes the same
      entries; its `usage_update` from a local engine reports no cost, and none is shown

## Implementation notes (2026-11-02)

1. **`ActivityEntry` is defined in `src/protocol/index.ts` and re-exported from `src/adapters/contract.ts`.** The recovery
   report, which is recorded in the ledger (`recovery_report_written`), holds entries, and the protocol imports nothing
   from the adapters. `ActivityLimit` and `ActivityLog` sit beside it, and `ACTIVITY_ENTRY_TYPES` lists the four types.
2. **Shapes.** `tool_call` is `{ type, ...ToolCallLogEntry }`; `message` is `{ type, time, text }`; `limit` is flat
   (`{ type, time, tool, kind, status?, window?, used?, size? }`); `usage` is `{ type, time, scope, usage }`. The
   `scope` field (`attempt` | `message`) is new. Claude Code's per-message `usage` covers one model call. The per-message
   counts in the fixture do not add up to the `result` event's (output 45 against 534), so AHP neither sums them nor
   shows them as "so far". `scope: "message"` says so to the screen, and the source text says it too.
3. **`RecoveryReport.activity` replaces `toolCallLog`, with no protocol version change.** `toolCallLog?` stays as an
   optional field for reports recorded before this ticket. `ahp recover`/`inspect` read `activity ?? toolCallLog`. On
   disk, `buildRecoveryReport` reads `activity/<attempt>.jsonl`, and when it is missing, `tool-calls/<attempt>.jsonl`, whose
   untyped lines are read as `tool_call`. No ledger fixture held a recovery report, so none had to change.
4. **One writer, `activityLogger` in `src/adapters/activity.ts`, used by every adapter.** It stamps the time, redacts and
   then cuts messages to 300 characters (redacting first, so a key across the cut cannot leak half of itself), cuts
   titles, and makes absolute paths inside the workspace relative (a path that is already relative stays as it is). It
   drops a usage report that `isUsageReport` refuses, and writes the same limit only once in a row: Claude Code repeats
   `rate_limit_event`, and OpenCode repeats `usage_update`. It writes synchronously, as the old tool-call logger did, and
   swallows every failure. `withoutSecrets` moved there, and `redacted` (500 characters, for errors) is built on it.
   `parseActivity`/`activityEntryOf` are the single reader: recovery, evaluation counts and `ahp run` progress all use
   them, so a torn line is skipped everywhere.
5. **Claude Code:** the kind is the tool's own name (`Write`, `Bash`). The title is the input's `command`, `pattern`,
   `url` or `query`, else null. The paths come from `file_path`, `notebook_path` and `path`. `tool_use` gives
   `in_progress`, and `tool_result` gives `completed`, or `failed` when `is_error` is set. The permission is always null:
   the hook answers, and its answer is not in the stream. Subagent events are left out, as they already were for the
   model. A message's usage is passed on once per `message.id`, because Claude Code repeats it on each content block.
6. **Codex:** the kind is the item type (`command_execution`, `file_change`), and the status is Codex's own word,
   `declined` included. That leaves a declined call counted as neither completed nor failed, which matches how ACP
   statuses already counted. `file_change` follows Codex's documented item shape. No captured stream has one, so its
   test uses a constructed stream, labelled as such.
7. **OpenCode:** a message is written once it is whole, that is, when the next update is not one of its chunks, or at
   `finish`/`exit`. A `usage_update` gives a `context_window` limit, and a usage entry (cost only, no tokens) only when
   the cost is above zero. The turn's token counts are written from the `session/prompt` result.
8. **Every real adapter creates the file when its agent starts**, so an empty log means "nothing reported yet", as
   OpenCode's did. The mock makes one only when its script has `activity` or the older `toolCallLog`, which is kept so
   `test/evaluation-metrics.test.ts` passes unchanged. Its lines are written as `tool_call` entries before the `activity`
   ones.
9. **Evaluation counts** read `tool_call` entries from the activity log, else from `tool-calls/`. Claude Code and Codex
   trials now get counts instead of null, because their adapters now report tool calls. What is counted per call is
   unchanged.
10. **The old CLI keeps working until ticket 09.** `ahp recover` prints `activity log: N entries` (it said `tool-call
    log:`; `docs/troubleshooting.md` quoted neither), with one line per entry. `ahp run` progress reads the activity
    log's tool calls. The conformance suite passes `activityLog`.
