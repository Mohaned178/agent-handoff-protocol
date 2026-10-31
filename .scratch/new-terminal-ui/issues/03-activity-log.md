# 03: An activity log from every adapter

**Implement with:** Opus 5.5, effort high

**What to build:** What the run screen needs in order to show live work: each attempt's tool calls, the agent's
messages, its usage as it arrives and the limits its tool reports, in a file the runtime owns (spec D4). No screen.

**Blocked by:** 01, spec D4

**Status:** todo

- [ ] `ActivityEntry` (a closed union in `src/adapters/contract.ts`): `tool_call` (today's `ToolCallLogEntry`: kind,
      title, status, workspace-relative paths, AHP's permission answer), `message` (the agent's text, first 300
      characters, `redacted` as OpenCode's errors are), `usage` (a `UsageReport` so far, with `source`), `limit`
      (`{ tool, kind: "plan_limit" | "context_window", status?, window?, used?, size? }` exactly as the tool said it)
- [ ] `AttemptInput.activityLog` replaces `toolCallLog`; path `<runs>/<run>/activity/<attempt>.jsonl`
      (`activityLogPath`); appended as each thing happens, never rewritten; a write that fails never fails the attempt
- [ ] Claude Code (`ClaudeStream`): tool calls from `tool_use`/`tool_result`, messages from assistant text, usage from
      each assistant `message.usage`, `limit` from `rate_limit_event` (`status`, `rateLimitType`)
- [ ] Codex (`CodexStream`): tool calls from `command_execution` and `file_change` items, messages from `agent_message`,
      usage only at `turn.completed` (no estimate in between)
- [ ] OpenCode: today's tool calls, messages from `agent_message_chunk` (joined, then cut), `usage_update` as `usage`
      (cost above zero only, as today) and as a `limit` of kind `context_window` (`used`, `size`)
- [ ] The mock: scripts can emit entries, so tests and `--mock` runs show activity
- [ ] `buildRecoveryReport` reads the last 100 entries (`RecoveryReport.activity`, `null` for an attempt that wrote
      none); old runs with a `tool-calls/` file still read (`?? `, no ledger change)
- [ ] The reported usage on `attempt_exited` is unchanged: the log is for watching, the ledger stays the record
- [ ] Tests: each adapter against its fake tool and captured fixture writes the entries above in order; a torn last line
      is skipped; a message with an `sk-` key is redacted; the mock's entries; recovery reads them;
      `test/tool-call-log.test.ts` moves to `test/activity-log.test.ts`
- [ ] `docs/adapters/*.md`: what each tool reports live and what it does not
- [ ] The evaluation's tool-call counts (`trial_ended.toolCalls`, inference-evaluation ticket 04) read the `tool_call`
      entries of the activity log, unchanged in what they count; a trial of an older run still counts from
      `tool-calls/`; `test/evaluation-metrics.test.ts` passes unchanged
- [ ] OpenCode on a local engine (`opencode({ localEndpoint })`, inference-evaluation ticket 03) writes the same
      entries; its `usage_update` from a local engine reports no cost, and none is shown
