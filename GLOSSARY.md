# Agent Handoff Protocol (AHP)

AHP makes handoffs between AI coding agents explicit, verifiable and measurable, and evaluates whether doing so improves real task outcomes.

## Agents and adapters

**Coding agent**:
An external coding CLI (Claude Code, Codex CLI, Gemini CLI, OpenCode) with its own model, tools, loop and login.
_Avoid_: Model, backend, inference engine

**Adapter**:
The per-tool component that drives one coding agent through its transport and declares that tool's capabilities.
_Avoid_: Inference adapter, driver, plugin

**Adapter declaration**:
What an adapter says about itself statically, the same on every run: its transport kind, its model reporting level, the login its tool needs, whether its transport has a graceful cancel, and the enforcement level at which it applies each capability and each network stance on each operating system (stated for every one; `none` says it cannot). The runtime checks a handoff against it before any agent starts. The levels are claims about the tool that the conformance suite checks.

**Model reporting level**:
How much an adapter can say about its tool's model: `enumerable` (the integration lists selectable models), `pass_through` (the tool accepts a model name, which is passed on unvalidated) or `not_exposed`. AHP never claims to discover what a subscription entitles the user to.

**Login kind**:
The login an adapter's tool needs: `none`, `tool_login` (made in the tool itself) or `api_key` (configured through the tool's own settings or environment). AHP stores no credential.

**Transport**:
The interface an adapter uses to drive a coding agent: a vendor-maintained interface (native ACP, the vendor's SDK or app-server protocol) where one exists, otherwise the tool's headless mode.
_Avoid_: Protocol (reserved for AHP itself)

**Third-party bridge**:
An ACP adapter for a tool that is maintained by someone other than that tool's vendor. Not a release-1 transport.

## Work and execution

**Run**:
One execution of a workflow from start to a terminal state.

**Step**:
One unit of work in a run, assigned to one coding agent, that succeeds only when its verification passes. Approval gates and external-action steps are steps with no coding agent.
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
One of a closed set of machine-readable codes saying why a handoff revision was rejected: schema invalid, artifact hash mismatch, unmet dependency or capability unsatisfiable.

**Capability unsatisfiable**:
A rejection reason: the recipient's adapter cannot apply a requested capability, or the network stance, at the enforcement level the handoff requires on the operating system the run is on. Checked against the adapter's declaration, before any agent runs; every request it fails is reported, with where it is in the document.

**Unmet dependency**:
A rejection reason: something the handoff requires, such as a field, an artifact or the base commit, is not there.

**Send-back**:
A later step returning the immediately preceding agent step for a retry, with its findings or rejection reason as evidence; the only backward edge in a workflow. A review's send-back spends one retry of the preceding step's shared budget, exactly as a failed verification would, and with none left the review step fails and so does the run. The step sent back starts a new attempt in a new workspace from its base commit, not from the result that was reviewed.
_Avoid_: Loop, rework edge

**Review step**:
A step that declares `review: { sendBackTo }` naming the step immediately before it. Besides what its verification lists, it must report `verdict` (`approved` or `changes_requested`) and `findings`, both required output fields. `changes_requested` sends the named step back; `approved` lets the run go on. A verdict that is neither fails verification, and so do changes requested without findings, so a send-back never carries empty evidence.

**Review findings**:
What a review step reported in `findings`, carried as `review_findings` evidence in the new handoff revision of the step it sent back. Written by the reviewing agent, so unlike a hidden test's output they are shown to the agent whole.

**Approval gate**:
A step declared `approval: {}` (and nothing else but its ID) with no coding agent, no handoff, no attempt and nothing to verify, placed after an agent step. When the step before it has succeeded, the run records an approval request, stops in `waiting_approval` and its process exits. `ahp approve` lets the run go on; `ahp reject --reason` sends back the step immediately before the gate, which in a workflow that has a review right before the gate is the review. There is no edit. A step after a gate (past any external actions) receives the result of the agent step before the gate.
_Avoid_: Approval checkpoint, approvals inbox

**Approval request**:
What the run puts to the approver when it stops at a gate: the verified attempt of the step before the gate, its snapshot commit, and the paths that differ between the run's base commit (what a later push would publish) and that commit. A decision applies to that commit and no other. `ahp inspect` adds the diff itself, read from the pinned snapshot, with the attempt's verification evidence and what any review before the gate found.

**Approval decision**:
A person's approval or rejection of an open request, recorded with who (the operating system's user name) and when. Made by a command that takes the ledger lock, so it is refused while a process is writing the run, when the step is not a gate with an open request, and for a rejection without a reason. A rejection's reason reaches the coding agent whole, without the approver's name, as `approval_rejected` evidence.

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
Verification of a step that declares no command, which checks only that its required output fields are present (for a review step: that it reported a verdict AHP understood, and findings), as for a review step outside evaluation; it says nothing about the quality of the review. Reports label it so.

## Failures and retries

**Failure class**:
One of a closed set of codes saying why an attempt, or the step it belongs to, failed, which decides how the failure is handled: `rejected`, `config_auth`, `transient`, `agent_error`, `verification_failed`, `inconclusive`, `unknown` or `external_action_failed` (an external-action step, which has no attempt). An attempt whose coding agent did not end cleanly (non-zero exit, a stop reason of `refusal`, `max_tokens` or `max_turn_requests`, or an error its adapter reported) is classified before verification and is not verified.

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
For a send-back, the review's findings instead. For a failed verification, the failing parts of a verification, trimmed to what the coding agent may see, carried in the `evidence` of the next handoff revision (empty for revision 1): a failing command's exit code and the end of its output, the required output fields it left out, the changed paths that violated a protected path, the shared refs it changed. The output of a command that runs hidden tests is withheld, and the list of protected paths is never shown, since it holds the hidden tests' paths; the ledger keeps the full evidence.

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

**Capability**:
Something a step asks of its coding agent's tool use, from a closed list: `read_only` (change no file), `write_scope` (change files only under listed paths) and `no_external_actions` (push, open or merge nothing and change no shared ref; ADR 0003). Every agent step carries `no_external_actions` whether or not its workflow lists it.

**Capability request**:
A capability in a handoff with the weakest enforcement level it may be applied at (`require`). A request the workflow lists defaults to `cooperative`: the adapter must at least ask the agent. The baseline `no_external_actions` and the network stance require `none`, so they are applied as far as the adapter can and reported, and are never the reason a handoff is rejected. Each kind is requested at most once, and `read_only` and `write_scope` are not requested together.

**Enforcement level**:
How strongly an applied capability is upheld: `enforced_by_tool` (the coding agent's own tool blocks what it forbids, so the agent cannot do it however it is prompted), `cooperative` (the agent is only asked, by a prompt instruction or an ACP permission request it may answer or ignore; nothing stops it) or `none` (not applied). Only `enforced_by_tool` is enforcement: prompt instructions and ACP permission requests are never described as it.

**Applied capability**:
A requested capability with the enforcement level the adapter's declaration reaches for it on the operating system the run is on, recorded with the attempt before its agent starts. The level is the declared one: AHP does not ask the tool afterwards, and an adapter that cannot apply a capability fails the attempt instead of applying it more weakly.

**Network stance**:
The network access a step permits to the coding agent's own tool use (web fetch and search, shell network); never the agent's connection to its model provider. `deny` (the default) or `package_registries` (package registries only, so an implement step can install dependencies). It is applied at the level the adapter declares and reported with the capabilities.

**Requested model**:
The model a step names for its coding agent, recorded as requested and passed to the tool unvalidated.

**Reported model**:
The model the coding agent's tool said it ran, as it said it, recorded beside the requested one. `unknown` when the tool did not say; never filled in from the request.

**Usage report**:
What a coding agent's tool reported using for an attempt (token counts, a cost), with the source of the numbers. Recorded only when the adapter reports it: a number the tool did not give is null, never 0, and nothing is estimated, derived or summed across attempts. A report that names no source, has a negative or non-finite number, or reports no number at all is not recorded. The mock adapter's usage is scripted and labelled so.

**External action**:
An effect outside the workspace and shared repo, such as push, PR or merge, performed only by AHP after verification and approval. Deploy is not an external action AHP performs in release 1.

**External-action step**:
A step declared `action: { kind, ... }` (and nothing else but its ID) that AHP performs itself: `push_branch` (the approved commit, as it is, to a branch; never forced), `open_pr` or `merge_pr` (through the GitHub CLI under the user's own login, the merge only while the approved commit is the pull request's head). It follows an approval gate, with nothing but external actions between them, and publishes the commit that gate approved; a pull request needs a push of its branch after the same gate, and a merge an opened pull request. AHP records its intent, checks the remote, and performs it only when the check finds it not done, so a resumed run never acts twice. One that cannot be done fails as `external_action_failed`, never retried.
_Avoid_: Publish step, deploy step

**Forbidden external action detected**:
Verification evidence that a coding agent performed an external action: a shared ref changed while its agent ran. It fails verification like any other failing evidence (the command is not run, and a retry is told which refs changed). AHP cannot tell who changed them, so a person or an editor fetching meanwhile shows the same; and detection is partial (a push to a URL or through an API leaves no ref), so its absence is not proof that none occurred.

**Shared refs**:
The refs every worktree of a repository shares (branches, tags, remote-tracking refs, the stash), less AHP's own under `refs/ahp/`. They are recorded just before each attempt is dispatched and again once it has exited or been found unknown, so a ref an agent moved shows.

## Recovery and evaluation

**Unknown attempt**:
An attempt that was dispatched and has no record of how it ended: the runtime stopped while it ran, its adapter lost contact with the agent, or a kill could not be confirmed. Its agent may have done anything, and may still be running, so it is never dispatched or retried again; its step's recovery policy, or a person, decides what becomes of it.
_Avoid_: Crashed attempt, failed attempt

**Recovery report**:
What AHP records about an unknown attempt for whoever decides on it: the last ledger events before it was found unknown, what its workspace holds against the step's base commit, how the shared refs moved since just before it was dispatched, the transport's tool-call log if the adapter keeps one, and the statement that host and external effects are undetermined.

**Recovery policy**:
The per-step rule for an unknown attempt: `manual` (default: the run stops in `needs_recovery` and a person decides with `ahp recover <attempt> --policy adopt|abort`), `adopt` (its workspace is verified as the attempt's result; a result that fails ends the step, never retried) or `abort` (the step fails as `unknown`). `discard_and_retry` is deferred past release 1.

**Resume**:
A later process continuing a run whose process stopped, from wherever its ledger stops; `ahp recover <run>` does it, and records it as `run_resumed`.

**Cancel**:
Stopping a run on request (Ctrl+C on `ahp run`, or the SDK's abort signal): the running agent and every process it started are stopped, no further agent is dispatched, and the run ends `cancelled`. An attempt is recorded `cancelled` only once every process of its tree was seen gone, as graceful (the transport's cancel, or SIGTERM to its process group) or forced (the tree killed; always so on Windows without ACP); a kill that cannot be confirmed makes it an unknown attempt.
_Avoid_: Abort (a recovery decision), kill (one way a cancel ends)

**Process layer**:
The shared code every adapter starts its coding agent through: it resolves the tool's real executable (an npm `.cmd` shim is read, never run through `cmd.exe`), passes the prompt on stdin, and stops whole process trees.

**Matched-budget baseline**:
A single-agent condition given the same number of independent attempts as the condition it is compared with, counted as a success if any attempt passes.

**Conformance suite**:
The one set of checks every adapter is run against, through the adapter contract only: it starts a coding agent that the adapter's subject provokes, and checks how the attempt ended and was normalized, failure classification, requested versus reported model, usage and its source, a graceful and a forced cancel (the tree gone, confirmed by PID), and that each capability and network stance holds at its declared level on this OS. A check the subject cannot provoke is skipped, never passed, and only `enforced_by_tool` has behaviour to break: a `cooperative` level is checked only as accepted, which is not enforcement. It runs against the mock in CI and against a real adapter only on the maintainer's machine; its result is one adapter on one OS label, recorded with the tool version and date.
_Avoid_: Integration test, adapter test

**Support matrix**:
The published table of adapter × OS cells, each marked passed (with tool version and date) or untested.

**Harness incident**:
An evaluation trial ended by an `unknown` attempt; excluded from condition success and failure counts and reported separately per condition. Only that: a trial that could not be scored for another reason is unscored.
_Avoid_: Failure, error

## Evaluation

**Evaluation task**:
A directory holding one task of an evaluation suite: `task.json` (id, prompt, planted constraints, seeded defects, how the result is verified, network stance), the fixture repository under `repo/` and the hidden tests under `hidden/`. Not the A2A task shape.
_Avoid_: Step, benchmark

**Suite**:
The module `ahp eval` runs: the evaluation tasks, the conditions, the coding agent for each role (`plan`, `implement`, `review`) and the retry budget of C3's steps.

**Frozen task**:
An evaluation task whose directory was hashed and recorded in the evaluation's ledger before any trial started. The hash is the SHA-256 of the sorted (relative path, content hash) pairs of every file; it is taken again before each trial, and a task that no longer hashes as frozen stops the evaluation (`task_changed`), never to be frozen again.
_Avoid_: Locked, pinned

**Condition**:
How the same task is worked: C0, one coding agent doing the whole task in one step with no retry budget (only a `transient` failure is retried, as in every condition); C3, full AHP (plan, implement, review; handoffs, hidden tests as the implement step's verification, bounded retry and send-back). C1, C2 and the matched-budget baseline are to come. A condition builds an ordinary workflow, which the run API runs; it has agent steps only, so no approval gate and no external action, and recovers every `unknown` attempt by abort.

**Trial**:
One condition's workflow run once on one task, in a fresh repository made from the task's fixture, then scored. Ends `scored`, as a harness incident, `unscored` or `cancelled`.

**Validators**:
What scores a trial, after its run has ended, in a verification worktree of its own built from the last snapshot the run made: the hidden tests (a pass is those passing with no protected path changed) and the planted constraints' checks. They share no verdict with the run's verification, and the agent's own report is not read.
_Avoid_: Tester, judge

**Planted constraint**:
A constraint a task states to the first agent only (in the prompt of C0's one step, and of C3's plan step), with a deterministic check, a forbidden pattern or a required invariant, never a judgement. A later step of C3 knows it only through its handoff's context, so a constraint violated in the result is context lost. Scored apart from success; a result that changed nothing holds it vacuously and is left out of the violation rate.

**Seeded defect**:
A defect a task's fixture is known to contain, for review evaluation. Frozen with the task; not scored yet.

**Unscored trial**:
A trial with nothing to score and not a harness incident, with its reason: `validator_inconclusive` (a validator could not run to a result, twice), `setup_failed` (a step of the run ended `config_auth` or `rejected`, so the condition did not run as configured) or `harness_error` (AHP threw). Excluded from the rates and reported apart, never read as a pass or a fail.

**Evaluation ledger**:
The hash-chained ledger of one `ahp eval` invocation, written by the same writer as a run's: the tasks frozen, and each trial's start, incident and end. Everything about how a trial's run went is in that run's own ledger, which the trial keeps a copy of.

**Raw transcript**:
What an attempt's agent process was sent on stdin and what it printed on stdout, byte for byte, kept by the process layer in files beside the run's ledger. Stderr is not kept. It holds whatever the tool printed, so a secret an agent printed is in it.
