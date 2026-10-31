---
name: new-terminal-ui
description: Implements a ticket of the new terminal app (`.scratch/new-terminal-ui/issues/00`–`10`), the full-screen black-and-green Ink app opened by plain `ahp`: design system, activity log, run screen with live coding, first open, decisions, plain commands, switch-over. Use when asked to do, continue or fix one of those tickets, or to work in `src/tui/` or `src/commands/`.
---

# New terminal app: one ticket at a time

The spec is `.scratch/new-terminal-ui/spec.md`. Its mockups, palette and edge-state table are the design, so build what they draw.

## Before ticket 02: the gates

**Order.** This feature is built after `.scratch/inference-evaluation/` (spec "Build order", decided 2026-10-31). Before ticket 02, check that every inference-evaluation ticket except the maintainer's real run (07) is `done` and merged into `main`. If they are not, tell the maintainer which are open and ask whether to wait. Only ticket 01 (lean CLAUDE.md) may go first, and it must keep the inference lines.

**Decisions.** D1–D10 in the spec wait for the maintainer, who adopts them all by saying "go". If the spec's `Status:` line still says the decisions wait, ask the maintainer once, quoting the D-list headings, then record the answer in the spec's `Status:` line. Tickets 00 and 01 need no decision.

## Steps

1. **Pick the ticket.** Use the one named, else the lowest-numbered `Status: todo` whose `Blocked by` tickets are `done`. Each ticket names the model and effort it was planned for (`Implement with:`). If you are a different model, say so in one line and go on. Done when you can name the ticket and every checkbox it holds.
2. **Read its seams** in [`SEAMS.md`](SEAMS.md), then open each file named there before you change it. Done when every file you will change, and every SDK function you will call, has been read in this session.
3. **Model first, screen second.** Put the logic in pure functions over `RunView`, activity entries and settings (`run-model.ts`, `receiptOf`, and the like), with table tests. The Ink component then only renders that data. Done when the pure part is tested green before any component exists.
4. **Screen tests** go through `test/helpers/tui.ts` (from ticket 02): render, type, press keys, then read the last frame as plain text, and assert colour by token only where it carries meaning. Use mock runs on real temporary repositories, never a real tool. Done when every checkbox has an assertion.
5. **Whole check.** Run `npm run typecheck` and `npm test`. When a dependency changed, also run `npm audit --omit=dev` and `npx vitest run test/package.test.ts`. Done when all are green. If a failure is unrelated to your change, quote it to the maintainer rather than skipping it.
6. **Record.**
   - In the ticket: tick its boxes, set `Status: done (<date>)`, and add `## Implementation notes (<date>)` with each choice you made that the ticket left open (numbered, with the reason).
   - Change CLAUDE.md only as ticket 01's lean form allows: one paragraph per module, ending "details: <doc>".
7. **Commit**: one commit per ticket, its message naming the ticket and ending with the attribution trailer. Work on a branch `new-terminal-ui` made from a `main` that includes the inference-evaluation work. Never push.

## Rules the app must keep

The spec's "Rules kept from the design" is the list. These are the ones a screen most often breaks:

- **Numbers only as reported.** Tokens, cost and limits appear only as each tool reported them, labelled with the tool, and never summed across tools or estimated. "not reported" is shown in `muted` where a tool said nothing. "reported done" and "verified" are different words on every screen.
- **The screen is a view over files the runtime owns:** the ledger, the activity log and the worktree. It re-reads them from the last offset, so it can open a run started in another process. State lives in those files, and the UI keeps only the cursor, the focus and what is folded.
- **Decisions go through the SDK** (`approveStep`, `rejectStep`, `recoverAttempt`, `resumeRun`), and the screen re-reads the ledger after each one. A refusal is one `error` line, never a crash.
- **Ctrl+C belongs to the screen.** Ink's default exit is off. A cancel goes through the run's `signal`, so `run_cancel_requested` is recorded first.
- **Colours come from `theme.ts` tokens.** With `NO_COLOR`, `TERM=dumb` or no TTY, nothing is coloured and the symbols ✓ ✗ ↻ ! ○ carry the meaning. Read the footer's keys from the same table the screen's input handler uses.
- **Mock runs say they are mock** on the screen and in the receipt.
- **Main stays green until ticket 09.** New code goes in `src/tui/` and `src/commands/`, beside the old layer, and is started with `node src/tui/dev.ts`. The old `src/cli/` is deleted only in ticket 09.

## Gotchas in this repo

- **No JSX (D2).** Build views with `h(Box, {...}, ...)` from `src/tui/h.ts`. Node's type stripping runs `.ts` from source, so a `.tsx` file or JSX syntax breaks `node src/cli/bin.ts`. Import with `.ts` extensions and use only erasable syntax (no enums, namespaces or parameter properties).
- **Pin dependencies exactly.** Versions on npm on 2026-10-31: `ink` 8.0.0, `react` 19.3.1, `ink-testing-library` 4.0.0. Remove `@inquirer/prompts` only in ticket 09.
- **Windows first.** The maintainer runs Windows Terminal, so expect `fs.watch` to miss changes: keep the 250 ms poll fallback. Restore the alternate screen and cursor on every exit path. Every child process, including `git diff` for the live diff, goes through `src/process` or the existing git helpers, never `child_process` directly.
- **Tests set `AHP_HOME`** to a temp dir. A test that looks at tools sets PATH from `pathWithoutTools()` or installs fakes (`test/helpers/fake-tools.ts`). The real `claude`, `codex` and `opencode` never run in a test.
- **The mock has no script for an attempt you did not give it.** That attempt is `unknown` and the run stops in `needs_recovery`. A test whose step fails by design sets `retry: { budget: 0 }`.
- **On this machine the Bash tool chokes on big heredocs and `node -e` patches:** use Write and Edit for file content.
- **`docs/troubleshooting.md` quotes messages verbatim.** Ticket 08 owns that file for the plain commands, and ticket 09 owns it for the app.

## Overlap with the inference-evaluation feature

Ticket 03 renames the tool-call log to the **activity log** (`AttemptInput.activityLog`, `activityLogPath`, `<runs>/<run>/activity/<attempt>.jsonl`). The inference-evaluation feature's ticket 04 counts tool calls from that log, so whichever lands second reads the `tool_call` entries of whatever log exists then, and keeps the old `tool-calls/` path readable. Both features touch CLAUDE.md, and `src/setup/wizard.ts`'s condition list is deleted in ticket 09. Check `git log` for the other feature's commits before editing a shared file.
