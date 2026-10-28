# OpenCode adapter

Adapter name `opencode`. It runs the `opencode` binary found on `PATH` as `opencode acp`, OpenCode's own Agent Client Protocol server, over stdio, one process per attempt, started through the shared process layer (ADR 0001, ticket 18). AHP is the ACP client: there is no third-party bridge and no ACP library, and the protocol code is a few hundred lines (`src/adapters/acp/connection.ts`, shared with the Gemini CLI adapter). The transport was chosen in `docs/spikes/2026-10-27-transport-spike-windows.md` (decision 3); the headless `opencode run --format json` fallback it mentions is not implemented.

## Your login

AHP stores no credential. The adapter starts the unmodified `opencode` binary, which uses whatever providers and logins your own `opencode` has (`opencode auth login`). `ahp doctor` cannot read OpenCode's login status: its only status command prints stored credentials as free text, which AHP does not read.

OpenCode also picks provider keys up from the environment (`OPENAI_API_KEY` was used silently in testing, and rejected: "Incorrect API key provided"). The adapter does not remove variables from the environment; unset the ones you do not want a run, or a conformance run, to bill.

## How an attempt runs

```
opencode acp --pure --cwd <workspace>
  OPENCODE_CONFIG_CONTENT=<this step's permission rules>
  OPENCODE_DISABLE_CLAUDE_CODE=1  OPENCODE_DISABLE_EXTERNAL_SKILLS=1
```

and then, over the process's stdin and stdout, one conversation:

1. `initialize`, declaring **no** client capabilities (no file system, no terminal): AHP offers the agent nothing but permission answers.
2. `session/new` with the workspace as `cwd` and no MCP servers.
3. `session/set_config_option` for the `model` option, only when the step requests a model. If OpenCode refuses it (it lists the models it can select), the attempt fails as `config_auth` and **no prompt is sent**: the run never falls back to the default model.
4. `session/prompt` with the prompt as text (instructions, what earlier steps handed on, retry evidence, the limits, the fields to report). The verification command is not in it.
5. When the turn is over, AHP **ends the process's stdin**, which is how an ACP agent is told to finish and exit. A process that has not exited ten seconds later is stopped, tree and all.

Notes on the flags: OpenCode takes its working directory from the inherited `PWD`, not the process's cwd (spike F1), so the launch sets `PWD` to the workspace and `--cwd` repeats it. `--pure` runs without external plugins. The two environment variables keep your Claude Code skills and agent files (`~/.claude`) from being loaded as this attempt's instructions: without them 52 commands were offered in the test session, with them 17. `--pure` alone changed nothing in that count. Skills in OpenCode's own configuration still load.

### Reporting fields

OpenCode has no structured-output option over ACP. The prompt asks for the step's output fields (`summary`, `decisions`, `verdict`, `findings`, ...) as **one JSON object that is the whole of the final message**, and the adapter reads the last message, bare or in a code fence, keeping only text and lists of text. It is an agent claim that verification checks: a model that answers in prose reports no fields, and the step then goes through the usual path for missing required fields (a retry with that evidence). A reporting tool served to the agent over MCP would be more reliable and is a bigger change (see the ticket's open decisions).

### Reported model

ACP reports the models a session can **select** (`configOptions`), not the model that answered, and what it reports as the current one is a selection. The adapter therefore never uses it. After the process has exited, and only for an attempt in which the model did something, it runs `opencode export <session>` and reads `providerID` and `modelID` from the last assistant message, which is OpenCode's own record of the session; it reports them as `provider/model`. If the export cannot be read, the model is `unknown`. As with Codex, when a step requests a model the recorded one is normally the same name, so it is a record, not independent evidence; with no requested model it is the model OpenCode picked on its own.

### Usage

From the `session/prompt` result: `inputTokens`, `outputTokens`, `totalTokens` and `cachedReadTokens` (as `cachedInputTokens`). Measured on the real tool, `inputTokens` **excludes** the cached read tokens and `totalTokens` is input + output + thought + cached read (this is Claude Code's convention, not Codex's); `thoughtTokens` and `cachedWriteTokens`, when present, are named in the `source` text and not added. A block of zeros (what a cancelled turn returns) is not recorded. **Cost** is taken from the last `usage_update` only when it is above zero: OpenCode reports `0` for a model it does not price (the free tier, or a subscription), and that is not a report that nothing was charged.

### Errors

OpenCode's errors are JSON-RPC errors with a code and the provider's text, and no HTTP status. A turn that fails this way leaves the process exiting **0**, so the adapter records the error itself. The class comes from what the message says: `model not found` for a model it does not list (code -32602, seen) and a rejected key (seen) are `config_auth`; a rate limit, an overload or a 5xx are `transient` (by what those messages mean; not seen from OpenCode); a quota or payment problem and everything else are `agent_error`. Keys (`sk-...`, masked or not) and bearer tokens are removed from the message, which is cut at 500 characters, because the ledger is a public record.

## Options (`opencode({ model, ... })`)

| Option | Meaning |
|---|---|
| `model` | Requested model, as `provider/model`, one the session lists. Passed through as OpenCode's `model` config option. |
| `reportFields` | Output fields to report beyond the ones the step requires. |
| `extraInstructions` | Text added to the prompt after the step's instructions. |

There is deliberately no option for the permission rules or the config, so a step cannot weaken what its capabilities recorded.

## Capabilities: what is applied, and what it is called

Everything is `cooperative` on every system, and nothing was measured by an `enforced_by_tool` probe; the network stance is not applied (`none`). **An ACP `session/request_permission` is a question the client may answer either way, and OpenCode's permission rules guard OpenCode's own tool calls: neither is enforcement.** An agent with a shell reaches files and refs around both (shown for Claude Code on Windows in the spike, F3; not tested for OpenCode).

What is applied, through `OPENCODE_CONFIG_CONTENT` (inline config, which a file in the worktree cannot weaken):

| Step lists | OpenCode rule | AHP's answer to a permission request |
|---|---|---|
| `read_only` | `edit: deny` | rejects any write |
| `write_scope` | `edit: ask` | allows a write under the listed paths, rejects the rest |
| neither | `edit: ask` | allows a write inside the workspace, rejects one outside it or into `.git` |
| `no_external_actions` (every step) | `bash` deny patterns `git push*`, `git update-ref*`, `gh *` (observed: `git push` came back `failed` without a prompt) | rejects a shell command that starts with one |

For every request that does reach AHP (also those your own OpenCode config makes it ask): a path outside the workspace, or a write into `.git`, is rejected; anything else is answered **`allow_once`**, never `allow_always`, which would outlive the attempt in your own rules. Every agent→client request that is not a permission request (OpenCode asks to write a file through the client after an approved edit, although none was offered) is answered "method not found"; OpenCode logs a stack trace to stderr and carries on, the file having been written by its own tool (observed). Stderr is not read.

## Tool-call log

Each tool call OpenCode reports (`tool_call`, `tool_call_update`) is appended, as it happens, to a file the runtime owns (`<git common dir>/ahp/runs/<run>/tool-calls/<attempt>.jsonl`): the call's kind, title (for a shell command, the command, cut at 300 characters), status, paths relative to the workspace, and AHP's answer to a permission request. Never the call's input or output. The recovery report of an attempt whose outcome is unknown (`ahp recover`) lists the last 100 entries, which is how you see what the agent was doing when its process was lost. The file is created when the attempt starts, so an attempt lost before any tool call shows an empty log (the agent had made none), not "none". A command's text can contain whatever the agent typed; the file stays in the repository's `.git` directory, as the ledger does.

## Cancel

The transport's own: AHP sends `session/cancel`, waits for the turn to end (`stopReason: cancelled`; the process does **not** exit by itself, observed), then ends stdin. The process layer confirms every process of the tree gone, and kills the tree only if that does not happen within the grace period; the cancel is then recorded as forced. Observed through the conformance suite, with the agent's shell running a tree of three processes that ignore signals: on Windows the cancel cleared them all without force (`via: transport`); on Linux (WSL2) it did not, because OpenCode starts shell commands in a session of its own, which the agent's process group does not hold, and they outlived OpenCode. The process layer therefore reads the agent's descendants by parent PID before it sends anything (on Linux and macOS, as it already did on Windows) and kills what the transport left, recorded as forced (`via: tree_kill`). A cancelled turn reports no usage (all zeros, not recorded) and no stop reason, and no model: `opencode export` is a process outside the cancelled tree, so it is not run for a cancelled attempt.

## Conformance results

Recorded per OS in `conformance/results/` and rendered by `npm run conformance -- matrix`. Run by the maintainer, never in CI:

```
env -u OPENAI_API_KEY -u CODEX_API_KEY -u ANTHROPIC_API_KEY npm run conformance -- run opencode
```

The suite requests OpenCode's free-tier model `opencode/deepseek-v4.1-flash-free`, which needs no payment (set `AHP_CONFORMANCE_OPENCODE_MODEL` for another). Checks the tool cannot be made to do are recorded `unprovokable` and named on the cell: `failure:agent_error` (no reliable way to make a turn fail), `failure:config_auth` (the free model needs no login), `failure:transient` (no way to cause a rate limit), and `model:not_reported` and `usage:not_reported` (the tool states both on every run). `model:reported` is skipped, so the outcome stays `untested`: the recorded name equals the request, and the suite cannot tell a report from an echo. Everything else the suite asks of this adapter passed on native Windows (OpenCode 1.18.35) and on Linux under WSL2 (OpenCode 1.19.4); the matrix shows the dates. The checks that ask the free model to write and run a script depend on it doing so: one Linux run failed `cancel:forced_tree` because the model had not run the script within 30 s (the check then reports that, not a cancel result), and the same check passed three times in a row straight after.

## Not known

macOS behaviour; the Linux `PWD` behaviour (the launch sets it, and the Linux run worked); whether any shell route gets around the deny rules and the permission answers (not tested); how OpenCode merges inline config with a user's own `permission` config of another shape; OpenCode versions other than 1.18.35; `session/set_model` and the other ways to choose a model; a rate limit's wording; what `--pure` changes for a user who has plugins (none were installed).
