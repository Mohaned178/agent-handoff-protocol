# 04: Tool-call measures in evaluation

**What to build:** Count each trial's tool calls from the attempts' tool-call logs and report them per condition and
adapter.

**Blocked by:** none

**Status:** open

- [ ] `trial_ended.toolCalls`: `{ total, completed, failed, refused }`. Each call's last status counts, read by
      `toolCallId`. It is null when no attempt of the trial kept a log; a missing log is never counted as 0
- [ ] Report: per condition and adapter, the sums over the trials that kept a log, and how many did
- [ ] Older ledgers replay (`?? null`)
- [ ] Tests: a trial with an OpenCode-like log, and a mock trial with none
