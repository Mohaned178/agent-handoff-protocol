<div align="center">

# AHP: Agent Handoff Protocol

*Hand a coding task to AI agents in one sentence. Your tests decide when the work is done, and you approve what lands.*

[![Build Status](https://img.shields.io/github/actions/workflow/status/Mohaned178/agent-handoff-protocol/ci.yml?style=flat-square&label=CI)](https://github.com/Mohaned178/agent-handoff-protocol/actions/workflows/ci.yml)
[![Node version](https://img.shields.io/badge/node-%3E%3D24-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)

[When to use it](#when-to-use-ahp) • [Getting started](#getting-started) • [What a run looks like](#what-a-run-looks-like) • [Workflows](#keeping-a-workflow) • [Commands](#commands) • [Learn more](#learn-more)

</div>

AHP drives the coding agent CLIs you already use (Claude Code, Codex CLI and OpenCode). You give it a task; it works out from your project how to check the work and which of your tools does each step, shows you, and runs **implement → review → your approval** once you say so. A step passes only when its check passes: your test command, run in a fresh copy of the result. An agent saying "done" never counts.

```sh
npm install -g github:Mohaned178/agent-handoff-protocol   # Node 24+ and git
ahp doctor                                                 # which of your agent tools AHP can use
ahp "fix the bug where the cart total ignores quantity"    # in your project's folder
```

`ahp demo` tries it first in a sample project, with scripted agents: free, and nothing to set up. Something wrong? See [troubleshooting](docs/troubleshooting.md).

```
$ ahp "fix the bug where the cart total ignores quantity"

  task       fix the bug where the cart total ignores quantity
  check      npm test                   package.json
  install    npm ci                     package-lock.json
  implement  Codex CLI                  default model
  review     Claude Code                opus · your default
  result     branch ahp/fix-the-bug-where-the, local only
? Run it?  ❯ Run   Change something   Cancel
```

Each step gets one line while it runs, and the run ends with what the checks caught. The run below is **illustrative**: no output from a real run is published here yet.

```
  ↻ implement   check failed: ✖ total() multiplies each price by its quantity · trying again
  ✓ implement   Codex CLI · 2m 10s
      changed src/cart.mjs (+11 -3)
  ↩ review      asked for changes: total() still ignores quantity for discounted items
  ✓ implement   Codex CLI · 1m 32s
      changed src/cart.mjs (+14 -3)
  ✓ review      Claude Code (opus) · 48s · approved
? waiting for your approval: changed src/cart.mjs (+14 -3)
  ...
✓ run succeeded in 6m 2s
  ✓ implement: `npm test` passed · after one failed attempt · sent back once, approved after
  usage: ... (as each tool reported it)
  next: git merge ahp/fix-the-bug-where-the
```

`ahp inspect` shows the full record: every attempt, its check's output, the review's findings and each tool's reported usage with its source.

> [!NOTE]
> AHP is in early development. Workflows run end to end with Claude Code, Codex CLI and OpenCode on Windows, and with Claude Code on Linux too. macOS is untested. See the [support matrix](docs/support-matrix.md).

## When to use AHP

AHP is worth its checks when an agent's "done" cannot be taken on trust and a mistake costs something:

- **A test defines done.** The check runs in a clean copy of the agent's work, and a failure goes back to the agent with its output.
- **The task is long, or runs while nobody watches.** Each step is checked before the next starts, and nothing lands before you approve the diff.
- **More than one tool.** Implement with one agent and review with another; a review that asks for changes sends the work back.
- **You need a record** of what was asked, done, checked and approved: every run keeps a hash-chained ledger, and `ahp inspect` reads it.

## When not to

Quick edits, docs, a README: anything with nothing to test and little to lose. **Use your agent directly**: it is faster, and AHP's checks would be all cost.

AHP does not claim better results than a single agent. It checks every step; whether that improves outcomes is what its [evaluation](#evaluation) measures, and there is no result yet.

## Features

- **Verified, not claimed.** A step passes only when its check passes in a fresh worktree built from what the agent committed. A failed attempt goes back to the agent with the evidence, up to a retry budget.
- **One sentence to start.** `ahp "<task>"` works out the check command, the install command and who does each step from your project and your tools, and asks only for what it cannot work out.
- **Review that can say no.** When the reviewer asks for changes, the implement step goes back with its findings.
- **You approve what lands.** The run stops at a gate, shows you the diff, and lets you approve or reject it in place. Only AHP makes the branch or pushes, never an agent.
- **Mix tools and models.** Implement with Codex and review with Claude Code, or any other combination, and keep a choice as your default.
- **Structured handoffs.** Each step receives the work of the one before it as validated fields, not as a wall of chat. Files are handed on by content hash.
- **Crash-safe.** Every event goes to an append-only, hash-chained ledger. `ahp recover` picks a stopped run up where it left off, and Ctrl+C stops the agent and every process it started.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 24 or newer
- [git](https://git-scm.com)
- At least one coding agent CLI, installed and logged in with its own login:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  - [Codex CLI](https://github.com/openai/codex)
  - [OpenCode](https://opencode.ai)

> [!IMPORTANT]
> AHP never asks for or stores API keys. Each tool runs under your own login and plan, so its usage counts against them and its vendor's terms apply.

### Installation

```sh
npm install -g github:Mohaned178/agent-handoff-protocol
```

The package builds when it installs, which takes about 30 seconds. If npm warns that it has install scripts, that warning is about this build step.

### Try it first

```sh
ahp demo
```

This needs no project and no setup. AHP makes a small sample project and runs plan → implement → review in it, with a review that sends the work back once, then asks you to approve the diff and pushes it to a local stand-in remote. The agents are scripted, so the demo is free and instant; `ahp demo --real` uses your own tools instead.

### Your first task

In your project's folder:

```sh
ahp "fix the bug where the cart total ignores quantity"
```

AHP shows what it worked out, each answer with where it came from, and asks **Run**, **Change something** or **Cancel**. Nothing starts before you choose Run.

- **The check** comes from your project: `npm test` from a `package.json` test script, `pytest`, `cargo test`, `go test ./...` or `make test`. When there is none, AHP asks for a command, or offers "none: review only", which the summary and the receipt label not verified. `--check "<command>"` names one yourself.
- **Who does each step** comes from the tools `ahp doctor` finds. **Change something** picks a step's tool, model and effort, and can keep the choice as your default (`ahp settings` shows your defaults; `ahp settings --clear` removes them). Flags do the same for one run: `--implement codex --implement-model gpt-5.6-terra`, `--review claude-code --review-effort high`.
- **The steps** are implement → review; `--plan` adds a read-only plan step first.
- **The result** goes on a local branch `ahp/<task>` once you approve. Nothing leaves your machine unless you pass `--push` (to `origin`) or `--push <remote>`.
- **Agents work from your last commit**: the summary names any uncommitted files they will not see. A folder that is not a git repository yet, or has no commit, is offered one first.

Without a terminal (a script, CI), `--yes` runs it without asking; the run then stops at the approval gate for `ahp approve`.

> [!TIP]
> `ahp doctor` shows which agent tools AHP found and whether they are logged in; `ahp --help` lists the commands to start with, and `ahp --help --all` every command and option. When something fails, [troubleshooting](docs/troubleshooting.md) has the fix for each message.

### What it costs

AHP is free (Apache-2.0). Each step is a run of one of your agent tools under your own login, so it counts against your plan with that tool, and how much depends on the task and the model. AHP bounds how many runs a task can take. With the defaults:

- **implement** gets at most 3 attempts: its first and 2 more, shared between a failed check, an agent error, a review that sends it back and a rejection at your approval. A rate limit or another passing error is retried apart, up to 5 times within 2 minutes.
- **review** runs once for each implement result that passes its check, so at most 3 times, plus up to 2 retries in all if its agent errors.
- **`--plan`** adds one read-only plan step with the same budget.
- Every attempt is stopped after 20 minutes, or after 10 minutes in which its tool prints nothing.

At the end of a run, and in `ahp inspect`, AHP prints the tokens and cost each tool reported, per tool and with where each number came from. Nothing is estimated, and a tool that reports no cost shows none.

## What a run looks like

Each step gets one line. The step at work shows a spinner, its tool, the time so far and what the agent is doing. When a step ends, its result stays on screen with what it changed. A failure says why in one line, and the run's end names the command to run next:

```
  ✓ plan        Claude Code (haiku) · 18s
  ↻ implement   check failed: SyntaxError: The requested module '../src/cart.mjs' does not provide an export… · trying again
  ↻ implement   agent error: the agent stopped with an error · trying again
  ✗ implement   Codex CLI · 1m 13s
      retry budget spent: SyntaxError: The requested module '../src/cart.mjs' does not provide an export named…

✗ run failed
  ✗ implement: `npm test` failed on 2 attempts
  usage: codex ... (as each tool reported it)
  next: ahp inspect run_mvsq81d8c54ae7cc shows every attempt and its evidence
```

At the approval gate you choose one of these:

| Choice | What happens |
|---|---|
| **Approve** | The run goes on, and AHP makes the branch (or pushes it) |
| **Reject** | You type a reason, and the implement step is sent back with it |
| **Show the whole diff** | Prints the full diff, then asks again |
| **Decide later** | The run waits; `ahp approve` or `ahp reject` decides it later |

The run then ends with its receipt (above), which `ahp inspect` also shows at its top. The branch's history tells the story of the run:

```
bf4898f review: approved
6a60959 implement: Updated src/cart.mjs: total() now multiplies each price by quan…
6573cff plan: Read the repo (package.json, src/cart.mjs, test/cart.test.mjs)…
```

Two flags change the output. `--diff` prints each attempt's whole diff, and `--verbose` prints every event as a line. You also get the line-per-event output when the output goes to a file, a pipe or CI.

## Keeping a workflow

A task run with `ahp "<task>"` is built in memory and recorded in the run's ledger; no file is written. To keep a workflow you run again, or run in CI, write it as a file: `ahp "<task>" --save fix-cart.workflow.mjs` saves the one it would run, and `ahp setup` asks about every part of one, in menus. `ahp run <file>` runs it.

A workflow is a plain JavaScript file that you can read and edit:

```js
export default {
  name: "fix-cart",
  steps: [
    {
      id: "plan",
      agent: { adapter: "claude-code", model: "haiku" },
      instructions: "Plan this task: ... Write no code; report a summary and the decisions you made.",
      verification: { requiredOutputFields: ["summary", "decisions"] },
      capabilities: [{ kind: "read_only" }],
    },
    {
      id: "implement",
      agent: { adapter: "codex" },
      instructions: "Fix total() ... The work is done when `npm test` passes. Change only src.",
      verification: { command: "npm test", requiredOutputFields: ["summary"] },
      capabilities: [{ kind: "write_scope", paths: ["src"] }],
    },
    {
      id: "review",
      agent: { adapter: "opencode", model: "opencode/glm-5.3-flash-free" },
      review: { sendBackTo: "implement" },
      verification: {},
    },
    { id: "approve", approval: {} },
    { id: "publish", action: { kind: "push_branch", branch: "ahp/fix-cart" } },
  ],
};
```

| Field | Purpose |
|---|---|
| `agent` | The tool that runs the step (`claude-code`, `codex`, `opencode`), with an optional `model` and `options.effort` |
| `verification.command` | Must exit 0 in a fresh worktree for the step to pass |
| `verification.requiredOutputFields` | Fields the agent must report (`summary`, `decisions`, ...), handed on to the next step |
| `retry` | `{ budget }`: how many more attempts a failed step gets (default 2) |
| `timeout` | `{ totalMs, idleMs }`: stops an attempt that runs too long or goes silent (defaults 20 minutes and 10 minutes) |
| `capabilities` | `read_only` or `write_scope`, enforced as far as each tool allows |
| `review` | `{ sendBackTo }`: a request for changes sends that step back |
| `approval` | Stops the run for a person's decision |
| `action` | `push_branch`, `open_pr` or `merge_pr`, performed by AHP after an approval. `remote` defaults to `origin`; `remote: "."` puts a pushed branch in this repository instead |

## Commands

| Command | Description |
|---|---|
| `ahp "<task>"` | Works out a run for the task from your project and tools, shows it, and runs it once you say so |
| `ahp` | In a terminal, the same as `ahp setup` |
| `ahp demo` | Tries AHP in a sample project it makes: scripted agents, free (`--real` uses your tools) |
| `ahp doctor` | Shows which tools are installed and logged in |
| `ahp setup` | Writes a workflow or an evaluation suite, using menus, and offers to start it |
| `ahp run <file>` | Runs a workflow file |
| `ahp approve <run> <step>` | Approves a waiting gate, from another terminal or later |
| `ahp reject <run> <step> --reason "..."` | Rejects it and sends the step before the gate back |
| `ahp runs` | Lists the repository's runs, newest first, with the command to run next for any that waits |
| `ahp inspect [run]` | Shows a run's receipt, then everything about it: attempts, handoffs, verification, usage and the diff (default: the newest run) |
| `ahp recover <run>` | Continues a run whose process stopped |
| `ahp settings` | Shows the tool, model and effort you kept for each step (`--clear` removes them) |
| `ahp eval <suite>` | Runs an evaluation suite |

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Succeeded |
| `1` | Failed |
| `2` | Usage error |
| `3` | Needs a recovery decision |
| `4` | Waiting for approval |
| `130` | Cancelled |

## Supported tools

| Tool | Adapter | Tested on |
|---|---|---|
| Claude Code | `claude-code` | Windows, Linux (WSL2) |
| Codex CLI | `codex` | Windows |
| OpenCode | `opencode` (over ACP) | Windows |

AHP reports a model and token usage only when the tool itself reports them. At the end of a run it prints each tool's reported tokens and cost, per tool and with where the numbers came from; nothing is estimated, and tools are never added together. The [support matrix](docs/support-matrix.md) has the details.

## Safety

> [!WARNING]
> A git worktree keeps agents out of your checkout, but it is **not a security boundary**. Agents can run commands on your machine, and verification runs the code they wrote. Limits such as `read_only` are mostly cooperative: the agent is told and the tool is asked. Read [docs/limits.md](docs/limits.md) before you point AHP at anything important.

## Evaluation

AHP also measures whether its checks and handoffs help, and reports the answer whatever it is. `ahp eval` freezes a suite of tasks and runs each one under these conditions:

- a single agent, alone (C0) and with the same check-and-retry loop AHP gives (C0V)
- a plain-text pipeline (C1), and one with structured fields but no checks (C2)
- implement → review with the check, retry and send-back (C3min), and the full workflow with a plan step (C3)
- a baseline: one agent given as many attempts as the full workflow used

Trials are repeated in a seeded random order, and each one is scored by independent validators with hidden tests that no agent sees. **No result yet**: the [pilot suite](docs/pilot.md) is written but has not been run, so nothing here claims that handoffs beat a single agent. A negative result is a legitimate outcome. See [docs/evaluation.md](docs/evaluation.md).

## Development

```sh
git clone https://github.com/Mohaned178/agent-handoff-protocol
cd agent-handoff-protocol
npm install
npm test                    # Vitest; uses real git repositories, a mock adapter and fake tools; never runs a real agent
npm run typecheck
npm run build && npm link   # puts `ahp` from your checkout on your PATH
```

The code is TypeScript on Node 24. You can run it from source without building: `node src/cli/bin.ts <command>`. CI runs on Windows, macOS and Linux.

## Learn more

- [How AHP works](docs/how-it-works.md): handoffs, verification, the ledger, crash recovery and cancelling
- [Troubleshooting](docs/troubleshooting.md): each failure message, its cause and the command that fixes it
- Adapters: [Claude Code](docs/adapters/claude-code.md), [Codex](docs/adapters/codex.md), [OpenCode](docs/adapters/opencode.md)
- [Support matrix](docs/support-matrix.md) and [limits](docs/limits.md)
- [Design direction](docs/design/ahp-v2-direction.md), [architecture decisions](docs/adr/) and [glossary](GLOSSARY.md)
- [A2A mapping](docs/a2a-mapping.md): how AHP's data shapes map to the Agent2Agent protocol
