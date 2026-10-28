# 15: Claude Code adapter

**What to build:** A developer can assign steps to Claude Code. The adapter runs the unmodified `claude` binary headless under the user's existing login (ADR 0001) and passes the conformance suite on Windows and Linux (WSL2).

**Blocked by:** 12, 14

**Status:** done

**Model:** Sonnet 5.5 · high

- [x] Uses headless `claude -p` with stream-json output; never the Agent SDK; never adds or removes `--bare`
- [x] Capabilities applied via settings, deny rules and `PreToolUse` hooks written as Node scripts; enforcement levels declared per OS from spike evidence
- [x] Requested model passed through; reported model and usage recorded where emitted
- [x] Cancellation recorded as forced on Windows headless
- [x] Passes the conformance suite on Windows native and Linux (WSL2, worktrees in the Linux filesystem); results recorded as matrix cells
  - [x] Windows native: recorded, `conformance/results/claude-code--windows.json`. 14 checks passed, none failed, 2 not applicable, 3 skipped (the tool cannot be made to do them), so the outcome is `untested`, not `passed` (see decision 7)
  - [x] Linux (WSL2): recorded 2026-10-28, `conformance/results/claude-code--linux-wsl2.json`, Claude Code 2.1.312: `passed`, with `failure:transient`, `model:not_reported` and `usage:not_reported` recorded `unprovokable` (ticket 24). The Windows cell was re-run the same day with 2.1.312 and is `passed` too
- [x] Docs state subscription use falls under Anthropic's terms and is the user's responsibility (`docs/adapters/claude-code.md`)

## Implementer notes

- Transport spike evidence: `docs/spikes/2026-10-27-transport-spike-windows.md`. Its decisions 4, 5 and 7 are confirmed and were followed, not reopened.
- Real `claude` never runs in a test. The adapter's tests use a fake `claude` that prints streams captured from the real 2.1.311 (scrubbed of paths, ids and account data).
- If `claude` asks for a login, payment or terms acceptance, stop and ask; never log in or accept on the maintainer's behalf.

## Comments

2026-10-27, implementation notes. User doc: `docs/adapters/claude-code.md`; code `src/adapters/claude-code/`; tests `test/claude-code.test.ts`.

**What was done and observed on the real tool (Windows, `claude` 2.1.311, the maintainer's own login, `apiKeySource: none`).**
- `launch` now sets `PWD` to the attempt's `cwd` (spike decision 5), with a test in `test/process.test.ts`.
- Real streams were captured through `launch` for a normal completion with `--json-schema`, a missing login (an empty `CLAUDE_CONFIG_DIR`), a `--max-budget-usd` stop, and a hook payload; the first three are the test fixtures. Findings: `--json-schema` returns the fields as `structured_output` on the `result` event (and adds a `StructuredOutput` tool); a missing login is `is_error: true` with `terminal_reason: api_error`, an assistant message with `model: "<synthetic>"` and `error: "authentication_failed"`, a result with an all-zero `usage`, and exit 1; a budget stop is `subtype: error_max_budget_usd`, exit 1; the hook payload carries `tool_name`, `tool_input.file_path` (absolute, backslashes) and `cwd`.
- **Under `--permission-mode dontAsk` with `Write` allowed, a `Write` to `../outside.txt` succeeded** (the file was created above the working directory). The allow rule alone does not confine the file tools, so the hook now refuses writes outside the workspace and under `.git` for every attempt.
- Probes through the adapter itself under that configuration: with `write_scope: [scope]` the hook blocked `outside/b.txt` and `../c.txt` and allowed `scope/a.txt` (left-behind files checked); `Bash(gh:*)` was denied. For `read_only` and `no_external_actions` the model followed the prompt, so that run says nothing about bypass; the Bash bypass of rules and hooks stays as the spike observed it (F3), which is why nothing is declared above `cooperative`.
- Error codes the tool puts on assistant messages were read from the installed binary's own schema (static, not run): `authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required, billing_error, rate_limit, overloaded, invalid_request, model_not_found, server_error, unknown, max_output_tokens, cloud_credential_error`. Only `authentication_failed` and the budget stop were seen in a run.
- Ripple: registering `claude-code` makes `ahp init` cast an installed `claude`. Two `test/init.test.ts` tests had assumed no usable tool and one of them ran the real `claude` end to end; they now run `ahp` with `pathWithoutTools()` (git and Node only on PATH).

**Linux (WSL2) cell: not done.** The distro (Ubuntu) has no Linux Node, no Linux `claude` (the `claude` on its PATH is the Windows one through `/mnt/c`), and no login. I did not install or log in anything there. To record the cell, in the WSL2 shell:

```
# one time: Node >= 24 and a Linux claude (check `which claude` is not under /mnt/c), then log in yourself
npm install -g @anthropic-ai/claude-code && claude          # log in when it asks
git clone https://github.com/Mohaned178/agent-handoff-protocol ~/ahp && cd ~/ahp && git checkout main && npm ci   # in the Linux filesystem, not /mnt/c
env -u ANTHROPIC_API_KEY npm run conformance -- run claude-code
```

Then commit `conformance/results/claude-code--linux-wsl2.json`. The run spends about a dozen short attempts (list-price figure of a few cents each, on the maintainer's own login).

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Permission mode `dontAsk` with an explicit allow list and a named tool set** (`Bash, Read, Write, Edit, NotebookEdit, Glob, Grep, WebFetch, WebSearch`; no PowerShell, subagent, scheduling or notification tools), never `bypassPermissions`. *Recommended: adopt.* Web tools stay in for both network stances because the stance is declared `none`.
2. **`--setting-sources project` and `--strict-mcp-config`**: the user's and local Claude Code settings and MCP servers are not loaded, so an attempt behaves the same on every machine. *Recommended: adopt.* Cost: a login that depends on a user-level setting (an `apiKeyHelper`, a Bedrock/Vertex environment in settings) fails as `config_auth`; the `configDir` option and the environment still work.
3. **Adapter options `reportFields`, `extraInstructions`, `effort`, `maxBudgetUsd`, `configDir`.** The first two are how the conformance subject, and a user, ask for extra fields or instructions; `configDir` is how a missing login is provoked. *Recommended: adopt.*
4. **Declaration: `cooperative` for all three capabilities on every OS, network `none`** (decision 7, applied). *Recommended: adopt.* A later ticket can try `read_only` and `write_scope` as `enforced_by_tool` with a configuration that has no `Bash` and no connector tools, once its probe passes on Windows and WSL2; it changes what a step can do (no shell), so it should be its own decision.
5. **The file-tool hook runs for every attempt and confines writes to the workspace and out of `.git`**, beyond the three declared capabilities, because the allow rule alone does not (observed above). *Recommended: adopt.*
6. **Usage labelling**: `inputTokens` is the tool's `input_tokens` (it excludes cache reads and writes), cache reads are `cachedInputTokens`, `totalTokens` is `null`, the cache-write count is named in the `source` text because the report has no field for it, and a block of all zeros (what a failed login prints) is not recorded. *Recommended: adopt.*
7. **"Passes the conformance suite" reads as "no check failed, and these were skipped"**: `failure:transient` (no way to cause a rate limit), `model:not_reported` and `usage:not_reported` (the tool states both on every run). I left their provokers out rather than fake them, so the matrix cell says `untested` with the three named. *Recommended: accept this reading; revisit if the tool ever offers a way to provoke them.*
8. **Observation, not changed: a `claude` that is not on PATH makes `startAttempt` throw, which the runtime records as an `unknown` attempt (`needs_recovery`).** That is the contract today and `ahp doctor` warns beforehand. A "definitely no process started" error class would be a small runtime change. *Recommended: leave it; raise it if it bites.*
9. **ADR 0001 still says ACP `session/cancel` is the only graceful cancel on Windows**; the spike (decision 4) showed Claude Code's `interrupt` is another, not adopted. I did not edit the ADR. *Recommended: add one sentence to the ADR in the docs ticket (24).*

**Confirmed by the maintainer on 2026-10-27 ("do recommendation"): decisions 1 to 9 above stand as recommended; reopen one only with a new decision.** Decision 9 means the ADR 0001 sentence is added in ticket 24, not now. Still open for this ticket: the Linux (WSL2) conformance run, which only the maintainer can start (it needs their login).

2026-10-28: both cells `passed` (ticket 24 added `unprovokable`, so the three checks no tool can be made to do no longer keep a cell untested). Decision 9 done in ticket 24: one sentence added to ADR 0001.
