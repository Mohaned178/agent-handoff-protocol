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

**Handoff context**:
The previous step's required output fields, carried in a handoff so early decisions are not lost. It is not A2A's `contextId`, which identifies the run.
_Avoid_: Chat history, memory

**Sender**:
The step whose passing attempt a handoff hands on.

**Recipient**:
The step a handoff is issued to, and whose coding agent receives it.

**Rejection reason**:
One of a closed set of machine-readable codes saying why a handoff revision was rejected: schema invalid, artifact hash mismatch or unmet dependency.

**Unmet dependency**:
A rejection reason: something the handoff requires, such as a field, an artifact or the base commit, is not there.

**Send-back**:
A later step returning the immediately preceding agent step for a retry, with its findings or rejection reason as evidence; the only backward edge in a workflow.
_Avoid_: Loop, rework edge

**Approval gate**:
A step with no coding agent that waits for a human to approve or reject before the run continues.
_Avoid_: Approval checkpoint, approvals inbox

**Artifact**:
A file passed in a handoff by reference, identified by the hash of its committed content. A step may name a file it did not write, such as one already in the repository.
_Avoid_: Attachment, copy

**Output field**:
A named value, text or a list of text, that a coding agent reports for an attempt. It is the agent's claim, which verification checks.

**Required output field**:
An output field a step's verification demands; those of a passing attempt become the next handoff's context.

**Ledger**:
The append-only record of everything that happened in a run, from which run, step and attempt state are derived.
_Avoid_: Log, state store, checkpoint

**Hash chain**:
What links each ledger event to the one before it: every event records the previous event's hash and its own SHA-256 over its canonical JSON, so an event changed, reordered or missing anywhere but at the end shows. A ledger whose chain is broken is corrupt, and no state is derived from it.

**Torn tail**:
A last ledger line that a write did not finish (no newline, or not JSON), as a crash in the middle of an append leaves it. It was never recorded: readers leave it out, and the next process to open the ledger for writing truncates it and records that it did.

**Ledger lock**:
The file beside a run's ledger, created exclusively, that names the one process writing the run: its host, PID and start time.

**Stale lock**:
A ledger lock whose process is no longer running, so whatever it was doing stopped partway and the run needs recovery. AHP never takes one over by itself: `ahp recover` does when a person asks, and records whose it was in the ledger. The stale lock of a run that had already ended takes no event: `ahp recover` removes it and says so.

## Verification

**Verification**:
The runtime's check of an attempt's result against the step's acceptance criteria; the only source of step success.
_Avoid_: Testing step, self-report, Tester

**Verification worktree**:
A fresh workspace built from the snapshot of an attempt's result, in which verification runs.

**Hidden tests**:
Tests supplied by the workflow or evaluation task and introduced only at verification time, never visible to the coding agent. They are written into the verification worktree alone, never into the agent's workspace, the snapshot or the handoff.

**Protected path**:
A path the attempt must not change (hidden tests, test runner config, test scripts, CI config); changing one fails verification. A file, or a directory with everything under it.

**Diff scope**:
Evidence of what an attempt changed: the paths that differ between the step's base commit and the attempt's snapshot, with how each changed. Protected paths are checked against it.

**Verdict**:
The result of verification: `pass`, `fail` or `inconclusive`, each with evidence. Any failing evidence item fails it; otherwise any inconclusive item makes it inconclusive.

**Inconclusive**:
A verdict meaning the validator could not run to a result, so it says nothing about the attempt: the command ended on a signal or exited 126 or 127, or AHP could not set verification up (the worktree, the install, the hidden tests). Never counted as pass or fail; re-run once on the same snapshot, then escalated.

**Structural verification**:
Verification of a step that declares no command, which checks only that its required output fields are present, as for a review step outside evaluation; it says nothing about quality.

## Failures and retries

**Failure class**:
One of a closed set of codes saying why an attempt, or the step it belongs to, failed, which decides how the failure is handled: `rejected`, `config_auth`, `transient`, `agent_error`, `verification_failed`, `inconclusive` or `unknown`. An attempt whose coding agent did not end cleanly (non-zero exit, a stop reason of `refusal`, `max_tokens` or `max_turn_requests`, or an error its adapter reported) is classified before verification and is not verified.

**Adapter error**:
What an adapter observed go wrong with its tool, with the failure class it belongs to (`config_auth`, `transient` or `agent_error`) and a message for the user. It outranks the exit code and the stop reason when an attempt is classified.

**Stop reason**:
Why a coding agent's turn ended, as its adapter normalizes it (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`). Outcome detail, never proof that the process exited.

**Retry**:
A new attempt for a step after a failed one, always in a new workspace made from the step's base commit. Same-input retries run under the same handoff revision; a retry whose input changed (evidence, a reroute) runs under a new one.

**Retry budget**:
How many retries a step may spend, counted from the ledger so a restart sees what is left: one budget shared by `agent_error` and `verification_failed` (default 2), and one for `transient` (default 5). An inconclusive verification and a `config_auth` failure spend nothing.

**Backoff**:
The wait before a transient retry: exponential, and capped in total for the step, so a rate limit does not burn a whole quota. A retry that would pass the cap is not made.

**Retry evidence**:
The failing parts of a verification, trimmed to what the coding agent may see, carried in the `evidence` of the next handoff revision (empty for revision 1): a failing command's exit code and the end of its output, the required output fields it left out, the changed paths that violated a protected path. The output of a command that runs hidden tests is withheld, and the list of protected paths is never shown, since it holds the hidden tests' paths; the ledger keeps the full evidence.

**Reroute**:
Handing a step whose retry budget is spent to its alternative coding agent, under the same contract, in a new handoff revision. Off by default; a step is rerouted at most once, and the alternative starts on budgets of its own. Never offered for `rejected`, `config_auth`, `inconclusive` or `unknown`.

**Escalation**:
What an inconclusive verification comes to when its one re-run is inconclusive too: the step fails as `inconclusive` and is surfaced to the user, who must fix the validator or its environment. Never retried and never counted.

## Isolation, capabilities and side effects

**Workspace**:
The git worktree an attempt runs in; isolation, never a security boundary.
_Avoid_: Sandbox

**Snapshot**:
The commit AHP makes of an attempt's workspace after its process exits, whether or not the agent committed; verification and the next step build on it.
_Avoid_: Checkpoint

**Base commit**:
The commit a step's workspace starts from: the repository's HEAD when the run began for the first step, the previous step's snapshot for later ones. Artifact hashes are read from it.

**Enforcement level**:
How strongly an applied capability is upheld: `enforced_by_tool`, `cooperative` or `none`.

**Network stance**:
The network access a step permits to the coding agent's own tool use (web fetch and search, shell network); never the agent's connection to its model provider.

**External action**:
An effect outside the workspace and shared repo, such as push, PR or merge, performed only by AHP after verification and approval. Deploy is not an external action AHP performs in release 1.

**Forbidden external action detected**:
Verification evidence that a coding agent performed an external action; its absence is not proof that none occurred.

**Shared refs**:
The refs every worktree of a repository shares (branches, tags, remote-tracking refs, the stash), less AHP's own under `refs/ahp/`. They are recorded just before each attempt is dispatched and again once it has exited or been found unknown, so a ref an agent moved shows.

## Recovery and evaluation

**Unknown attempt**:
An attempt that was dispatched and has no record of how it ended: the runtime stopped while it ran, its adapter lost contact with the agent, or a kill could not be confirmed. Its agent may have done anything, and may still be running, so it is never dispatched or retried again; its step's recovery policy, or a person, decides what becomes of it.
_Avoid_: Crashed attempt, failed attempt

**Recovery report**:
What AHP records about an unknown attempt for whoever decides on it: the last ledger events before it was found unknown, what its workspace holds against the step's base commit, how the shared refs moved since just before it was dispatched, the transport's tool-call log if the adapter keeps one, and the statement that host and external effects are undetermined.

**Recovery policy**:
The per-step rule for an unknown attempt: `manual` (default: the run stops in `needs_recovery` and a person decides with `ahp recover <attempt> --policy adopt|abort`), `adopt` (its workspace is verified as the attempt's result) or `abort` (the step fails as `unknown`). `discard_and_retry` is deferred past release 1.

**Resume**:
A later process continuing a run whose process stopped, from wherever its ledger stops; `ahp recover <run>` does it, and records it as `run_resumed`.

**Matched-budget baseline**:
A single-agent condition given the same number of independent attempts as the condition it is compared with, counted as a success if any attempt passes.

**Support matrix**:
The published table of adapter × OS cells, each marked passed (with tool version and date) or untested.

**Harness incident**:
An evaluation trial ended by an `unknown` attempt; excluded from condition success and failure counts and reported separately per condition.
_Avoid_: Failure, error
