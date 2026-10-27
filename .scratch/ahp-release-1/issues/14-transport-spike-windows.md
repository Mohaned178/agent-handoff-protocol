# 14: Transport spike on native Windows

**What to build:** A dated written report, per tool, comparing its vendor-maintained transport options on native Windows (ADR 0001), so that each adapter's transport is chosen on evidence. Run under the maintainer's own logins; Gemini CLI only if paid access is available, otherwise recorded as not run.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · high

- [x] For each tool and candidate transport: cancellation behaviour, permission requests, model listing/reporting, usage reporting, output stability, exit/stop semantics (Gemini CLI recorded as not run: no paid access)
- [x] Claude Code: headless `claude -p` stream-json, including how hooks and deny rules behave on Windows
- [x] Codex: Codex SDK vs `codex exec --json`, with a recommendation; app-server not evaluated
- [x] OpenCode and Gemini CLI: native ACP vs headless (OpenCode run on a free-tier model; Gemini CLI help output only)
- [x] Records tool versions, date, and whether each tool's sandbox/enforcement differs on native Windows
- [x] Records approximate usage per attempt where reported, as input to the pilot budget
- [x] Every unconfirmed point marked as such; no mock results

## Implementer notes

- Run each tool by hand-written throwaway scripts in a scratch folder, not inside AHP's source; the report is the deliverable.
- Use a tiny disposable git repo per experiment; never point a tool at a real project.
- If a tool asks for login, payment, or a terms acceptance, stop and ask the user; never log in or accept on their behalf.
- Keep calls few (a handful per tool) so usage stays within normal individual use.

## Comments

2026-10-27, implementation notes. The report is `docs/spikes/2026-10-27-transport-spike-windows.md` (no `src/` change, so no test seam; raw captures stayed in a scratch folder).

**Questions asked during the work, answered by the maintainer:** Codex was logged out, so the maintainer logged in themselves (`codex login`); Gemini CLI: no paid access, so it is recorded as not run; OpenCode's default model failed with HTTP 402, so the maintainer chose the free-tier `opencode/deepseek-v4.1-flash-free` for every OpenCode run.

**Two things the spike did that the ticket did not expect.** (1) The first OpenCode run wrote two files into AHP's own checkout, because `opencode run` takes its working directory from the inherited `PWD` variable, not the process cwd. They were untracked and are deleted; the tree was clean. This is finding F1 in the report. (2) A Codex run with `-s danger-full-access` was declined by this session's permission guard and was not made, so Codex's cancel under a running shell child is unconfirmed.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Report location `docs/spikes/2026-10-27-transport-spike-windows.md`.** *Recommended: keep.*
2. **Codex adapter (ticket 16) uses `codex exec --json` through the process layer, not the Codex SDK**, which wraps the same command, hides the PID and kills only the direct child. *Recommended: adopt.*
3. **OpenCode adapter (ticket 18) uses native ACP first, headless `run --format json` as fallback.** ACP is the only transport with real permission requests and a graceful turn cancel, and needs a duplex-stdin variant of `launch`. *Recommended: adopt.*
4. **Claude Code adapter (ticket 15) stays headless one-shot with forced cancel on Windows.** The stream-json `interrupt` (a graceful turn cancel, the process stays up) is recorded in the report, not adopted; ADR 0001's sentence that ACP is the only graceful cancel on Windows is now incomplete, and I did not edit the ADR. *Recommended: keep.*
5. **The process layer sets `PWD` to the attempt's `cwd` for every agent (the OpenCode finding), in ticket 15; the duplex-stdin variant comes in ticket 18.** *Recommended: adopt.*
6. **Codex's reported model is read from the thread's session file (`turn_context.model`), labelled with that source, `unknown` if absent.** The stream does not carry it. *Recommended: adopt; ticket 16 confirms.*
7. **Tickets 15, 16 and 18 declare `cooperative` at most for the three capabilities on Windows, and `none` for the network stance, until their conformance probes say otherwise.** Claude Code's deny rules and hooks were walked around through `Bash`, its Windows sandbox is off, and Codex's sandbox did not block a local request. *Recommended: adopt.*
8. **Gemini CLI stays "not run" until paid access exists; ticket 19 runs the six checks then.** *Recommended: keep.*

**Confirmed by the maintainer on 2026-10-27 ("do recommendation"): decisions 1 to 8 above stand as recommended; reopen one only with a new decision.**
