# AHP: Agent Handoff Protocol

**Run AI coding agents as a team: one plans, one writes the code, one reviews it. Your tests decide whether the work is done, and nothing is pushed until you approve it.**

AHP drives the coding agent CLIs you already use (Claude Code, Codex CLI, OpenCode, and Gemini CLI, which is untested so far) through a workflow such as *plan → implement → review → your approval → push*. Each step gets a structured, validated **handoff** from the one before it, works in its own git worktree, and passes only when **verification** passes: your test command, run in a fresh copy of the result. An agent saying "done" never counts.

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
    ...
    -  for (const item of cart.items) sum += item.price;
    -  return sum;
    +  for (const item of cart.items) sum += item.price * item.quantity;
    +  return sum * (1 - cart.discount);
     }
```

*(A real run: three Claude Code steps fix a cart bug and add a discount code. `npm test` passed in a fresh worktree before the review began.)*

> **Status: early, and usable.** Workflows run end to end with Claude Code, Codex CLI and OpenCode on Windows (Claude Code on Linux too). Gemini CLI's adapter has never run a real turn, and macOS is untested. See the [support matrix](docs/support-matrix.md).

## Why

Chaining coding agents by hand means copying text from one to the next, trusting each one's own summary, and finding out at the end that a step quietly went wrong. AHP makes each step explicit and checkable:

- **Verified, not claimed.** A step passes only when its check passes in a fresh worktree built from what the agent committed. If an attempt fails, its evidence goes back to the agent and it tries again, up to a retry budget.
- **Structured handoffs.** The plan's summary and decisions reach the implementer as validated fields, not as a wall of chat. Files are handed on by content hash.
- **Review that can say no.** If the reviewer asks for changes, the implement step goes back with its findings.
- **You approve what is pushed.** The run stops at an approval gate and shows you the diff. Only AHP pushes, never an agent.
- **Nothing is lost.** Every event goes to an append-only, hash-chained ledger. A crashed run picks up where it stopped (`ahp recover`), and Ctrl+C stops the agent and every process it started.
- **Mix tools.** Use Claude Code to plan, Codex to implement and OpenCode to review, or any other combination, each with the model you choose.

## Quick start

You need [Node.js](https://nodejs.org/) 24 or newer, git, and at least one coding agent CLI installed and logged in with its own login: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex) or [OpenCode](https://opencode.ai). AHP never asks for or stores API keys.

```sh
npm install -g github:Mohaned178/agent-handoff-protocol
```

This builds on install (about 30 s). If npm warns about install scripts, that is the build step.

Then, in your project's folder (a git repository with a commit and a remote named `origin`):

```sh
ahp doctor               # which agent tools AHP found, and whether they are logged in
ahp setup                # menus: what to build, the command that checks it, which agent does each step
ahp run ahp.workflow.mjs # plan → implement → review, then asks you to approve the diff
```

Run `ahp` on its own for these steps, and `ahp --help` for everything else.

## What a run looks like

In a terminal, `ahp run` shows one line per step. The step at work has a spinner, with its tool, the time it has taken and what the agent is doing. Each step that ends leaves its result on screen, along with what it changed. A failed attempt shows why it failed and that it is being retried, and a review that asks for changes shows its findings. Here is a real failure, where Codex's first try missed an export and its tool then ran out of quota:

```
  ✓ plan        Claude Code (haiku)   18s
  ↻ implement   attempt 1 failed: its check failed; trying again
      last attempt att_mvsq8fqw2f8f8d80 failed verification: npm test
      ...
      | SyntaxError: The requested module '../src/cart.mjs' does not provide an export named 'applyDiscount'
  ↻ implement   attempt 2 failed: the agent stopped with an error; trying again
      last attempt att_mvsq91244279ae69: You've hit your usage limit. ...
  ✗ implement   Codex CLI   1m 13s
      retry budget spent

✗ run failed
  every attempt, handoff and verification: ahp inspect run_mvsq81d8c54ae7cc
```

At the approval gate you see the full diff you are approving, and decide in place:

```
? waiting for your approval
  what you are approving: changed src/cart.mjs (+9 -2)
    diff --git a/src/cart.mjs b/src/cart.mjs
    ...
? Approve this change?
❯ Approve
  Reject
  Show the whole diff
  Decide later
```

- **Approve:** the run goes on, and AHP pushes the branch (`ahp/<task>`).
- **Reject:** you type a reason, and the implement step is sent back with it.
- **Decide later:** AHP prints the `ahp approve` / `ahp reject` commands, and the run waits.

The pushed branch's history reads like a story of the run:

```
bf4898f review: approved
6a60959 implement: Updated src/cart.mjs: total() now multiplies each price by quan…
6573cff plan: Read the repo (package.json, src/cart.mjs, test/cart.test.mjs)…
```

`--verbose` prints every event as a line instead, which is also what you get when the output goes to a file, a pipe or CI. `--diff` prints each attempt's whole diff.

## Your own workflow

`ahp setup` writes a plain JavaScript file you can read and edit. A step looks like this:

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
    { id: "review", agent: { adapter: "opencode", model: "opencode/glm-5.3-flash-free" }, review: { sendBackTo: "implement" }, verification: {} },
    { id: "approve", approval: {} },
    { id: "publish", action: { kind: "push_branch", branch: "ahp/fix-cart" } },
  ],
};
```

| Field | What it does |
|---|---|
| `agent` | Which tool runs the step: `claude-code`, `codex`, `opencode` or `gemini-cli`, with an optional `model` and `options.effort` |
| `verification.command` | Must exit 0 in a fresh worktree for the step to pass |
| `verification.requiredOutputFields` | Fields the agent must report (`summary`, `decisions`, ...), handed to the next step |
| `retry` | `{ budget }`: how many more attempts a failed step gets (default 2) |
| `timeout` | `{ totalMs, idleMs }`: stop an attempt that runs too long or goes silent (defaults: 1 hour, 10 minutes) |
| `capabilities` | `read_only` or `write_scope`. Each tool enforces these as far as it can; for most it is cooperative, see [limits](docs/limits.md) |
| `review` | `{ sendBackTo }`: a request for changes sends that step back |
| `approval` | Stop for a person's decision |
| `action` | `push_branch`, `open_pr` or `merge_pr`, performed by AHP after an approval |

## Commands

| Command | |
|---|---|
| `ahp doctor` | What is installed and logged in |
| `ahp setup` | Write a workflow (or an evaluation) in menus |
| `ahp run <file>` | Run a workflow |
| `ahp approve <run> <step>` / `ahp reject <run> <step> --reason "..."` | Decide a gate from another terminal or later |
| `ahp inspect <run>` | Everything about a run: attempts, handoffs, verification, usage, the diff |
| `ahp recover <run>` | Continue a run whose process stopped |
| `ahp eval <suite>` | Run an evaluation (below) |

Exit codes: `0` succeeded, `1` failed, `2` usage error, `3` needs a recovery decision, `4` waiting for approval, `130` cancelled.

## Supported tools

| Tool | Adapter | Tested on |
|---|---|---|
| Claude Code | `claude-code` | Windows, Linux (WSL2) |
| Codex CLI | `codex` | Windows |
| OpenCode | `opencode` (over ACP) | Windows |
| Gemini CLI | `gemini-cli` (over ACP) | not run yet |

Each tool uses its own login and your own subscription or plan, under that vendor's terms. AHP reports the model and token usage only where the tool itself reports them. The [support matrix](docs/support-matrix.md) has the details.

## Safety, honestly

- A git worktree keeps agents out of your checkout. **It is not a security boundary.** An agent can still run commands on your machine.
- Verification runs the code the agent wrote, on your machine.
- Permission limits such as `read_only` are mostly *cooperative*: the agent is told and the tool is asked. AHP says which level each tool reaches and never calls cooperation "enforcement".

Read [docs/limits.md](docs/limits.md) before you point AHP at anything important.

## Evaluation

AHP also measures whether structured handoffs actually help. `ahp eval` freezes a suite of tasks and runs each one under four conditions: a single agent, a plain-text pipeline, a pipeline with structured fields but no checks, and the full AHP workflow, plus a baseline that gets the same number of attempts. It repeats them in a seeded random order and scores every trial with independent validators and hidden tests. A negative result is a legitimate outcome. See [docs/evaluation.md](docs/evaluation.md) and the [pilot suite](docs/pilot.md).

## Development

```sh
git clone https://github.com/Mohaned178/agent-handoff-protocol && cd agent-handoff-protocol
npm install
npm test            # the whole Vitest suite (real git repos, a mock adapter, fake tools; no real agent runs)
npm run typecheck
npm run build && npm link   # `ahp` from your checkout
```

TypeScript on Node 24, with no build needed to run from source (`node src/cli/bin.ts <command>`). Developed on Windows, and CI runs on Windows, macOS and Linux.

## Learn more

- [How AHP works](docs/how-it-works.md): handoffs, verification, the ledger, crash recovery, cancelling
- Adapters: [Claude Code](docs/adapters/claude-code.md), [Codex](docs/adapters/codex.md), [OpenCode](docs/adapters/opencode.md), [Gemini CLI](docs/adapters/gemini-cli.md)
- [Support matrix](docs/support-matrix.md) and [limits](docs/limits.md)
- [Design direction](docs/design/ahp-v2-direction.md), [architecture decisions](docs/adr/), [glossary](GLOSSARY.md)
- [A2A mapping](docs/a2a-mapping.md): how AHP's shapes map to the Agent2Agent protocol

## License

[Apache-2.0](LICENSE)
