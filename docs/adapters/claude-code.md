# Claude Code adapter

Adapter name `claude-code`. It runs the `claude` binary found on `PATH`, headless, one process per attempt (ADR 0001, ticket 15). Transport evidence: `docs/spikes/2026-10-27-transport-spike-windows.md`.

## Your login, and Anthropic's terms

AHP stores no credential. The adapter starts the unmodified `claude` binary, which uses whatever login your own `claude` has (`claude auth status` shows it; `ahp doctor` reads only whether it is logged in). If that login is a subscription, **using it through AHP falls under Anthropic's terms for that subscription, and checking that your use complies is your responsibility.** AHP does not interpret those terms, does not check them, and does not discover or report what your subscription allows. The adapter never uses the Claude Agent SDK and never adds or removes `--bare`.

If `ANTHROPIC_API_KEY` is set in the environment AHP runs in, `claude` may use it and bill the API instead of your login; the usage `source` of each attempt records the tool's `apiKeySource` so a ledger shows which.

## How an attempt runs

```
claude -p --output-format stream-json --verbose --permission-mode dontAsk
       --tools <named set> --settings <file> --setting-sources project
       --strict-mcp-config --no-session-persistence
       [--model <requested>] [--effort <e>] [--max-budget-usd <n>] [--json-schema <fields>]
```

- The prompt (instructions, what earlier steps handed on, retry evidence, the limits, the fields to report) goes on **stdin**, never in the arguments. The verification command is not in it.
- `--model` is passed only when the step requests a model. The model **reported** is read from the tool's own answers in the stream and recorded separately; if the tool names none, it is `unknown`. A failed login names none.
- Output fields (`summary`, `decisions`, ...) are reported through `--json-schema`, whose result Claude Code returns as `structured_output` on the closing `result` event. They are an agent claim that verification checks.
- `--setting-sources project`: your user-level and local Claude Code settings are not loaded, so an attempt behaves the same on every machine. The settings AHP writes (`--settings`) and the repository's own project settings apply. `--strict-mcp-config` loads no MCP servers.
- Usage comes from the `result` event only: `input_tokens`, `output_tokens`, `cache_read_input_tokens` (as `cachedInputTokens`) and `total_cost_usd` (a list-price figure the tool prints, labelled so; not a charge). `input_tokens` excludes cache reads and cache writes, and the `source` text says how many cache writes were reported and left out. `totalTokens` is always `null`. A force-killed attempt prints no `result`, so it reports no usage. A block of all zeros (what the tool prints for a failed login) is not recorded.
- Errors are read from the closing `result` event and the error code on the assistant message that carries it, never from `rate_limit_event` (which is sent on healthy runs): `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `cloud_credential_error` and `model_not_found` are `config_auth`; `rate_limit`, `overloaded` and `server_error` are `transient`; anything else the tool calls an error is `agent_error`. The code list is read from the installed 2.1.311's own schema (static evidence).

## Options (`claudeCode({ model, ... })`)

| Option | Meaning |
|---|---|
| `model` | Requested model: an alias such as `sonnet`, or a full name. Passed through, not validated. |
| `reportFields` | Output fields to report beyond the ones the step requires. |
| `extraInstructions` | Text added to the prompt after the step's instructions. |
| `effort` | `--effort`: `low` ... `max`. |
| `maxBudgetUsd` | `--max-budget-usd`: the tool stops the attempt (an agent error) past its own cost figure. |
| `configDir` | `CLAUDE_CONFIG_DIR`: where this attempt's `claude` keeps its login and settings. |

## Capabilities: what is applied, and what it is called

The adapter declares **`cooperative` at most for all three capabilities on Windows, Linux and macOS, and `none` for both network stances.** Nothing it applies is enforcement (ADR 0001, `GLOSSARY.md`).

| Capability | Applied through |
|---|---|
| `read_only` | The file-writing tools (`Write`, `Edit`, `NotebookEdit`) are left out of `--tools`, denied by rule, and refused by the hook; the prompt says to change nothing. `Bash` remains. |
| `write_scope` | The hook refuses `Write`/`Edit`/`MultiEdit`/`NotebookEdit` outside the listed paths; the prompt says the same. `Bash` remains. |
| `no_external_actions` (every agent step) | Deny rules `Bash(git push:*)`, `Bash(git update-ref:*)`, `Bash(gh:*)`; the prompt says so. AHP's own check of the shared refs after the attempt (`forbidden_external_action_detected`) is what catches the rest. |
| Network stance | Nothing applied (`none`). `WebFetch` and `WebSearch` stay in the tool set for either stance. |

Why `cooperative` and not more: on native Windows an agent with `Bash` wrote a protected file with `node -e` and created a file past a hook that matched a path, and Claude Code's OS sandbox is off there (spike F3, observed). So the rules and the hook stop the tool calls they see, not what a shell command reaches. No Linux or macOS evidence says otherwise. A level above `cooperative` needs a probe that passes the conformance suite's `enforced_by_tool` check on that system (a configuration without `Bash` is the candidate); until then the adapter refuses to be recorded at a level it does not declare.

The hook is also registered for every attempt, with or without a capability: Claude Code's file tools write anywhere an allow rule reaches (observed: a `Write` outside the working directory succeeded under `dontAsk`), so the hook keeps them inside the attempt's workspace and out of `.git`. That is a guard on file-tool calls and is not a declared capability.

Tool set: `Bash, Read, Write, Edit, NotebookEdit, Glob, Grep, WebFetch, WebSearch`. Claude Code's default set also holds tools that schedule jobs, send notifications and start subagents, and a PowerShell tool whose commands the `Bash` rules would not cover.

The settings file and the hook's policy are written to a temporary directory outside the worktree and removed when the attempt ends. The hook is `node <hook script> <policy>` using the Node that runs AHP, with forward-slash paths in double quotes.

## Cancel

Headless `claude -p` has no stop AHP uses short of ending the process. A cancel is the shared process layer's: on Windows a forced kill of the whole process tree, **recorded as forced**; on Linux and macOS SIGTERM to the process group, then a tree kill. Claude Code's stream-json `interrupt` ends a turn and leaves the process up; it was observed in the spike and is not used (ticket 14, decision 4). A cancelled attempt reports no usage.

## Conformance results

Recorded per OS in `conformance/results/` and rendered by `npm run conformance -- matrix`. Run by the maintainer, under their own login, never in CI:

```
npm run conformance -- run claude-code
```

Checks the tool cannot be made to do are skipped, never passed, so the outcome is `untested` until they can be: `failure:transient` (no way to cause a rate limit), `model:not_reported` and `usage:not_reported` (the tool states both on every run). Everything else the suite asks of this adapter passed on native Windows (see the matrix for the date and the tool version). The Linux (WSL2) cell is recorded only by running the same command there.

## Not known

Effect of the host session's `CLAUDE*` variables on a headless run; whether a configuration without `Bash` and connector tools is a probe-passing `enforced_by_tool` for `read_only` and `write_scope`; whether `--strict-mcp-config` removes every connector tool of every account; behaviour on Linux and macOS.
