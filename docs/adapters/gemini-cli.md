# Gemini CLI adapter

Adapter name `gemini-cli`. It runs the `gemini` binary found on `PATH` as `gemini --acp`, Gemini CLI's own Agent Client Protocol server, over stdio, one process per attempt, started through the shared process layer (ADR 0001, ticket 19). AHP is the ACP client: there is no third-party bridge and no ACP library (`src/adapters/acp/connection.ts`, shared with the OpenCode adapter). `--experimental-acp` is deprecated in the tool's help and is not used.

## Read this first: this adapter has never run a turn

**Gemini CLI needs paid access** (a paid Gemini API key or a Code Assist licence; `ahp doctor` says so, and AHP cannot tell whether yours qualifies). The maintainer has none, so no prompt has ever been sent through this adapter and **no conformance result is recorded for it**: the support matrix keeps saying "not run". Every statement below is tagged:

- **Observed**: printed by a real `gemini` 0.42.0 on Windows. Only two things: the reply to `initialize`, and the failure of `session/new` with no login (`Gemini API key is missing or not configured.`, code -32000). A policy file was also read by the real tool: a file of the shape this adapter writes raised no error, an empty one raised none, and one with an unknown `decision` printed `Policy file error`.
- **Source**: read from the tool's own bundled source (0.42.0, `packages/cli/src/acp`) and not seen on a live run. The tests' fake `gemini` replays messages written from that source; `test/fixtures/gemini-cli/captures.json` says which are live and which are not.
- **Unconfirmed**: everything else.

If a statement is not tagged, it is about AHP's own behaviour. Replace the source-derived fixtures with captures as soon as a run with access exists (see "Running the conformance suite").

## Your login

AHP stores no credential and **never calls `authenticate`**. The adapter starts the unmodified `gemini` binary, and `session/new` uses the login the tool already has: the auth type saved in its settings, or, when none is, a Gemini API key from its environment or settings (**source**). `authenticate` would make the tool write the chosen method into your own settings file (**source**), so AHP leaves it alone; with no login, the attempt fails as `config_auth` and no prompt is sent (**observed**: code -32000, "Gemini API key is missing or not configured."). `ahp doctor` cannot read Gemini CLI's login status (it has no status command), so it says `unknown`.

## How an attempt runs

```
gemini --acp --approval-mode default --policy <temp file> [--model <requested>]
```

and then, over the process's stdin and stdout, one conversation:

1. `initialize`, declaring **no** client capabilities (no file system, no terminal): AHP offers the agent nothing but permission answers (**observed** reply: protocol version 1, four auth methods, `loadSession`).
2. `session/new` with the workspace as `cwd` and no MCP servers of AHP's own (the tool still merges the MCP servers in the user's own settings, **source**). The reply must say `modes.currentModeId` is `default` (**source**: it is `config.getApprovalMode()`); anything else, or no mode, fails the attempt as `config_auth` and **no prompt is sent**, because a mode that approves without asking would run the step with none of AHP's permission answers asked.
3. `session/prompt` with the prompt as text (instructions, what earlier steps handed on, retry evidence, the limits, the fields to report). The verification command is not in it.
4. When the turn is over, AHP **ends the process's stdin**, which is how an ACP agent is told to finish and exit (**observed**: the real tool exited 0 on it, after the two calls above).

About the flags (**source** unless noted):

- `--approval-mode default` is what the user's own `general.defaultApprovalMode` cannot override: with the flag, the settings value is not read. An `auto_edit` there would otherwise approve edits with no request reaching AHP. A worktree is not a trusted folder, and the tool forces the default mode there anyway.
- `--policy <file>` is Gemini CLI's own policy file. It **replaces** the user's policy directory for the run, so a saved "always allow" rule in your policy directory does not apply to an attempt. What does still apply (**source**): an admin (system-wide) policy; allow rules the tool derives from your settings (`tools.allowed`, MCP servers marked `trust`), which sit below AHP's deny rules but mean no permission request reaches AHP for those tools, so `write_scope` is not applied to them. The file is in the system temp directory, outside the worktree, and is removed when the attempt ends.
- **No `--skip-trust`.** The worktree stays untrusted (**observed** on the real tool: "Skipping project agents due to untrusted folder", "Project hooks disabled because the folder is not trusted"), so a hook, agent or setting file inside the worktree is not loaded. No `--yolo`, no sandbox flag.
- `--model <m>` when the step requests one. It is passed on unvalidated and is **not** checked against the models `session/new` lists: that list does not hold aliases the tool accepts. A model the API refuses fails the prompt (a 404 is `config_auth`). Whether the tool ever substitutes another model on its own (a fallback after a quota error) is unconfirmed; if it does, the reported model below is what shows it.

### Reporting fields

Gemini CLI has no structured-output option over ACP. As for OpenCode, the prompt asks for the step's output fields as **one JSON object that is the whole of the final message**, and the adapter reads the last message, bare or in a code fence, keeping only text and lists of text. It is an agent claim that verification checks: a model that answers in prose reports no fields, and the step goes through the usual path for missing required fields.

The tool's message chunks carry no message id (**source**), so the adapter starts a new message after each tool call and reads only the last one: narration before a tool call is never taken for the report. The tool also injects `[MODE_UPDATE] <mode>` text as a message chunk when the approval mode changes (**source**); those chunks are dropped.

### Reported model

The prompt result's `_meta.quota.model_usage` names the model each model call of the turn was filed under (**source**). The tool names the model that answered for the first call of a turn (`model_info`), but files a later call under its **configured** model, which may be an alias such as `auto-gemini-2.5`. So the adapter reports a model **only when every call is under one name**; with two or more names, or none, the model is `unknown`. A single name is the tool's account, but with a requested model it is normally the same name, so it is a record, not independent evidence (the conformance suite skips `model:reported` as an echo for that reason). The models a session can select (`models.availableModels`) are a selection and are not used; they are why the declaration says `enumerable`.

### Usage

From the prompt result's `_meta.quota.token_count`: `input_tokens` (the tool's `promptTokenCount`) and `output_tokens` (its `candidatesTokenCount`), which the tool sums over the model calls of the turn (**source**). The `source` text recorded with them says so. Not reported, so `null`, never 0, never estimated: the total, cached tokens (the prompt count includes them and the tool does not separate them), thought tokens (in neither count) and cost. A block of zeros (what the tool returns for a slash command, answered without a model) is not recorded.

### Errors

A failed prompt is a JSON-RPC error whose **code is an HTTP status** (**source**: 429 with "Rate limit exceeded. Try again later." for a rate limit; the API's own status for others; 500 for any error the tool cannot name). A turn that fails this way leaves the process exiting 0, so the adapter records the error itself. Classes: a failure of `session/new` is `config_auth` (no model ran); 401, 403 and 404 are `config_auth` (a rejected key, no access, a model this login cannot use); 408, 429, 502, 503 and 504 are `transient`; a plain 500 is `agent_error`, because it is the tool's catch-all, not a sign of an outage that waiting clears; for other codes the message decides (a quota or payment problem is `agent_error`). A 429 can be a daily quota, which waiting does not clear: it is `transient` because the tool does not say which. Keys (Google `AIza...`, `sk-...`, bearer tokens) are removed from the message, which is cut at 500 characters, because the ledger is a public record.

## Options (`geminiCli({ model, ... })`)

| Option | Meaning |
|---|---|
| `model` | Requested model, passed as `--model`. |
| `reportFields` | Output fields to report beyond the ones the step requires. |
| `extraInstructions` | Text added to the prompt after the step's instructions. |

There is deliberately no option for the approval mode, the policy, the sandbox or trust, so a step cannot weaken what its capabilities recorded.

## Capabilities: what is applied, and what it is called

Everything is `cooperative` on every system, and nothing was measured by a conformance probe; the network stance is not applied (`none`). **An ACP `session/request_permission` is a question the client may answer either way, and Gemini CLI's policy engine guards Gemini CLI's own tool calls: neither is enforcement.** An agent with a shell reaches files and refs around both (shown for Claude Code on Windows in the spike, F3; not tested for Gemini CLI). The tool has a `--sandbox` option; its behaviour on Windows is unconfirmed and AHP does not use it.

What is applied:

| Step lists | Policy file rule (deny) | AHP's answer to a permission request |
|---|---|---|
| `read_only` | tools `write_file`, `replace` | rejects any write |
| `write_scope` | none | allows a write under the listed paths, rejects the rest |
| `no_external_actions` (every step) | `run_shell_command` with `commandPrefix` `git push`, `git update-ref`, `gh` | rejects a shell command that starts with one |

The policy file is the tool's own format, and the real tool read a file of this shape without complaint (**observed**); that a deny rule stops a tool call has not been seen. For a permission request that reaches AHP (**source**: `kind` is `edit`, `execute`, ..., `locations` the paths, and for a shell call the `title` is the command itself): a path outside the workspace, or a write into `.git`, is rejected; a write outside the write scope is rejected; a shell command starting with an external-action command is rejected; anything else is answered **`allow_once`**, never `allow_always` (which would outlive the attempt). Every agent→client request that is not a permission request is answered "method not found". Stderr is not read: the tool reports an unreadable policy file there and carries on **without** its rules (**observed**), which is why a test checks the file's shape.

## Tool-call log

Each tool call Gemini CLI reports (`tool_call`, `tool_call_update`) and each permission answer is appended, as it happens, to a file the runtime owns, as for OpenCode: kind, title (for a shell command, the command), status, paths relative to the workspace, AHP's answer; never the call's input or output. `ahp recover` lists the last 100 entries for an attempt whose outcome is unknown.

## Cancel

The transport's own: AHP sends `session/cancel`, waits for the turn to end (`stopReason: cancelled`), then ends stdin. The process layer confirms every process of the tree gone and kills the tree only if that does not happen within the grace period, recorded as forced. That `session/cancel` stops a turn is **source** (it aborts the pending prompt; with no turn in flight the tool raises "Not currently generating", which a notification ignores); that the tool then exits on the end of stdin is **observed** for an idle session only. Whether the tool takes a running shell command with it is unconfirmed, and the process layer's descendants check covers it either way. A cancelled turn reports no usage and no model.

## Running the conformance suite (needs access)

The cell for each OS is recorded by the maintainer, on their machine, never in CI, once Gemini CLI can be used:

```
# unset what you do not want the tool to bill; GEMINI_API_KEY (or a saved Google login) is the tool's own login
npm run conformance -- run gemini-cli        # Windows (native)
npm run conformance -- run gemini-cli        # Linux (WSL2), in a Linux checkout with a Linux gemini on PATH
```

The suite requests `gemini-2.5-flash` (a model named as the flash default in the tool's source; set `AHP_CONFORMANCE_GEMINI_MODEL` for another). It leaves `fails`, `login_problem`, `rate_limited`, `no_model_report` and `no_usage_report` unprovoked, as for OpenCode, so the outcome is expected to be `untested` even when nothing fails; the checks of the `cooperative` levels are checks that they are accepted. Commit `conformance/results/gemini-cli--*.json` afterwards, and replace the source-derived messages in `test/fixtures/gemini-cli/captures.json` with captures from the run.

## Not known

Everything past `session/new` on a live tool: the shape of the updates and of the permission request; whether `_meta.quota` is present and what it counts; whether `session/cancel` ends a turn that is inside a tool call; whether `--approval-mode default` and the `--policy` file behave in ACP mode as the source says; a deny rule stopping a call; whether the tool silently falls back to another model; the OAuth route (not tried: it opens a browser and writes to your settings); the sandbox; macOS; Gemini CLI versions other than 0.42.0.
