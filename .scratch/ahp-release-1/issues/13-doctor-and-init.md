# 13: `ahp doctor` and `ahp init`

**What to build:** A developer runs `ahp doctor` to learn what they can use on this machine, and `ahp init` to get a working example workflow: the password-reset reference scenario.

**Blocked by:** 10, 11

**Status:** done

**Model:** Sonnet 5.5 · medium

- [x] `doctor` reports OS, Node and git versions against requirements
- [x] `doctor` reports each of the four tools: installed, version, logged in (as far as the tool reveals), and capabilities with enforcement level on this OS
- [x] `doctor` flags tools that need paid access (Gemini CLI)
- [x] `doctor` never reads or prints credentials
- [x] `init` writes the reference scenario: plan → implement (hidden tests) → review (send-back) → approval gate → push or PR, using only tools `doctor` found, falling back to the mock adapter
- [x] The generated workflow passes static validation and runs end to end with the mock adapter

## Implementer notes

- Detect login only through each tool's own status or version commands; never send a prompt (it would spend the user's usage), and never open, parse or print credential or token files.
- If a tool gives no way to tell, report "login: unknown" rather than guessing.
- Test `init` by running its generated workflow end to end with the mock adapter in the test suite.

## Comments

2026-10-27, implementation notes.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **No real adapter exists yet (tickets 15 to 19), so `doctor` reports capabilities from `adapters`, and a tool with no registered adapter shows "none in this build yet" instead of levels.** Nothing is inferred about a tool from its name. The levels printed are what the adapter *declares* for this OS (`levelOn`), labelled as declared, not observed; each adapter ticket makes its row appear by registering the adapter under the name in `src/doctor/tools.ts` (`claude-code`, `codex`, `opencode`, `gemini-cli`). *Recommended: keep.*
2. **Login comes only from a tool's own status command, and only a documented-or-observed answer is read.** Claude Code: `claude auth status --json`, whose boolean `loggedIn` is read and the rest of the output (which names an account) is dropped unread. Codex CLI: `codex login status`, exit 0 is logged in, exit 1 is logged out, any other exit is unknown. OpenCode and Gemini CLI: unknown ("login: unknown"): OpenCode's only status command, `auth list`, prints stored credentials as free text, and Gemini CLI has no status command. No environment variable, config or token file is looked at. *Recommended: keep.* **Caveat:** neither status command documents its exit codes or JSON in `--help`; I observed Claude's `loggedIn: true` and Codex's exit 1 with "Not logged in" on the maintainer's machine, and Codex's exit 0 for a logged-in user is not observed. Ticket 15 and 16 should recheck them against their own tool versions.
3. **Only version and status commands ever run, from the system temp directory, through `resolveExecutable`/`launch` (no shell, nothing on stdin), each under a 15 s timeout (through the `Clock`) after which the tool's tree is terminated.** A test pins the exact argv set and that stdin is empty. *Recommended: keep.*
4. **The minimum git is 2.20**, the release that added the per-worktree configuration `src/runtime/workspace.ts` sets `core.longpaths` through (`extensions.worktreeConfig`, `git config --worktree`). Nothing in the repo stated a git minimum. Node's minimum is read from `package.json` `engines`. *Recommended: keep, and recheck 2.20 against git's release notes before publishing it.*
5. **Exit code: 0 unless Node or git does not meet its requirement (then 1); a missing, logged-out or unknown tool never fails `doctor`.** Using one, two, three or four tools is supported (spec story 5). `--json` prints the report. *Recommended: keep.*
6. **`init` casts the reference scenario (plan: Claude Code, implement: Codex, review: OpenCode) from the tools `doctor` found *usable*: installed, with an adapter in this build, and not known to be logged out; a role whose preferred tool is not usable goes to the first usable tool (Gemini CLI last), else to the mock.** Today no adapter is registered, so `init` always writes mock steps, and its output and the file's header say so. A cast naming an unregistered adapter is refused by static validation rather than written. *Recommended: keep.*
7. **`init` writes `ahp.workflow.mjs` (or the file given), as a plain `export default {…}` with no imports, and never replaces an existing file (exclusive create, exit 1).** The workflow is built as an object, validated with `validateWorkflow`, then serialised. *Recommended: keep.*
8. **The example's last step is a `push_branch` of `ahp/password-reset`, not a pull request.** A pull request needs `gh`, which is not among the four tools `doctor` looks at. It runs with a remote named `origin`. *Recommended: keep.*
9. **The scenario is the core logic of a password-reset endpoint (`src/password-reset.mjs`: `requestReset`, `resetPassword`), verified by a hidden test (`node test/password-reset.hidden.mjs`) the agent never sees; the implement step's `instructions` carry the interface the hidden test imports, so a real agent can pass it.** The mock plays implement twice and review twice (changes requested, then approved), so the run shows a send-back and stops at the gate with exit 4. The plan and review steps ask for `read_only`, the implement step for `write_scope` on `src` and `test`; the mock holds them only at `cooperative`. *Recommended: keep.*
10. **`doctor` lives in `src/doctor/` (tool table, probe, report, init) and is exported from `src/index.ts`, not `src/sdk/`; the CLI only formats (`src/cli/format-doctor.ts`).** *Recommended: keep.*

**Not done:**

- No real tool's capabilities are shown yet (decision 1); the adapter tickets add them.
- `doctor` cannot tell whether a Gemini CLI user has paid access; it only says the tool needs it.
- Real tools are not cast by `init` until their adapters exist, so the real-tool branch of `init` is covered by a table test of `assignRoles` only.
- `test/cli-ledger.test.ts` "refuses to show the state of a corrupt ledger" failed once in a full-suite run on this machine and passed alone and on a stash of this work; not touched by this ticket.

**Confirmed by the maintainer on 2026-10-27 ("do recommendation"): decisions 1 to 10 above stand as recommended; reopen one only with a new decision.**

First green CI run: GitHub Actions run 40549411175 (commit 00a9c2f), passing on Linux, macOS and Windows.
