# Agent Handoff Protocol (AHP)

AHP makes handoffs between AI coding agents explicit, verifiable and measurable, and evaluates whether doing so improves real task outcomes.

## Agents and adapters

**Coding agent**:
An external coding CLI (Claude Code, Codex CLI, Gemini CLI, OpenCode) with its own model, tools, loop and login.
_Avoid_: Model, backend, inference engine

**Adapter**:
The per-tool component that drives one coding agent through its transport and declares that tool's capabilities.
_Avoid_: Inference adapter, driver, plugin

**Transport**:
The interface an adapter uses to drive a coding agent: a vendor-maintained interface (native ACP, the vendor's SDK or app-server protocol) where one exists, otherwise the tool's headless mode.
_Avoid_: Protocol (reserved for AHP itself)

**Third-party bridge**:
An ACP adapter for a tool that is maintained by someone other than that tool's vendor. Not a release-1 transport.

## Work and execution

**Run**:
One execution of a workflow from start to a terminal state.

**Step**:
One unit of work in a run, assigned to one coding agent, that succeeds only when its verification passes.
_Avoid_: Task (reserved for the A2A-aligned task shape), stage

**Attempt**:
One execution of a step by exactly one fresh coding-agent process; every retry is a new attempt.
_Avoid_: Try, turn, session

**Handoff**:
The immutable, versioned envelope that passes a step's contract, context, artifact references and capability requests to the next coding agent.
_Avoid_: Message, prompt, chat dump

**Handoff revision**:
A new version of a handoff, issued when a step's input changes (evidence attached on retry, a send-back, or a reroute); the earlier revision becomes `superseded`.

**Send-back**:
A later step returning the immediately preceding agent step for a retry, with its findings or rejection reason as evidence; the only backward edge in a workflow.
_Avoid_: Loop, rework edge

**Approval gate**:
A step with no coding agent that waits for a human to approve or reject before the run continues.
_Avoid_: Approval checkpoint, approvals inbox

**Artifact**:
A file or output passed in a handoff by reference, identified by the hash of its committed content.
_Avoid_: Attachment, copy

**Ledger**:
The append-only record of everything that happened in a run, from which run, step and attempt state are derived.
_Avoid_: Log, state store, checkpoint

## Verification

**Verification**:
The runtime's check of an attempt's result against the step's acceptance criteria; the only source of step success.
_Avoid_: Testing step, self-report, Tester

**Verification worktree**:
A fresh workspace built from the snapshot of an attempt's result, in which verification runs.

**Hidden tests**:
Tests supplied by the workflow or evaluation task and introduced only at verification time, never visible to the coding agent.

**Protected path**:
A path the attempt must not change (hidden tests, test runner config, test scripts, CI config); changing one fails verification.

**Structural verification**:
Verification that checks only that required output fields are present, as for a review step outside evaluation; it says nothing about quality.

## Isolation, capabilities and side effects

**Workspace**:
The git worktree an attempt runs in; isolation, never a security boundary.
_Avoid_: Sandbox

**Enforcement level**:
How strongly an applied capability is upheld: `enforced_by_tool`, `cooperative` or `none`.

**Network stance**:
The network access a step permits to the coding agent's own tool use (web fetch and search, shell network); never the agent's connection to its model provider.

**External action**:
An effect outside the workspace and shared repo, such as push, PR or merge, performed only by AHP after verification and approval. Deploy is not an external action AHP performs in release 1.

**Forbidden external action detected**:
Verification evidence that a coding agent performed an external action; its absence is not proof that none occurred.

## Recovery and evaluation

**Recovery policy**:
The per-step rule for an attempt whose outcome is `unknown`: `manual` (default), `adopt` or `abort`.

**Matched-budget baseline**:
A single-agent condition given the same number of independent attempts as the condition it is compared with, counted as a success if any attempt passes.

**Support matrix**:
The published table of adapter × OS cells, each marked passed (with tool version and date) or untested.

**Harness incident**:
An evaluation trial ended by an `unknown` attempt; excluded from condition success and failure counts and reported separately per condition.
_Avoid_: Failure, error
