# Codex adapter

Adapter name `codex`. It runs the `codex` binary found on `PATH` as `codex exec --json`, one process per attempt, started through the shared process layer (ADR 0001, ticket 16). It is not the Codex SDK (which starts the process itself, so AHP could not own its PID or its process tree) and never `codex app-server`. Transport evidence: `docs/spikes/2026-10-27-transport-spike-windows.md`.

## Your login

AHP stores no credential. The adapter starts the unmodified `codex` binary, which uses whatever login your own `codex` has (`codex login status`; `ahp doctor` reads only its exit code). If that login is a ChatGPT subscription, using it through AHP falls under OpenAI's terms for that subscription, and checking that your use complies is your responsibility; AHP does not interpret those terms and does not discover or report what your plan allows.

If `OPENAI_API_KEY` or `CODEX_API_KEY` is set in the environment AHP runs in, `codex` may use it and bill the API instead of your login. The adapter does not remove variables from the environment; unset them before a run or a conformance run if that is not what you want.

## How an attempt runs

```
codex exec --json --sandbox <read-only|workspace-write> --config approval_policy="never"
           [--config windows.sandbox="unelevated"]        (Windows only)
           --ignore-user-config --ignore-rules --cd <workspace>
           [--model <requested>] [--config model_reasoning_effort="<e>"] [--output-schema <file>] -
```

- The prompt (instructions, what earlier steps handed on, retry evidence, the limits, the fields to report) goes on **stdin**, never in the arguments. The verification command is not in it.
- The sandbox and the approval policy are stated for every attempt, never left to the user's config. The adapter never passes `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox` or `--full-auto`.
- `--ignore-user-config --ignore-rules`: your `config.toml` and execpolicy rules are not loaded, so an attempt behaves the same on every machine. The login is unaffected (it stays in `CODEX_HOME`). Cost: a login that depends on a setting in your `config.toml` (a custom `model_provider`, for example) fails as `config_auth`. Skills and instructions kept elsewhere in your home (for example under `~/.agents`) still load; the flags do not stop that.
- Windows: without `windows.sandbox="unelevated"` Codex has no sandbox on native Windows and declines every command that is not a read, in the workspace too (observed, tickets 14 and 16). `elevated` needs a setup that asks for administrator rights, which AHP does not trigger.
- Output fields (`summary`, `decisions`, ...) are reported through `--output-schema`: the last message is then a JSON object, and the adapter reads it. They are an agent claim that verification checks.
- Session logs are kept (no `--ephemeral`): Codex writes the reported model only there.

### Reported model

`codex exec --json` never names the model that ran. Codex's session log does: `turn_context.model` in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread id>.jsonl` (ticket 14, F4). The adapter finds the log by the thread id on `thread.started` in the newest three day folders, reads that one field and skips every other line unparsed. The log is a conversation record in Codex's own home, not a credential; AHP reads nothing else there.

What this is, exactly: **the model Codex recorded for the turn.** Codex writes it even when the API then refuses the model (observed for a model the login cannot use, and for a missing login), so the adapter reports it only for an attempt in which the model answered. When a step requests a model, the reported one is that name, so it is a record and not independent evidence; when a step requests none, it is the model Codex picked on its own, which is the case where it tells you something (observed: `gpt-5.6-terra` with no `--model`). If the log is not found, the model is `unknown`.

### Usage

From the closing `turn.completed` event: `input_tokens` and `cached_input_tokens` (as `cachedInputTokens`) and `output_tokens`. `input_tokens` **includes** the cached tokens (the tool's own `total_tokens` in its session log was input plus output). Cache writes and reasoning tokens are named in the `source` text, not added to anything. `totalTokens` is always `null` (the stream has no total) and `cost` is always `null` (Codex reports none). A block of all zeros is not recorded. A force-killed attempt prints no `turn.completed`, so it reports no usage.

### Errors

Only a `turn.failed` event ends a turn badly. The top-level `error` events before it (`Reconnecting... 2/5 (...)`) are retry notices and say nothing about how the attempt ended: a missing login produced nine of them, across two transports, before the failure. The class comes from the HTTP status and error code in the failure: a 401 (a missing login: seen) and `model_not_found` (a model the login cannot use: seen) are `config_auth`; 408, 429 and 5xx are `transient` (by what those statuses mean; not seen from Codex); anything else, including the `unsupported_value` 400 that a refused reasoning effort produces (seen), is `agent_error`. A command the sandbox declined (`status: "declined"`) is the agent being told no, not an adapter error.

## Options (`codex({ model, ... })`)

| Option | Meaning |
|---|---|
| `model` | Requested model: a name your login can use (Codex has no aliases). Passed through, not validated; `codex debug models` lists the catalog. |
| `reportFields` | Output fields to report beyond the ones the step requires. |
| `extraInstructions` | Text added to the prompt after the step's instructions. |
| `effort` | `model_reasoning_effort`: `minimal`, `low`, `medium`, `high`, `xhigh`. Whether the model accepts it is the tool's answer. |
| `codexHome` | `CODEX_HOME`: where this attempt's `codex` keeps its login and session logs. It must exist. |

## Capabilities: what is applied, and what it is called

Codex's sandbox is one mode for the whole workspace, so the one capability it can be asked to apply is `read_only`. The declared levels are per system, and each was measured on the system it names or not claimed:

| | Windows | Linux | macOS |
|---|---|---|---|
| `read_only` | **`enforced_by_tool`** (`--sandbox read-only`) | `cooperative` (not measured) | `cooperative` (not measured) |
| `write_scope` | `cooperative` | `cooperative` | `cooperative` |
| `no_external_actions` | `cooperative` | `cooperative` | `cooperative` |
| network `deny`, `package_registries` | `none` | `none` | `none` |

What was observed on native Windows (Codex 0.146.0, `windows.sandbox="unelevated"`, the agent told to try each action and report; the repository outside `%TEMP%`, and left-behind files and a local listener's request log as the evidence):

| Mode | A file in the workspace | A file outside the workspace | A request to a local listener |
|---|---|---|---|
| `read-only` | not written | not written | **reached** |
| `workspace-write` | written | not written (but written under `%TEMP%`, below) | **reached** |

- `read_only` is `enforced_by_tool` on Windows because the conformance suite's probe passed: the same agent, with the level recorded `none` (so `workspace-write`), wrote the file, and with `read_only` applied it was left unwritten, in the suite's run and in two probes of my own. The agent is told to try the shell and then the `apply_patch` tool. This is one agent, one Codex version, one Windows; it is a measurement, not a proof that no route exists.
- `workspace-write` writes to the workspace **and to `%TEMP%`** (a repository under `%TEMP%` let the agent write a sibling directory there; one outside it did not). AHP's worktrees live under `AHP_HOME`, not in `%TEMP%`, but the sandbox is not "the worktree and nothing else".
- A path scope cannot be given to a sandbox mode, so `write_scope` is asked in words (`cooperative`). Codex's permission profiles were not explored.
- `no_external_actions` is asked in words. AHP's own check of the shared refs after the attempt (`forbidden_external_action_detected`) is what catches the rest.
- The network stance is not applied: a request to a local listener got through under both modes. External hosts were not tested.
- Linux and macOS: nothing was measured, so nothing above `cooperative` is claimed. `--sandbox read-only` is still passed there for a `read_only` step. Run the suite on Linux to find out what it does (below); a measured level is a one-line change to the declaration.

A step that requires `read_only` at `enforced_by_tool` is accepted on Windows and rejected on Linux and macOS (`capability_unsatisfiable`). The sandbox mode is chosen from the **level recorded** for the attempt, not from the request: a request recorded at `none` runs `workspace-write`, which is what lets the conformance suite's control run break the capability.

## Cancel

Headless `codex exec` has no graceful stop. A cancel is the shared process layer's: on Windows a forced kill of the whole process tree, **recorded as forced**; on Linux and macOS SIGTERM to the process group, then a tree kill. Observed on Windows through the conformance suite: with the agent's shell running a child that ignores every signal, the cancel stopped all three processes (the ticket 14 spike had left this unconfirmed). A cancelled attempt reports no usage.

## Conformance results

Recorded per OS in `conformance/results/` and rendered by `npm run conformance -- matrix`. Run by the maintainer, under their own login, never in CI:

```
env -u OPENAI_API_KEY -u CODEX_API_KEY npm run conformance -- run codex
```

The suite requests no model, so Codex runs its own default and the name it logs is a report, not an echo (set `AHP_CONFORMANCE_CODEX_MODEL` to request one, for a login that cannot use the default; Codex logs the name it was asked for, so `model:reported` is then skipped as an echo). Three checks are recorded `unprovokable` and named on the cell: `failure:transient` (no way to cause a rate limit), and `model:not_reported` and `usage:not_reported` (the tool states both on every run). Everything else the suite asks of this adapter passed on native Windows (the matrix shows the date and the tool version). The Linux (WSL2) cell is recorded only by running the same command there.

## Not known

Linux and macOS behaviour of every sandbox mode, and so the levels there; external-network behaviour under either mode; the `elevated` Windows sandbox; Codex's permission profiles as a way to hold a path scope; whether the session log's folder or name changes between versions (the adapter then reports `unknown`); `--json` output of versions other than 0.146.0.
