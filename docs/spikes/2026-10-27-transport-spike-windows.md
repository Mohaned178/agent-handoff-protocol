# Transport spike on native Windows, 2026-10-27

Ticket 14. Input to tickets 15 (Claude Code), 16 (Codex), 18 (OpenCode) and 19 (Gemini CLI). It compares each tool's vendor-maintained transports (ADR 0001) on native Windows, from live runs where the maintainer's own logins allowed one and from static evidence where they did not. Nothing here comes from the mock adapter.

**Reading the evidence.** *Observed* means I saw it in a run on this machine (the raw captures are kept out of the repository; the excerpts below are trimmed and scrubbed of paths, account names and session IDs). *Static* means read from `--help` output or package source and not run. *Unconfirmed* means neither. A number appears only if the tool reported it; nothing is summed or estimated. A model's cost, where printed, is the tool's own and labelled with its source.

## 1. Setup

| | |
|---|---|
| Date | 2026-10-27 |
| OS | Windows 11 Pro 10.0.26300, native (no WSL2 in this spike) |
| Node / git | 24.21.0 / 2.55.0 |
| Claude Code | 2.1.311, logged in with the tool's own login (`apiKeySource: none` in the stream) |
| Codex CLI | 0.146.0 (`@openai/codex-sdk` on npm is 0.164.0), logged in "using ChatGPT" by the maintainer during this session |
| OpenCode | 1.18.35. Its default model failed with HTTP 402 `Insufficient account funds`; with the maintainer's agreement every OpenCode run used the free-tier model `opencode/deepseek-v4.1-flash-free` (a stand-in, not the maintainer's configured default) |
| Gemini CLI | 0.42.0. **Not run**: no paid access (maintainer's answer). Help output only. |

Method. Throwaway scripts in a scratch folder, outside AHP's source. Every tool was started through AHP's own `resolveExecutable` and `launch` (so the evidence is about the path adapters will take), except the ACP and stream-json-input experiments, which need a writable stdin and used `child_process.spawn` on the executable `resolveExecutable` found. Each experiment used a disposable git repository whose path contains a space (as AHP worktrees may). For Claude Code I removed the host session's `CLAUDE*` variables from the environment; whether leaving them in changes anything is unconfirmed. `OPENAI_API_KEY` was set in the host shell and removed for Codex runs, so those runs used the ChatGPT login. A process counts as gone only if `tasklist` no longer lists its PID.

Run counts (the ticket asked for "a handful per tool"): Claude Code 7, Codex 8 (more than planned, see 4.3; one further run was not made, see 4.3), OpenCode 9 on the free model, Gemini 0.

**Incident, recorded because it is also a finding.** My first OpenCode run was started with the disposable repo as its working directory but wrote `out.txt` and `protected.txt` into AHP's own checkout instead (finding F1). Both files were untracked and contained only what the prompt asked; I deleted them and `git status` was clean again. No tracked file was touched.

## 2. Findings that change adapter work

**F1. `opencode run` takes its working directory from the inherited `PWD` variable, not from the process's actual cwd.** Observed: started with cwd = repo but `PWD` inherited from a Git Bash parent (`/f/Agent Handoff`), the agent's `pwd` printed the parent's directory and it wrote there. With `PWD` set to the repo it used the repo; `--dir <repo>` also worked. Claude Code (init event `cwd`) and Codex (`Get-Location`) both honoured the real cwd with the same inherited `PWD`. This defeats workspace isolation silently, so it matters more than any transport choice. `launch` only adds variables, so an adapter must set `PWD` (and pass `--dir`/`--cwd`); I recommend the process layer set `PWD` to `cwd` for every agent. Not tested: whether `opencode acp` has the same behaviour on its own (my ACP runs set both).

**F2. `launch` cannot drive ACP.** It writes `input`, closes stdin, and sends stderr to `ignore`. ACP (OpenCode, Gemini) needs a stdin that stays open for `session/cancel` and permission replies. Claude Code's optional graceful interrupt (4.1) needs the same. A duplex variant of `launch` that keeps resolution and tree termination is a prerequisite of ticket 18. Dropping stderr also hid Claude Code's sandbox warning (4.1).

**F3. On Windows, deny rules and hooks that guard Claude Code's `Bash` tool can be walked around by the agent.** Observed (4.1). Claude Code's OS sandbox is off on native Windows. Any `enforced_by_tool` claim for Claude Code on Windows has to come from removing tools (`--tools`), not from rules over `Bash`.

**F4. The reported model is not on the stream for Codex or OpenCode headless.** Codex writes it to its session file (`turn_context.model`, observed `gpt-5.6-luna` for `-m gpt-5.6-luna`); OpenCode's `export` command has it per message (`providerID`/`modelID`). Claude Code reports it in the stream. Whether AHP may read Codex's session file is a decision (section 6).

**F5. Usage is lost when an attempt is force-killed.** Every forced cancel ended with no closing event, so no usage was reported for the cancelled attempt (Claude Code, Codex, OpenCode headless). Graceful cancels reported usage for Claude Code (real figures) and OpenCode ACP (all zeros, which must be recorded as not reported, not 0).

## 3. Per tool and transport, six properties

### 3.1 Claude Code: headless `claude -p --output-format stream-json --verbose`

The ADR already fixes this transport; the spike tested it.

| Property | Result |
|---|---|
| Cancellation | Observed: `terminate()` was `forced`, `tree_kill`, 0.7 s; exit code 1; last event `system/task_started`; a grandchild that the agent's shell started was gone; no `result` event. Optional, observed: with `--input-format stream-json`, a `control_request` of subtype `interrupt` returns `control_response success`, then `result` with `subtype: error_during_execution`, `terminal_reason: aborted_tools`, cost and usage, about 12 ms later. The process does not exit; it waits for stdin to close (exit code 1, 0.3 s after close). Whether the interrupt itself kills the shell's grandchild was not timed (it was gone by the end of the run). |
| Permission requests | No prompt reached a person in `-p`: a tool call the rules did not allow was denied (`--permission-prompts host\|none` is in `--help`; static, not run). Denials show as a `system/permission_denied` event, a `tool_result` with `is_error`, and a `permission_denials` list in `result`. |
| Model | Requested alias `sonnet`; the `init` event, every assistant message and `modelUsage` report `claude-sonnet-5-5`. A model the tool reports itself. |
| Usage | `result` carries `usage` (input, output, cache read, cache write tokens), `modelUsage` per model and `total_cost_usd`. `modelUsage.costBasis` says `list`: a list-price figure from the tool, not a bill (the login is the tool's own). Not reported for a force-killed attempt. |
| Output stability | One JSON object per line. Event types seen: `system` (`init`, `hook_started`, `hook_response`, `permission_denied`, `informational`, `thinking_tokens`, `task_started`, `task_notification`), `assistant`, `user`, `rate_limit_event`, `result`. Hook events appear only with `--include-hook-events`. Informational events (`thinking_tokens`, `rate_limit_event`) vary from run to run; an adapter must ignore unknown types. |
| Exit/stop | Exit 0 with `result.subtype: success`, `stop_reason: end_turn`, `terminal_reason: completed`. Forced kill: exit 1 (from `taskkill`), no `result`. `--max-budget-usd` was passed (0.6) and never reached. |

**Hooks and deny rules on Windows (observed).** Settings were passed with `--settings` and `--setting-sources project`.

- A `PreToolUse` hook written as `node "<path with a space>/block-secret.mjs"` ran for `Write` and `Bash` (node 24.21.0 from PATH); exit code 2 blocked a `Write` to `secret/new.txt`, and its stderr came back to the model as the tool error. The hook script's own log shows it was called, and the repository shows no `secret/new.txt`.
- `permissions.deny` for `Edit(protected.txt)` blocked the `Edit` path and also `echo changed >> protected.txt` through `Bash`; `Bash(git push:*)` blocked `git push origin main`. `protected.txt` was unchanged.
- **Bypass.** In a second run (authorized test in a disposable repo) `node -e "require('fs').appendFileSync('protected.txt','changed\n')"` through `Bash` succeeded, and `cd secret && echo changed > y.txt` created `secret/y.txt` past a hook that matches the literal `secret/`. Left-behind state: `protected.txt` modified, `secret/y.txt` present.
- **Tool removal.** `--tools Read,Write,Edit` gave an `init` tool list of 3 and the agent had no shell (a request to run `echo hi > shell.txt` was not run). The write hook still blocked `secret/`. But the agent also listed claude.ai connector tools (Claude Docs) that the account has: `--tools` did not remove those. `--strict-mcp-config` is the documented way to drop MCP servers; I did not test it.
- **Sandbox.** `settings.sandbox.enabled: true` printed, in a text-mode run: `Sandbox disabled: sandbox is enabled but the Windows sandbox is not active on this session (feature gate off). Commands will run WITHOUT sandboxing.` So native Windows has no OS-level sandbox here. The warning did not appear among the events of the stream-json run I made, and `launch` ignores stderr, so an adapter would not see it.

### 3.2 Codex: Codex SDK vs `codex exec --json` (app-server not evaluated, per the ticket)

**Codex SDK (static: package source of `@openai/codex-sdk` 0.164.0; not run).** It is a thin wrapper: it spawns `codex exec --experimental-json ...` itself with Node's `spawn`, writes the prompt to stdin, parses the JSONL, and returns events and `usage` from `turn.completed`. Consequences for AHP:

- It starts the process internally (`codexPathOverride` selects the executable, nothing hooks the spawn). AHP could not own the PID, `shell: false`/`windowsHide` choices or a tree kill; cancel is an `AbortSignal` passed to `spawn`, which kills the direct child only (`child.kill()` in the source). ADR 0001 requires "exited always means observed process termination", and ticket 07's cancel confirms the whole tree gone; the SDK cannot give either. (Whether Codex's own process tree then leaves survivors is unconfirmed: the SDK was not run.)
- Its default binary is the platform package pinned by `@openai/codex@0.164.0`, not the user's installed Codex (0.146.0 here), so the version the matrix records and the version the user installed could differ unless `codexPathOverride` is always set.
- It adds nothing `exec --json` lacks that AHP needs: thread options map to the same flags (`--model`, `--sandbox`, `--cd`, `--output-schema`, `--config approval_policy=...`).
- It uses `--experimental-json`; the public flag is `--json`. That they emit the same events was not compared.

**`codex exec --json` (observed, through `launch`).**

| Property | Result |
|---|---|
| Cancellation | Observed: mid-turn `terminate()` was `forced`, `tree_kill`, 0.5 s, exit code 1, last event `turn.started`, no `turn.completed`, so no usage. Not observed: a cancel while the agent's own shell child runs (see 4.3), so tree survivors under the agent's command are unconfirmed. No graceful cancel exists headless. |
| Permission requests | None reach the host. A command the policy does not allow comes back as an `item.completed` of type `command_execution` with `status: "declined"`, `exit_code: -1` and output ``... rejected: blocked by policy``. |
| Model | `-m gpt-5.6-luna` was accepted; `gpt-5.4-mini` failed: `error` and `turn.failed` events (HTTP 400 `model_not_found`, "not supported when using Codex with a ChatGPT account"), exit 1. `codex debug models` lists the catalog the login can use. The accepted model is reported only in the session file (F4). |
| Usage | `turn.completed.usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. No cost. Not reported when the turn does not complete. |
| Output stability | Events: `thread.started`, `turn.started`, `item.started`/`item.completed` (`agent_message`, `command_execution` with `command`, `status`, `exit_code`, `aggregated_output`), `error`, `turn.completed`, `turn.failed`. Commands run through `pwsh.exe -Command` (PowerShell 7) and their output carries ANSI escape codes. The agent read a user-level skill file in runs that also passed `--ignore-user-config --ignore-rules`: user configuration beyond `config.toml` can still shape a run. |
| Exit/stop | Success exit 0; `turn.failed` exit 1; forced kill exit 1. |

### 3.3 OpenCode: native ACP vs headless `opencode run --format json`

| Property | Headless `run --format json` | Native `opencode acp` (stdio, hand-written client) |
|---|---|---|
| Cancellation | Observed: forced `tree_kill`, 0.5 s, exit 1, one event emitted, grandchild gone. | Observed: `session/cancel` while the agent's shell child ran; the prompt response came back in about 0.26 s with `stopReason: "cancelled"`. The process did **not** exit by itself within 10 s; closing stdin made it exit 0 within about 0.1 s (two runs). The grandchild was gone by the end; whether the cancel or the exit removed it was not timed. A stop reason is outcome detail, as ADR 0001 says. |
| Permission requests | None reach the host. Rules come from `permission` in an `opencode.json` in the repo: with no rules, every edit and shell command ran (observed). With `edit`/`bash` patterns set to `deny`, the denied tool calls ended with `state.status: "error"` ("The user has specified a rule which prevents you from using this specific tool call") and the files were unchanged. | With `edit`/`bash` set to `ask`, a real `session/request_permission` reached the client (options `allow_once`, `allow_always`, `reject_once`); rejecting ended the turn (`end_turn`) and the file was not written. |
| Model | Requested by `-m provider/model` or project config; the stream has no model. `opencode export <session>` shows `providerID`/`modelID` per assistant message. | `session/new` returns `configOptions` with a `model` select whose `currentValue` is the configured model and the available list. That is the selection, not a provider report. |
| Usage | `step_finish.part.tokens` (`total`, `input`, `output`, `reasoning`, `cache.read`/`write`) and `cost` (0 for the free model). | `session/prompt` response has `usage` (`inputTokens`, `outputTokens`, `totalTokens`); on the cancelled turn it was all zeros (not a real report); a `usage_update` notification also exists. |
| Output stability | `step_start`, `tool_use`, `text`, `step_finish`, `error`. A `tool_use` appears only once the tool has completed or failed (no running event), so "a tool is now running" cannot be read from the stream. | JSON-RPC. `session/update` kinds seen: `available_commands_update`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`. |
| Exit/stop | Success exit 0. The 402 error produced one `error` event (`APIError`, `statusCode: 402`) and exit 1, but only after about 79 s; why it took that long is unconfirmed. | Exit 0 on stdin close. |

`initialize` reported `OpenCode 1.18.35`, protocol version 1, `authMethods: ["opencode-login"]` and session capabilities `close`, `fork`, `list`, `resume`. Not tested for OpenCode: deny rules against an agent that goes around them through the shell (as in 3.1), so do not assume they are stronger than Claude Code's.

### 3.4 Gemini CLI: native ACP vs headless (not run)

No paid access (maintainer's answer), so every point below is **static, from `gemini --help` (0.42.0)**, and every property in the six-way comparison is **unconfirmed**:

- ACP: `--acp` (`--experimental-acp` is marked deprecated).
- Headless: `-p/--prompt` (appended to stdin input), `-o/--output-format text|json|stream-json`.
- Permissions: `--approval-mode default|auto_edit|yolo|plan` (`plan` described as read-only), `--policy` and `--admin-policy` files, a deprecated `--allowed-tools`.
- Sandbox: `-s/--sandbox`. Whether it exists on native Windows is unconfirmed.
- `--skip-trust` suggests a workspace-trust prompt exists in headless mode; unconfirmed.

Ticket 19 runs these checks once paid access exists; until then Gemini CLI stays "not run" in the matrix.

## 4. Sandbox and enforcement on native Windows

### 4.1 What differs from Linux/macOS (observed or static, per row)

| Tool | Observed on native Windows |
|---|---|
| Claude Code | No OS sandbox (feature gate off, quoted above). Deny rules and hooks apply to the tool calls they see; a shell command can reach a path through another program (F3). Removing tools with `--tools` removed `Bash` (observed) but not connector tools. |
| Codex | See 4.3: its policy layer declined every non-read command; its `codex sandbox` Windows restricted-token sandbox denied file writes everywhere and did not stop a request to a local listener. |
| OpenCode | No sandbox observed; permissions are rules in its own config (3.3). That it has no OS sandbox at all is unconfirmed. |
| Gemini CLI | Unconfirmed. |

### 4.2 Capability candidates, as evidence stands (for the adapter tickets to declare, not for me)

Levels follow ADR 0001 and `CLAUDE.md`: only `enforced_by_tool` is enforcement, and the conformance suite (ticket 12) is the test.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| `write_scope` | `cooperative` while `Bash` is available (bypass observed). `enforced_by_tool` is plausible only with `Bash` and connector tools removed and `Write`/`Edit` guarded by hook and deny rules (hook and deny blocks observed). | Unconfirmed (4.3). | `cooperative`; deny rules blocked the edit tools (observed), shell bypass untested. |
| `read_only` | As above; without `Bash`, `Write` and `Edit` it is plausible, untested as a single configuration. | The `read-only` sandbox mode was accepted and writes failed with `EPERM` under `codex sandbox`; agent-driven writes under `exec` untested. | `cooperative`. |
| `no_external_actions` | `cooperative` (`Bash(git push:*)` deny blocked the exact command; other routes untested). | Unconfirmed. | `cooperative`. |
| Network `deny` | Not tested; no sandbox. | `codex sandbox` did **not** block a request to a local listener (localhost only; external hosts untested). | Not tested. |

### 4.3 Codex on native Windows: what is and is not known

- Under `codex exec -s workspace-write`, including `-c approval_policy="never"`, with and without `--ignore-user-config` and `--ignore-rules`, every command that was not a read (create `out.txt` in the workspace; write `../outside.txt`; a Node request to a local listener) came back `declined ... blocked by policy` before running. The listener's log and the filesystem show none of the three happened. Why in-workspace writes were declined too is unconfirmed (candidates: no Windows sandbox set up for the account, or a policy default I could not see).
- `codex sandbox -- node probe.mjs` (a probe that tries three writes and a request): under `workspace-write` and `read-only` all three writes failed `EPERM`, including inside the working directory, and the request to the local listener succeeded (200). The same probe without the sandbox succeeded in every case. So this sandbox blocks writes on native Windows, but I could not make it permit a workspace write, and it does not block localhost network. Whether `exec` builds its sandbox differently from the `sandbox` subcommand is unconfirmed.
- A run with `-s danger-full-access` to cancel under a long-running shell child was **not made**: this session's permission guard declined it, and I did not look for another way. Codex's shell-child cancel is therefore unconfirmed. Counting the runs above, Codex took more than a handful because of the policy blocks.

## 5. Approximate usage per attempt (input to the pilot budget)

Tool-reported only, tiny tasks in an empty disposable repo (create a file, a few denied actions, or "reply ok"). Not a forecast for real tasks.

| Tool (model as reported) | What was reported |
|---|---|
| Claude Code (`claude-sonnet-5-5`, effort low) | Per attempt: 2 to 5 turns; input 2 to 8 tokens, cache write 5,996 to 14,731, cache read 7,007 to 57,292, output 132 to 461; `total_cost_usd` 0.027 to 0.069 (a list-price figure from the tool, `costBasis: list`, not a charge on the maintainer's login). |
| Codex (`gpt-5.6-luna`, ChatGPT login) | Trivial "reply ok": input 12,688, cached 0, output 5. Four small shell tasks (three on `gpt-5.6-luna`, the first on Codex's default model, which the stream does not name): input 57,384 to 96,278 (cached 40,960 to 75,520), output 771 to 925, reasoning 123 to 294. The larger inputs came with the agent reading user-level skill files. No cost reported. |
| OpenCode (free `deepseek-v4.1-flash-free`) | Headless: `step_finish` `total` of 13,509 to 21,168 tokens per step (one per model call; not summed), `cost: 0`. ACP prompt: input 13,187, output 111. The default paid model was not usable (HTTP 402), so there is no figure for it. |
| Gemini CLI | Not run. |

## 6. Recommendations (per tool; tickets cite this table)

| Ticket | Tool | Recommended transport | Why, in one line |
|---|---|---|---|
| 15 | Claude Code | Headless `claude -p --output-format stream-json --verbose --include-hook-events`, prompt on stdin, one process per attempt; forced tree-kill cancel on Windows, recorded as forced. | Everything needed is on the stream (model, usage, denials); fits `launch` as it is. The graceful interrupt (4.1) is real but needs a duplex stdin and ends only the turn; leave it for later. |
| 16 | Codex | `codex exec --json` started through the process layer. Not the SDK. | The SDK is a wrapper over the same command that hides the PID and kills only the direct child; `exec --json` gives AHP the process. |
| 18 | OpenCode | Native `opencode acp` over stdio, with headless `run --format json` as the fallback. Always set `PWD` and `--cwd`/`--dir` (F1). | ACP is the only transport with real permission requests and a graceful, confirmed turn cancel; needs the duplex process layer (F2). |
| 19 | Gemini CLI | Native `--acp` (as ADR 0001 expects), unconfirmed until run. | Static evidence only. |

**Decisions this report leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Report location: `docs/spikes/2026-10-27-transport-spike-windows.md`.** *Recommended: keep.*
2. **Codex adapter uses `codex exec --json`, not the SDK.** *Recommended: adopt.*
3. **OpenCode adapter uses ACP first, headless as fallback.** *Recommended: adopt; ticket 18 carries the duplex process-layer work.*
4. **Claude Code adapter stays headless one-shot with forced cancel on Windows (ADR 0001); the stream-json `interrupt` is recorded here, not adopted.** *Recommended: keep.* ADR 0001 says ACP `session/cancel` is the only graceful cancel on Windows; this report adds one more graceful turn-cancel (Claude Code's `interrupt`), so that sentence is now incomplete, not wrong. I did not edit the ADR.
5. **The process layer sets `PWD` to the attempt's `cwd` for every agent (F1), and gains a duplex-stdin variant (F2).** *Recommended: do the `PWD` change first, in ticket 15 (it is the first adapter and the change is one line plus a test), the duplex variant in ticket 18.*
6. **Codex's reported model: read it from the thread's session file (`turn_context.model`), labelled with that source, and record `unknown` if the file is absent.** The file is a conversation log in Codex's home, not a credential, but it is outside the repository and AHP so far reads nothing there. *Recommended: adopt, ticket 16 confirms.*
7. **Until their conformance probes say otherwise, tickets 15, 16 and 18 declare `cooperative` at most for the three capabilities on Windows, and `none` for the network stance.** *Recommended: adopt.*
8. **Gemini CLI stays "not run" until paid access exists; ticket 19 runs this spike's six checks then.** *Recommended: keep.*

## 7. Unconfirmed, in one place

Claude Code: effect of the host session's environment variables on a headless run; whether the interrupt kills the shell's grandchild at once; `--strict-mcp-config` removing connector tools; `read_only` as a single tools configuration; user-level settings (all runs used `--setting-sources project`); `--permission-prompts none`. Codex: the SDK's live behaviour; `--json` vs `--experimental-json`; why every write was declined; whether `exec` and `codex sandbox` differ; external network under the sandbox; cancel with a running shell child. OpenCode: ACP without the `PWD` workaround; shell-route bypass of deny rules; why the 402 took 79 s; whether it has any OS sandbox. Gemini CLI: everything. All four: Linux (WSL2) and macOS behaviour, which this spike did not cover.
