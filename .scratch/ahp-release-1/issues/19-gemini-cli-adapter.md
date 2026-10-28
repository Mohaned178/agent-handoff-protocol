# 19: Gemini CLI adapter (native ACP)

**What to build:** A developer with paid Gemini access (API key or Code Assist licence) can assign steps to Gemini CLI, driven through its native ACP mode, passing the conformance suite. Needs paid access to test; schedule last among adapters.

**Blocked by:** 12, 14

**Status:** implemented and committed; waiting on the maintainer for paid Gemini access, to run the conformance suite on Windows and Linux (WSL2) and record the two cells

**Model:** Sonnet 5.5 · high

- [x] Drives `gemini --acp`; no third-party bridge
- [x] Uses ACP `session/cancel` for graceful cancel; `request_permission` treated as cooperative only (against a fake built from the tool's source; no live turn)
- [x] `doctor` and docs state that Gemini CLI needs paid access (the doctor row existed from ticket 13; a test now covers it beside the registered adapter; `docs/adapters/gemini-cli.md`)
- [x] Tool-call log captured for recovery reports
- [ ] Passes the conformance suite on Windows native and Linux (WSL2); results recorded as matrix cells
  - [ ] Windows native: **not run**, no paid access. The subject is registered (`npm run conformance -- run gemini-cli`) and the matrix keeps saying "not run"
  - [ ] Linux (WSL2): **not run**, same reason

## Implementer notes

- Transport evidence: `docs/spikes/2026-10-27-transport-spike-windows.md` (decision 8: Gemini CLI stays "not run" until paid access exists). This ticket could not run its six checks.
- The real `gemini` never runs in a test, and was never run for a turn at all. What was run live (Windows, 0.42.0, no login, no prompt): `initialize` and `session/new` (which fails with -32000 "Gemini API key is missing or not configured."), and the same with `--policy` files (a good one, an empty one, and one with an unknown `decision`; only the last printed `Policy file error`). Also observed with `--approval-mode default`: the untrusted-folder lines on stderr ("Skipping project agents due to untrusted folder", "Project hooks disabled because the folder is not trusted") and exit code 0 once stdin ended. Everything else the adapter assumes about the conversation was read from the installed bundle's source (`packages/cli/src/acp`). `test/fixtures/gemini-cli/captures.json` marks which messages are live and which are not, and `docs/adapters/gemini-cli.md` tags every claim observed / source / unconfirmed.

## Comments

2026-10-28, implementation notes. User doc: `docs/adapters/gemini-cli.md`; code `src/adapters/gemini-cli/` (`index.ts`, `turn.ts`, `policy.ts`, `conformance.ts`) and the shared ACP code in `src/adapters/acp/`; tests `test/gemini-cli.test.ts` (31) with `test/helpers/gemini.ts`.

**What was added.**
- The adapter, registered as `gemini-cli` (the name the `TOOLS` row of ticket 13 already used), `geminiCli({ model, ... })` for a step, exported from the SDK.
- `src/adapters/acp/`: the second ACP adapter made the OpenCode code shared rather than copied. `connection.ts` (the JSON-RPC client, moved unchanged from `opencode/acp.ts`), `permissions.ts` (the policy, `decide`, `isExternalAction` and the permission answer, moved from `opencode/policy.ts`; OpenCode keeps its own inline config there), `tool-calls.ts` (a call as the agent described it, the tool-call log, `redacted`). `src/adapters/prompt.ts` gained `REPORT_AS_JSON_MESSAGE` and `jsonObjectIn` for a tool with no structured output. OpenCode's behaviour is unchanged (its tests, with the ACP and log tests, pass); `redacted` now also removes Google `AIza` keys, for both.
- A conformance subject, `geminiCliSubject` (registered in `scripts/conformance.ts`), with the same plan as OpenCode's. It has never been run.
- Tests that flipped when the adapter was registered: `test/init.test.ts` used `gemini-cli` as its example of an adapter the build does not have (it now builds the casting by hand with a made-up name), and `test/doctor.test.ts` gained a test for the Gemini row with the registered adapter.

**Where OpenCode's logic would have passed a copied fake and failed the real tool (all from source, so unconfirmed).**
- Message chunks carry no message id, and the tool injects `[MODE_UPDATE] ...` as a chunk. The report is the text after the last tool call; mode-change chunks are dropped. Mutation-checked: breaking either fails a test.
- A shell permission request has no `rawInput`; its `title` is the command (`getDisplayTitle()` returns `params.command`). The command guard reads the title for an `execute` call. A policy file with `commandPrefix` rules is the stronger guard: it sees the parsed command.
- `session/set_model` calls `config.setModel` and returns `{}`: there is no refusal to hook the "never run the default in its place" pattern on, so the model goes in as `--model`.

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Declaration: every capability `cooperative` on every OS, both network stances `none`, `transport: acp`, `gracefulCancel: true`, `modelReporting: enumerable`, `login: api_key`.** *Recommended: adopt.* Spike decision 7 allows no more, and nothing was measured. `api_key` because a key in the tool's own environment or settings is what `session/new` defaults to; a saved Google login is also the tool's own.
2. **The shared ACP code moves to `src/adapters/acp/`** (above), touching the OpenCode adapter's imports and two tests' imports. *Recommended: adopt.* The alternative was a second copy of the client, the permission policy and the log. Not done, as before: the declaration guard and `validateOptions` have one more copy (Claude Code, Codex, OpenCode, Gemini CLI, and the mock's own); a shared helper is a follow-up touching all of them. The code review (below) also found `exitOf`, the cancel's `graceful` block, the `converse` skeleton and the `ParsedExit`/`exit()`/`output()` shape of the two ACP turns repeated between OpenCode and Gemini CLI, and `test/helpers/gemini.ts` close to `test/helpers/opencode.ts`; moving them into `src/adapters/acp/` is a follow-up that touches the OpenCode adapter again.
3. **AHP never calls `authenticate`.** *Recommended: adopt.* The tool writes the method it is given into the user's own settings (source). With no login the attempt fails `config_auth` and sends no prompt (observed). Consequence: a user whose login is not the tool's saved selected type has to run `gemini` once themselves.
4. **`--approval-mode default`, a refusal to prompt unless `session/new` says the mode is `default`, an always-passed `--policy` file (which replaces the user's policy directory), and no `--skip-trust`.** *Recommended: adopt.* Otherwise a user's `auto_edit` or saved "always allow" rule means permission requests never reach AHP. Cost: an attempt does not see the user's own policy directory. Still applied (source): admin policy, and allow rules the tool derives from the user's settings (`tools.allowed`, trusted MCP servers), which mean no permission request reaches AHP for those tools, so the "cooperative" write limits do not cover them.
5. **The model is passed as `--model`, unvalidated; it is reported only when the tool files all its calls under one name.** *Recommended: adopt.* The tool files a later call of a turn under its configured model, so two names mean "which answered" is not known, and the model is then `unknown`. A bad model fails at the prompt (404 is `config_auth`); a silent fallback by the tool, if there is one, would show as a different reported name.
6. **Usage is `_meta.quota.token_count` only (input = `promptTokenCount`, output = `candidatesTokenCount`), total, cached and cost `null`, zeros not recorded.** *Recommended: adopt.* Named in the recorded `source` text.
7. **Errors are classed by the HTTP status the tool puts in the JSON-RPC code; a plain 500 is `agent_error`, 429/408/502-504 `transient`, 401/403/404 `config_auth`, any `session/new` failure `config_auth`.** *Recommended: adopt.* A 500 is the tool's catch-all for errors it cannot name, so retrying it as an outage would repeat a deterministic failure. A 429 can be a daily quota (not told apart).
8. **Output fields are asked for as one JSON object that is the whole final message, as for OpenCode.** *Recommended: adopt.*
9. **The conformance cells are not recorded, and the matrix says "not run".** *Recommended: keep until access exists.* The ticket's last box stays open. Expect `untested` when it is run (`fails`, `login_problem`, `rate_limited`, `no_model_report` and `no_usage_report` are unprovoked, as for OpenCode: no safe way to cause them).
10. **The subject requests `gemini-2.5-flash`** (named as the flash default in the tool's source), overridable with `AHP_CONFORMANCE_GEMINI_MODEL`. *Recommended: adopt.*
11. **The fixtures are two live messages and the rest written from source, and say so.** *Recommended: adopt, and replace them with captures from the first run with access.*

12. **`ahp init` can now cast `gemini-cli`** (when nothing preferred is usable: its login reads `unknown`, which counts as usable), though the adapter has never run a turn. *Recommended: keep;* `ahp doctor` and `ahp init`'s reasons show it needs paid access, and a workflow naming it fails with `config_auth` and no prompt if there is no login. Reopen if a person with no access should not be offered it.

**Code review (two reviewers, after the commit).** Fixed: the docs said the user's policy rules no longer apply and that AHP sends no MCP servers, which over-stated it (see decision 4 and the doc); the two live observations missing from these notes are listed above. Not done, as judgement calls: the duplication above.

**To finish this ticket once there is access** (Windows first; then in the WSL2 distro with Node >= 24 and a Linux `gemini`, from a clone in the Linux filesystem):

```
# unset keys you do not want billed; the tool's own login (GEMINI_API_KEY or a saved Google login) is used
npm run conformance -- run gemini-cli
git add conformance/results/gemini-cli--*.json
```

Then replace the source-derived messages in `test/fixtures/gemini-cli/captures.json` with captures from the run (the transcript files of an attempt hold them), re-read `docs/adapters/gemini-cli.md` and turn each "source" tag into "observed" or correct it, and tick the last box. The cheapest first look, before the whole suite: `npm run conformance -- run gemini-cli --only spawn_and_exit` (never recorded) shows whether the conversation as built works at all.

**Confirmed by the maintainer on 2026-10-28 ("do recommendation"): decisions 1 to 12 above stand as recommended; reopen one only with a new decision.** Still open for this ticket: the Windows and Linux (WSL2) conformance runs, which need paid Gemini access, and the follow-up that moves the duplicated ACP turn and cancel code into `src/adapters/acp/`.
