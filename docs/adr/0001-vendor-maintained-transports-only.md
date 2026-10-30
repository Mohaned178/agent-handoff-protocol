# Adapters use vendor-maintained transports only

Each adapter drives its coding agent through an interface the tool's own vendor maintains: native ACP, the vendor's SDK, or the vendor's app-server protocol where one exists, otherwise the tool's headless mode. The transport spike picks per tool. Third-party ACP bridges (e.g. `codex-acp`, Zed's `claude-agent-acp`) are not release-1 dependencies, because their version drift and unclear use of subscription logins would undermine support-matrix and evaluation claims; they may return later as an optional, pinned, experimental adapter variant labelled as such.

Constraints known before the spike (2026-10-24 research):
- **Claude Code:** the adapter spawns the unmodified `claude` binary headless (`-p`, stream-json), applying capabilities through settings, deny rules and `PreToolUse` hooks written as `node` scripts. It never uses the Claude Agent SDK, because Anthropic does not allow third-party products to use subscription login through it, and it never adds or removes `--bare`; it passes through whatever login the user's `claude` has.
- **Codex CLI:** the spike compares the Codex SDK with `codex exec --json`; `codex app-server` is excluded because OpenAI marks it experimental and not for production.
- **Gemini CLI** and **OpenCode** ship native ACP in their vendors' repos. Gemini CLI now needs a paid Gemini API key or a Code Assist licence. (Gemini CLI was dropped from release 1 on 2026-10-30; the rule stands for the other tools.)
- On Windows, adapters resolve a tool's real executable rather than spawning its `.cmd` shim through a shell, and pass prompts via stdin or file, never as shell arguments. Headless cancel on Windows is a forced process-tree kill, recorded as forced; ACP `session/cancel` is the only graceful cancel AHP uses there. (The 2026-10-27 transport spike, `docs/spikes/2026-10-27-transport-spike-windows.md`, observed one more: Claude Code's `control_request` of subtype `interrupt` under `--input-format stream-json` ends a turn gracefully; it is recorded there and not adopted, so the Claude Code adapter still cancels by a forced tree kill.)
- The spike runs on native Windows first.

One attempt is always one fresh coding-agent process, so `exited` always means observed process termination; an ACP stop reason is recorded as outcome detail, not as proof of exit.
