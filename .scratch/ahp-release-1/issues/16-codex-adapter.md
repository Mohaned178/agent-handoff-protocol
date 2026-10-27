# 16: Codex adapter

**What to build:** A developer can assign steps to Codex CLI through the transport the spike chose (Codex SDK or `codex exec --json`), passing the conformance suite.

**Blocked by:** 12, 14

**Status:** implemented and committed; waiting on the maintainer for the Linux (WSL2) conformance run and for the decisions below

**Model:** Sonnet 5.5 · high

- [x] Uses the spike's chosen transport (`codex exec --json`); never `codex app-server`
- [x] Sandbox and approval settings mapped to capabilities, with enforcement levels measured per OS, not copied across (`read_only` is `enforced_by_tool` on Windows only; Linux and macOS are not measured and declared `cooperative`)
- [x] Requested vs reported model (from the session log) and usage recorded where emitted
- [ ] Passes the conformance suite on Windows native and Linux (WSL2); results recorded as matrix cells
  - [x] Windows native: recorded, `conformance/results/codex--windows.json`. 11 checks passed, none failed, 2 not applicable, 4 skipped (the tool cannot be made to do them), so the outcome is `untested`, not `passed` (decision 7)
  - [ ] Linux (WSL2): not run; needs a Linux `codex` and a login that only the maintainer can make (commands in the comments)

## Implementer notes

- Transport: `codex exec --json` through the process layer (spike decision 2, confirmed 2026-10-27); never the SDK, never `app-server`. Spike decisions 6 (reported model from the session log) and 7 (`cooperative` at most until a probe says otherwise) were followed; decision 7 is exercised below, not reopened.
- Real `codex` never runs in a test. The adapter's tests use a fake `codex` that prints streams captured from the real 0.146.0 (`test/fixtures/codex/`, scrubbed of paths, thread and request ids).
- The prompt builder and the output-schema builder moved from `claude-code/` to `src/adapters/` (`prompt.ts`, `output-schema.ts`), unchanged, because Codex uses both.

## Comments

2026-10-28, implementation notes. User doc: `docs/adapters/codex.md`; code `src/adapters/codex/`; tests `test/codex.test.ts`.

**Observed on the real tool (Windows, Codex 0.146.0, the maintainer's own ChatGPT login; `OPENAI_API_KEY` removed from the environment of every run).**
- Without a Windows sandbox setting, every non-read command is declined, in the workspace too (reproducing the spike). With `-c windows.sandbox="unelevated"`, commands run in a sandbox: `read-only` left a requested workspace file and an outside file unwritten; `workspace-write` wrote the workspace file and not an outside one; a request to a local listener got through under both (listener log). The one apparent contradiction (an outside file written under `workspace-write`) was a repository under `%TEMP%`: the same probe with the repository in `%TEMP%` writes a sibling directory there, outside `%TEMP%` it does not. So `workspace-write` is "workspace and `%TEMP%`".
- The model: the stream has none. `$CODEX_HOME/sessions/.../rollout-*-<thread id>.jsonl` has `turn_context.model`, **and it is written even when no model answered**: a missing login and a model the login cannot use both left a `turn_context` naming the model that was asked for. The adapter therefore reports it only for an attempt in which the model said or ran something. With no `--model`, it names Codex's own pick (observed `gpt-5.6-terra`); with one, it is the same name (a record, not independent evidence).
- Usage: `turn.completed.usage`. The session log's own `total_tokens` is input plus output, so `input_tokens` includes the cached tokens, which is the opposite of Claude Code's. No total, no cost.
- Failures: a missing login is nine "Reconnecting..." `error` events across two transports, then `turn.failed` with `unexpected status 401 Unauthorized` and exit 1; a model the login cannot use is a 400 `model_not_found`; a refused effort (`minimal` on `gpt-5.6-luna`) is a 400 `unsupported_value`, exit 1, which is how the suite provokes an `agent_error`. A `CODEX_HOME` that does not exist makes Codex exit 1 with a plain-text message outside the stream, so the subject's provoker creates the empty directory.
- `--output-schema` accepts the `anyOf` string-or-list shape; the last `agent_message` is then the JSON object.
- Cancel under a running shell child, unconfirmed in the spike, passed the suite's forced-tree check on Windows (a tree of three processes that ignored every signal; none left).

**Windows conformance cell recorded: `conformance/results/codex--windows.json`.** 11 checks passed, none failed, 2 not applicable, 4 skipped (`failure:transient`, `model:reported`, `model:not_reported`, `usage:not_reported`), so the outcome is `untested`, not `passed`. `capability:read_only` is a real `enforced_by_tool` pass: the control run (level recorded `none`) wrote the file, the probe (level `enforced_by_tool`) did not.

**Linux (WSL2) cell: not done.** The Ubuntu distro has no Linux Node, no Linux `codex` and no login, and only the maintainer can log in. I did not install or log in anything there. To record the cell, in the WSL2 shell:

```
# one time: Node >= 24 and a Linux codex (check `which codex` is not under /mnt/c), then log in yourself
npm install -g @openai/codex && codex login
git clone https://github.com/Mohaned178/agent-handoff-protocol ~/ahp && cd ~/ahp && git checkout main && npm ci   # in the Linux filesystem, not /mnt/c
env -u OPENAI_API_KEY -u CODEX_API_KEY npm run conformance -- run codex
```

Then commit `conformance/results/codex--linux-wsl2.json`. Expect `read_only` to be checked only as accepted (`cooperative` there); if you want it measured on Linux, declare it `enforced_by_tool` for `linux`, run again, and keep the declaration only if the probe passes. About a dozen short attempts on the maintainer's login.

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Declaration: `read_only` is `enforced_by_tool` on Windows only; `cooperative` on Linux and macOS (not measured); `write_scope` and `no_external_actions` `cooperative` everywhere; both network stances `none` everywhere.** *Recommended: adopt.* This is the first `enforced_by_tool` claim in the project, resting on one agent, one Codex version and one Windows; the suite's probe and control both held. Spike decision 7 allowed it once a probe said so. If the Linux run finds `read-only` holds there too, raise Linux in its own commit.
2. **The sandbox is chosen from the recorded level, not the request** (`none` runs `workspace-write`, anything else `read-only`), and the adapter never passes `danger-full-access` or a bypass flag (asserted in a test). *Recommended: adopt.* It is what lets the suite's control run work.
3. **`--ignore-user-config --ignore-rules` on every attempt**, as `--setting-sources project` is for Claude Code (ticket 15 decision 2). *Recommended: adopt.* Cost: a login that needs a setting in `config.toml` fails as `config_auth`; `codexHome` and the environment still work.
4. **`--config windows.sandbox="unelevated"` on Windows.** Without it nothing but reads runs. *Recommended: adopt.* `elevated` needs an administrator prompt, so AHP does not trigger it; it is a possible option later.
5. **Reported model is read from Codex's session log (spike decision 6), only for an attempt in which the model answered, and the log is kept (no `--ephemeral`).** *Recommended: adopt.* Consequence: the suite's `model:reported` is skipped as an echo whenever a model is requested, so the cell is `untested` for that reason too. A step with no `model` gets the real default reported.
6. **Adapter options `reportFields`, `extraInstructions`, `effort`, `codexHome`.** `effort` is also how the suite provokes an `agent_error`. *Recommended: adopt.* There is deliberately no option for the sandbox, the approval policy or a config override, so a step cannot weaken what its capabilities recorded.
7. **"Passes the conformance suite" reads as "no check failed, and these were skipped"**: `failure:transient`, `model:reported`, `model:not_reported`, `usage:not_reported`. *Recommended: accept this reading,* as for ticket 15.
8. **The conformance subject requests `gpt-5.6-luna`** (the model the spike found a ChatGPT login could use), overridable with `AHP_CONFORMANCE_CODEX_MODEL`. *Recommended: adopt.* Codex has no alias, so a made-up name cannot be used; the name is not recorded in the result.
9. **Shared helpers moved out of `claude-code/`** (`src/adapters/prompt.ts`, `output-schema.ts`). *Recommended: adopt;* behaviour unchanged, Claude Code's tests pass untouched.

**Confirmed by the maintainer on 2026-10-28 ("do recommendation"): decisions 1 to 9 above stand as recommended; reopen one only with a new decision.** Decision 1 includes the `enforced_by_tool` claim for `read_only` on Windows. Still open for this ticket: the Linux (WSL2) conformance run, which only the maintainer can start (it needs their login).
