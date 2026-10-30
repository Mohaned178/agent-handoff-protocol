<div align="center">

# AHP: Agent Handoff Protocol

*Run AI coding agents as a team. Your tests decide when the work is done, and you approve what gets pushed.*

[![Build Status](https://img.shields.io/github/actions/workflow/status/Mohaned178/agent-handoff-protocol/ci.yml?style=flat-square&label=CI)](https://github.com/Mohaned178/agent-handoff-protocol/actions/workflows/ci.yml)
[![Node version](https://img.shields.io/badge/node-%3E%3D24-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)

[Features](#features) • [Getting started](#getting-started) • [What a run looks like](#what-a-run-looks-like) • [Workflows](#writing-a-workflow) • [Commands](#commands) • [Learn more](#learn-more)

</div>

AHP drives the coding agent CLIs you already use (Claude Code, Codex CLI and OpenCode) through a workflow: **plan → implement → review → your approval → push**. Each step gets a structured, validated handoff from the step before it and works in its own git worktree. A step passes only when verification passes: your test command, run in a fresh copy of the result. An agent saying "done" never counts.

```
$ ahp run ahp.workflow.mjs
ahp · fix-cart · F:\ahp-demo\shop
run run_mvsqau7ae78f374b

  ✓ plan        Claude Code (haiku)   20s
  ✓ implement   Claude Code (haiku)   17s
      changed src/cart.mjs (+11 -3)
  ✓ review      Claude Code (haiku)   13s
      verdict: approved
? waiting for your approval
  what you are approving: changed src/cart.mjs (+11 -3)
    -  for (const item of cart.items) sum += item.price;
    +  for (const item of cart.items) sum += item.price * item.quantity;
? Approve this change?
❯ Approve
  Reject
  Show the whole diff
  Decide later
```

> [!NOTE]
> AHP is in early development. Workflows run end to end with Claude Code, Codex CLI and OpenCode on Windows, and with Claude Code on Linux too. macOS is untested. See the [support matrix](docs/support-matrix.md).

## Features

- **Verified, not claimed.** A step passes only when its check passes in a fresh worktree built from what the agent committed. A failed attempt goes back to the agent with the evidence, up to a retry budget.
- **Structured handoffs.** The plan's summary and decisions reach the implementer as validated fields, not as a wall of chat. Files are handed on by content hash.
- **Review that can say no.** When the reviewer asks for changes, the implement step goes back with its findings.
- **You approve what is pushed.** The run stops at a gate, shows you the diff, and lets you approve or reject it in place. Only AHP pushes, never an agent.
- **Mix tools and models.** Plan with Claude Code, implement with Codex and review with OpenCode, or any other combination.
- **Crash-safe.** Every event goes to an append-only, hash-chained ledger. `ahp recover` picks a stopped run up where it left off, and Ctrl+C stops the agent and every process it started.
- **Measurable.** A built-in evaluation engine tests whether structured handoffs actually beat a single agent.

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

### Your first run

In your project's folder, which must be a git repository with a commit and a remote named `origin`:

```sh
ahp doctor                 # which agent tools AHP found, and whether they are logged in
ahp setup                  # menus: what to build, the command that checks it, which agent does each step
ahp run ahp.workflow.mjs   # plan → implement → review, then asks you to approve the diff
```

If you approve, AHP pushes the result to the branch `ahp/<task>`.

> [!TIP]
> Run `ahp` on its own to see these steps, or `ahp --help` to list every command and option.

## What a run looks like

Each step gets one line. The step at work shows a spinner, its tool, the time so far and what the agent is doing. When a step ends, its result stays on screen with what it changed. Failures say why and what happens next:

```
  ✓ plan        Claude Code (haiku)   18s
  ↻ implement   attempt 1 failed: its check failed; trying again
      last attempt att_mvsq8fqw2f8f8d80 failed verification: npm test
      | SyntaxError: The requested module '../src/cart.mjs' does not provide an export named 'applyDiscount'
  ↻ implement   attempt 2 failed: the agent stopped with an error; trying again
  ✗ implement   Codex CLI   1m 13s
      retry budget spent

✗ run failed
  every attempt, handoff and verification: ahp inspect run_mvsq81d8c54ae7cc
```

At the approval gate you choose one of these:

| Choice | What happens |
|---|---|
| **Approve** | The run goes on, and AHP pushes the branch |
| **Reject** | You type a reason, and the implement step is sent back with it |
| **Show the whole diff** | Prints the full diff, then asks again |
| **Decide later** | The run waits; `ahp approve` or `ahp reject` decides it later |

The pushed branch's history tells the story of the run:

```
bf4898f review: approved
6a60959 implement: Updated src/cart.mjs: total() now multiplies each price by quan…
6573cff plan: Read the repo (package.json, src/cart.mjs, test/cart.test.mjs)…
```

Two flags change the output. `--diff` prints each attempt's whole diff, and `--verbose` prints every event as a line. You also get the line-per-event output when the output goes to a file, a pipe or CI.

## Writing a workflow

`ahp setup` writes a plain JavaScript file that you can read and edit:

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
| `timeout` | `{ totalMs, idleMs }`: stops an attempt that runs too long or goes silent (defaults 1 hour and 10 minutes) |
| `capabilities` | `read_only` or `write_scope`, enforced as far as each tool allows |
| `review` | `{ sendBackTo }`: a request for changes sends that step back |
| `approval` | Stops the run for a person's decision |
| `action` | `push_branch`, `open_pr` or `merge_pr`, performed by AHP after an approval |

## Commands

| Command | Description |
|---|---|
| `ahp doctor` | Shows which tools are installed and logged in |
| `ahp setup` | Writes a workflow or an evaluation suite, using menus |
| `ahp run <file>` | Runs a workflow |
| `ahp approve <run> <step>` | Approves a waiting gate, from another terminal or later |
| `ahp reject <run> <step> --reason "..."` | Rejects it and sends the step before the gate back |
| `ahp inspect <run>` | Shows everything about a run: attempts, handoffs, verification, usage and the diff |
| `ahp recover <run>` | Continues a run whose process stopped |
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

AHP reports a model and token usage only when the tool itself reports them. The [support matrix](docs/support-matrix.md) has the details.

## Safety

> [!WARNING]
> A git worktree keeps agents out of your checkout, but it is **not a security boundary**. Agents can run commands on your machine, and verification runs the code they wrote. Limits such as `read_only` are mostly cooperative: the agent is told and the tool is asked. Read [docs/limits.md](docs/limits.md) before you point AHP at anything important.

## Evaluation

AHP also measures whether structured handoffs help. `ahp eval` freezes a suite of tasks and runs each one under four conditions:

- a single agent
- a plain-text pipeline
- a pipeline with structured fields but no checks
- the full AHP workflow

It also runs a baseline that gets the same number of attempts as the full workflow. Trials are repeated in a seeded random order, and each one is scored by independent validators with hidden tests. A negative result is a legitimate outcome. See [docs/evaluation.md](docs/evaluation.md) and the [pilot suite](docs/pilot.md).

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
- Adapters: [Claude Code](docs/adapters/claude-code.md), [Codex](docs/adapters/codex.md), [OpenCode](docs/adapters/opencode.md)
- [Support matrix](docs/support-matrix.md) and [limits](docs/limits.md)
- [Design direction](docs/design/ahp-v2-direction.md), [architecture decisions](docs/adr/) and [glossary](GLOSSARY.md)
- [A2A mapping](docs/a2a-mapping.md): how AHP's data shapes map to the Agent2Agent protocol
