# 18: OpenCode adapter (native ACP)

**What to build:** A developer can assign steps to OpenCode, driven through its native ACP mode, passing the conformance suite.

**Blocked by:** 12, 14

**Status:** done

**Model:** Sonnet 5.5 · high

- [x] Drives `opencode acp` over stdio; no third-party bridge
- [x] Uses ACP `session/cancel` for graceful cancel; `request_permission` treated as cooperative only
- [x] Model reporting level declared from what ACP session config exposes (`enumerable`)
- [x] Tool-call log captured for recovery reports
- [x] Passes the conformance suite on Windows native and Linux (WSL2); results recorded as matrix cells
  - [x] Windows native: recorded, `conformance/results/opencode--windows.json`. 9 checks passed, none failed, 2 not applicable, 6 skipped (the tool cannot be made to do them), so the outcome is `untested`, not `passed` (decision 10)
  - [x] Linux (WSL2): recorded, `conformance/results/opencode--linux-wsl2.json`. OpenCode 1.19.4, same result: 9 checks passed, none failed, 2 not applicable, 6 skipped, so `untested`

## Implementer notes

- Transport evidence: `docs/spikes/2026-10-27-transport-spike-windows.md` (decisions 3, 5 and 7 followed, not reopened).
- Real `opencode` never runs in a test. The adapter's tests use a fake `opencode` that speaks ACP and replays messages captured from the real 1.18.35 (`test/fixtures/opencode/captures.json`, scrubbed).

## Comments

2026-10-28, implementation notes. User doc: `docs/adapters/opencode.md`; code `src/adapters/opencode/`; tests `test/opencode.test.ts`, `test/acp.test.ts`, `test/tool-call-log.test.ts`, `test/process.test.ts` (duplex).

**What was added.**
- `launch` has a `duplex` mode (spike decision 5, F2): stdin stays open and is `LaunchedProcess.stdin`. Resolution, `PWD` and tree termination are unchanged, and tested in duplex mode too.
- `src/adapters/opencode/`: `acp.ts` (the JSON-RPC/ACP client), `turn.ts` (what a turn said: messages, tool calls, usage, errors), `policy.ts` (permission rules and answers), `index.ts` (the adapter), `conformance.ts` (the subject).
- A tool-call log channel, which the ticket's fourth box needs and which no adapter had: `AttemptInput.toolCallLog` (an optional path), `toolCallLogPath` in the runtime, `RecoveryReport.toolCallLog` is now `ToolCallLog | null` instead of the literal `null`, and `ahp recover` prints it.
- `promptFor` takes an optional fourth argument, how the agent is to report; the default is unchanged.

**Observed on the real tool (Windows, OpenCode 1.18.35, the free-tier model `opencode/deepseek-v4.1-flash-free`; `OPENAI_API_KEY` removed from the environment of the conformance run).**
- The prompt result's usage: `inputTokens` excludes `cachedReadTokens`, and `totalTokens` = input + output + thought + cached read, in four samples (for example 34 + 3 + 13312 = 13349). A cancelled turn returns zeros. `usage_update.cost` is `0` for the free model.
- `session/set_config_option` with a model OpenCode does not list returns a -32602 error "model not found"; **the session then goes on to run its default model** if the client prompts anyway. The adapter stops there. A rejected provider key is a -32603 error on `session/prompt` with the provider's text, and the process exits 0.
- A `session/request_permission` for an edit is followed by an `fs/write_text_file` request from the agent although the client declared no file-system capability. Answering it with -32601 makes OpenCode print a stack trace to stderr and carry on; the file is written by its own tool.
- `bash` deny patterns in the inline config work (`git push origin main` came back `failed` with no prompt); `edit: ask` produces permission requests of kind `edit` with the path; a shell command's request has `rawInput.command`.
- `OPENCODE_DISABLE_CLAUDE_CODE=1` with `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` took the offered commands from 52 to 17 (the user's `~/.claude` skills were loaded as commands); `--pure` changed nothing in that count.
- `session/cancel` ends the turn in about 0.2 s with `stopReason: "cancelled"`; the process does not exit until stdin ends. Through the conformance suite the cancel cleared a tree of three processes that ignore signals **without force** (`via: transport`).
- `opencode export <session>` takes about 1.4 s and prints the session as JSON with `providerID` and `modelID` on each assistant message.
- Not tried: a shell route around the deny rules (the spike's F3 for Claude Code), a rate limit, Linux, a paid model.

**Windows conformance cell recorded: `conformance/results/opencode--windows.json`.** 9 passed (the real tool completed the probe file byte for byte and reported its summary as JSON; usage was reported; the transport cancel stopped a hung agent and a tree), none failed, 2 not applicable (the network stances, declared `none`), 6 skipped: `failure:agent_error`, `failure:config_auth`, `failure:transient`, `model:reported` (an echo of the request), `model:not_reported`, `usage:not_reported`. So the outcome is `untested`.

**One suite change, made openly.** `cancel:forced_tree` failed on its first real run because it demanded `forced: true, via: tree_kill` of every adapter, and OpenCode's transport cancel cleared the signal-ignoring tree by itself (on Windows nothing can ignore being terminated). The check now demands the forced kill only of an adapter with no transport cancel, and for one that has it checks the PIDs the same way. Tests in `test/conformance.test.ts` cover a transport cancel that clears the tree (passes), one that says it did and leaves it (fails), and a non-graceful adapter that does not force (still fails). It is a relaxation, so `SUITE_VERSION` is not bumped and the recorded Claude Code and Codex cells stand.

**Linux (WSL2) cell: not done.** I did not install or log in anything in the WSL2 distro. To record the cell, in the WSL2 shell:

```
# one time: Node >= 24 and a Linux opencode (check `which opencode` is not under /mnt/c)
npm install -g opencode-ai
git clone https://github.com/Mohaned178/agent-handoff-protocol ~/ahp && cd ~/ahp && git checkout main && npm ci   # in the Linux filesystem, not /mnt/c
env -u OPENAI_API_KEY -u CODEX_API_KEY -u ANTHROPIC_API_KEY npm run conformance -- run opencode
```

Then commit `conformance/results/opencode--linux-wsl2.json`. The default model is the free tier; no login is needed for it. Expect every level to be checked only as accepted (all `cooperative`).

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Declaration: every capability `cooperative` on every OS, both network stances `none`, `transport: acp`, `gracefulCancel: true`, `modelReporting: enumerable`.** *Recommended: adopt.* Nothing was probed to `enforced_by_tool`: OpenCode's deny rules and AHP's permission answers guard its own tool calls, and a shell route around them was not tested. Spike decision 7 allows no more.
2. **The process layer gains a duplex mode** (spike decision 5). *Recommended: adopt.* Stderr stays ignored: OpenCode's failures arrive as JSON-RPC errors, and an undrained pipe could stall it.
3. **The tool-call log is a file the runtime owns, passed to the adapter as `AttemptInput.toolCallLog`, read into the recovery report (last 100 lines, metadata only, no tool input or output).** *Recommended: adopt.* It had to exist before the ticket's fourth box could: an `unknown` attempt never reaches the adapter's `exited`, so the log is written as the calls happen. `RecoveryReport.toolCallLog` changes type (a protocol change, but the JSON Schemas do not cover it and old ledgers hold `null`). Cost: a shell command's text is in the file; it stays in `.git/ahp`, as the ledger does. The field is optional so the other adapters and their tests are untouched.
4. **The reported model is `opencode export`'s last assistant message, read after the process exits and only for a turn in which the model did something; never the session's `configOptions`.** *Recommended: adopt.* The cost is one more short process per attempt. With a requested model the record is the same name, so the suite skips `model:reported` as an echo, as for Codex.
5. **Output fields are asked for as one JSON object that is the whole final message, and read from the last message (bare or fenced).** *Recommended: adopt.* The alternative, a reporting tool served to the agent over MCP, is more reliable and a larger change; revisit it if review steps (`verdict`, `findings`) come back without their fields in practice. A missing field already flows into the `required_output_fields` retry.
6. **Isolation from the user's setup: `--pure`, the permission rules as inline config (`OPENCODE_CONFIG_CONTENT`), and `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_EXTERNAL_SKILLS`.** *Recommended: adopt.* The two variables have an observed effect; `--pure` has none that could be seen (no plugins here) and stays as the documented analogue of `--ignore-user-config`. Your own OpenCode config and OpenCode-native skills still load.
7. **Permission answers: `allow_once` or `reject_once`, never `allow_always`; reject a path outside the workspace and any write into `.git`; reject writes by the read-only and write-scope rules and shell commands starting with `git push`, `git update-ref` or `gh`.** *Recommended: adopt.* `allow_always` would write into your own rules and outlive the attempt. Every other agent-to-client request is answered "method not found".
8. **A cost of 0 in `usage_update` is not recorded as a cost.** *Recommended: adopt.* OpenCode reports 0 for a model it does not price, which is not a report that nothing was charged. A cost above 0 is recorded, with its source.
9. **The `cancel:forced_tree` relaxation above.** *Recommended: adopt.* The alternative was a failed cell for an adapter whose cancel is better than the check assumed.
10. **"Passes the conformance suite" reads as "no check failed, and these were skipped"**: `failure:agent_error`, `failure:config_auth`, `failure:transient`, `model:reported`, `model:not_reported`, `usage:not_reported`. *Recommended: accept this reading,* as for tickets 15 and 16. `fails` has no reliable provoker (a turn that errors cannot be caused on demand without a cost or a paid model), and the free model needs no login.
11. **The conformance subject requests `opencode/deepseek-v4.1-flash-free`** (the free tier the spike used), overridable with `AHP_CONFORMANCE_OPENCODE_MODEL`. *Recommended: adopt.*
12. **The headless `opencode run --format json` fallback of spike decision 3 is not implemented.** *Recommended: keep it out* until ACP fails somewhere it matters; it would be a second adapter path to test.
13. **Error messages of the other adapters are not redacted.** OpenCode's contained the tail of a real API key, so `redacted` removes `sk-` keys and bearer tokens here. *Recommended: a small follow-up that moves it to a shared place and applies it to Claude Code and Codex errors.* Not done here (outside the ticket).

**Code review (two reviewers, before the commit).** Fixed: an empty tool-call log now exists from the start (an attempt lost before any call reads "empty", not "none"); the model is not looked up for a cancelled attempt (the export is a process outside the cancelled tree); a cancel that arrives after the turn ended no longer discards its output; a process that cannot be stopped after its stdin ended makes `exited` reject (the attempt is then `unknown`) instead of waiting for ever; every step that may write now has `edit: ask`, so the `.git` and outside-workspace guard covers plain steps too; the log records what was answered, not what was meant; `any` and a dead `close()` removed. Not done, as judgement calls: the declaration guard and `validateOptions` are now copied three times across the adapters (a shared helper would be a follow-up touching the other two), `index.ts` could be split into session and tool-log modules as Codex's is, and the external-action command list is also in Claude Code's settings.

**Confirmed by the maintainer on 2026-10-28 ("do recommendation"): decisions 1 to 13 above stand as recommended; reopen one only with a new decision.** Decision 9 includes the `cancel:forced_tree` relaxation, and decision 13 is a follow-up not done here. Still open for this ticket: the Linux (WSL2) conformance run, which needs a Linux `opencode`.

2026-10-28, Linux (WSL2) run, on the maintainer's instruction ("run it"). Set up at user level only in the WSL2 Ubuntu home: Node 24.21.0 (the official tarball in `~/.local`), `npm install -g opencode-ai --prefix ~/.local` (1.19.4), and a clone of the repository at `~/ahp`; nothing else on the distro was changed, and no login was needed (free-tier model). Commands used: `npm ci`, then `env -u OPENAI_API_KEY -u CODEX_API_KEY -u ANTHROPIC_API_KEY npm run conformance -- run opencode`.

**The first Linux run failed `cancel:forced_tree`, and found a real defect in the process layer rather than in the adapter.** `session/cancel` plus the end of stdin made OpenCode exit, and the process layer reported the tree stopped, unforced, via the transport, while `node hang.js` and its child were still running. OpenCode starts shell commands in a session of its own (the script was its own process group leader, `pgid` = its PID), which the agent's process group does not hold, and once OpenCode had exited they were nobody's child. Windows did not show it because there the tree is read by parent PID. This is the claim "cancelled only once every process of the tree was seen gone" being wrong on Linux for any agent that detaches children; it was reproduced by a new test first (`test/process.test.ts`, "finds a process the agent started in a session of its own"), which failed on Linux with the same wrong report.

**Fix (`src/process/tree.ts`, `terminateGroup`):** the descendants are read by parent PID, with their start times, before anything is sent; the termination is confirmed only when the group and every one of them is gone; at the kill, what the agent started in the meantime is added and the ones outside the group are killed one by one; an unconfirmed result lists them. It applies to every adapter on Linux and macOS. Verified on Linux: the new test, the whole suite (623 passed, 1 skipped), and `cancel:forced_tree` three times in a row (the cancel is now honestly `forced`, `tree_kill`, on Linux); and on Windows the process and cancel tests. macOS is covered by CI only (`ps -o lstart` exists there).

**The Linux cell is recorded: `conformance/results/opencode--linux-wsl2.json`** (OpenCode 1.19.4): 9 passed, 2 not applicable, 6 skipped, so `untested`, the same as Windows. One earlier Linux run failed `cancel:forced_tree` with "the agent did not list the processes it started within 30 s": the free model had not run the script in time. That is the check depending on the model, not a cancel result, and the check passed on the next three runs and in the recorded one.

14. **The process layer's Linux and macOS termination now finds descendants by parent PID, for all adapters.** *Recommended: adopt.* Without it a cancel on Linux can report a tree gone that is running. Cost: one more `ps` per poll (every 100 ms) while a cancel waits. Shared with Claude Code and Codex, which gain the same protection; their recorded cells were made before it and are not re-run.

**Confirmed by the maintainer on 2026-10-28 ("do recommendation"): decision 14 stands as recommended.**

2026-10-28, done. First green CI run after the push: run 40612711817 on `516a4e9` (the first, 40608504463 on `88422b8`, failed on Ubuntu and macOS because the test fixtures had Windows path separators; fixed in `d8d99d2`, and 40609639197 was green). Ubuntu, Windows and macOS all succeeded. Both conformance cells are recorded and `untested` by decision 10; the checks the tool cannot be made to do stay skipped.
