# Changelog

What changed for people who use AHP, newest first. Versions follow [semantic versioning](README.md#versions-and-support); while
the version is 0.x, a minor version may break something, and its entry says how to move.

## 0.1.0 (unreleased)

The first published version, an **alpha**: it runs end to end, and it has not yet been run on real projects
(real tools have run only in its conformance suites).

- `ahp "<task>"` does a task in one sentence: it works out the check command, the install command and which of your
  coding agent tools does each step, shows them, and runs implement → review → your approval once you say Run. The
  approved work goes on a local branch `ahp/<task>`, or is pushed with `--push`.
- Adapters for Claude Code, Codex CLI and OpenCode, combinable in one run. Each step passes only when its check
  passes in a fresh copy of the agent's work; a failure goes back to the agent with the evidence, within a retry
  budget, and a review that asks for changes sends the work back.
- `ahp demo` tries AHP in a sample project with scripted agents, free; `ahp doctor` says which tools AHP can use and
  how to install or log in to the others.
- Every run keeps a hash-chained ledger: `ahp runs` lists them, `ahp inspect` shows the receipt and every attempt,
  `ahp recover` continues a run whose process stopped, and Ctrl+C stops the agent and every process it started.
- Workflows as files (`ahp setup`, `ahp run`), approval gates (`ahp approve`, `ahp reject`) and pushes or pull
  requests made only by AHP, after approval.
- `ahp eval` runs an evaluation suite under conditions C0 to C3 and a matched-budget baseline. No evaluation result
  is published yet.
- Usage and cost are shown only as each tool reported them, per tool, with their source; nothing is estimated.

Supported systems: see the [support matrix](docs/support-matrix.md). macOS is untested for every tool.
