# Spec: AHP release 1

Status: ready-for-agent

Sources: `docs/design/ahp-v2-direction.md` (§9 is authoritative where it differs from §1–§8), `docs/adr/0001`–`0006`, `GLOSSARY.md`. Terms in this spec are used as the glossary defines them.

## Problem Statement

A developer who combines several coding agents (Claude Code, Codex CLI, Gemini CLI, OpenCode) on one task today passes work between them as raw chat text. Decisions and constraints made early get lost, nobody can say which coding agent owns the work, agents claim success that no one checked, a crash leaves the developer unsure what already happened (including whether something was pushed), and there is no evidence that splitting work across agents beats using one. The developer has no record they can trust, no safe way to recover, and no honest measurement.

## Solution

AHP gives the developer a local tool and TypeScript SDK that run a workflow of steps, each assigned to one coding agent through a dedicated adapter. Every step receives an immutable, versioned handoff carrying its contract, context, artifact references and capability requests. A step succeeds only when the runtime's verification passes in a fresh verification worktree; the agent's own claims never count. Failures are classified and retried within a budget, a reviewer or human can send work back one step, and an approval gate precedes any external action, which only AHP performs. Everything is written first to an append-only ledger, so state survives crashes, `unknown` outcomes are never retried automatically, and the developer receives a recovery report stating what is and is not known. An evaluation engine runs fixed task suites under conditions C0–C3 plus a matched-budget baseline, and reports whether structured handoffs improve verified success and reduce context loss, including when the answer is no.

## User Stories

### Setup and connection

1. As a developer, I want `ahp doctor` to tell me which of the four coding agents are installed, their versions, and whether each is logged in, so that I know what I can use before I start.
2. As a developer, I want `ahp doctor` to report my OS, Node version and git version against the requirements, so that I find environment problems before a run fails.
3. As a developer, I want `ahp doctor` to show, per installed adapter, which capabilities it can apply on this OS and at what enforcement level, so that I know what is actually enforced.
4. As a developer, I want `ahp doctor` to say when a tool needs paid access (e.g. Gemini CLI), so that I am not surprised by a login failure.
5. As a developer, I want to connect only the tools I have, so that AHP is useful with one, two, three or four coding agents.
6. As a developer, I want AHP to never store my provider credentials, so that my logins stay under each tool's control.
7. As a developer, I want `ahp init` to create a minimal workflow definition in my repo, so that I can start from a working example.
8. As a developer, I want the generated example to be the password-reset reference scenario, so that I can see every feature in one place.
9. As a developer on Windows, I want AHP to work natively without WSL, so that I can use it on my only machine.
10. As a developer, I want AHP to refuse to start on Node below 24 with a clear message, so that I do not hit obscure runtime errors.

### Defining workflows

11. As a developer, I want to define a workflow in TypeScript with the SDK, so that my workflow is type-checked.
12. As a developer, I want to declare a linear sequence of steps, so that the order of work is explicit.
13. As a developer, I want each step to name its coding agent and requested model, so that I control who does what.
14. As a developer, I want each step to declare acceptance criteria (verification command, required output fields, protected paths), so that success is defined before the run.
15. As a developer, I want each step to declare its side-effect class (`workspace_only` or `may_have_external_effects`), so that recovery knows what kind of step it is dealing with.
16. As a developer, I want each step to declare its network stance, defaulting to `deny`, so that agent tool network use is opt-in.
17. As a developer, I want an implement step to opt in to package-registry access only, so that it can install dependencies without broader access.
18. As a developer, I want each step to declare capability requests (e.g. write only under a path), so that the runtime can apply them and report enforcement levels.
19. As a developer, I want to set a step's recovery policy (`manual`, `adopt`, `abort`), defaulting to `manual`, so that crash handling is explicit.
20. As a developer, I want to set retry budgets per step, defaulting to 2 retries for `agent_error`/`verification_failed` and 5 for `transient`, so that retries are bounded.
21. As a developer, I want to configure an alternative coding agent for a step (reroute), off by default, so that a failing agent can be replaced under the same contract.
22. As a developer, I want to add an approval gate step, so that a human decides before AHP performs an external action.
23. As a developer, I want to add an external-action step (push branch, open PR, merge), so that AHP performs it only after verification and approval.
24. As a developer, I want a review step to declare that "changes requested" sends back the preceding agent step, so that review findings get acted on.
25. As a developer, I want the SDK to reject invalid workflows (parallel steps, send-back further than one step, external action without a preceding approval gate, unknown adapter), so that I find mistakes before running.
26. As a developer, I want `discard_and_retry` to be rejected as a recovery policy with a message that it is deferred, so that I am not misled into thinking it exists.

### Running

27. As a developer, I want `ahp run` to execute a workflow against my repo, so that I can use AHP without writing code beyond the definition.
28. As a developer embedding AHP, I want an SDK call that runs a workflow and returns the run ID, so that I can integrate AHP into my own scripts.
29. As a developer, I want each attempt to run in its own git worktree, so that attempts cannot overwrite each other's files.
30. As a developer, I want docs and reports never to call a worktree a sandbox, so that I do not overestimate the isolation.
31. As a developer, I want each attempt to be exactly one fresh coding-agent process, so that `exited` always means the process really ended.
32. As a developer, I want the runtime to issue a handoff to each step and validate it on the recipient's behalf, so that malformed or unsatisfiable work is rejected before an agent runs.
33. As a developer, I want handoff rejection reasons to be machine-readable (schema invalid, artifact hash mismatch, unmet dependency, capability unsatisfiable at the required enforcement level on this OS), so that I can act on them.
34. As a developer, I want the handoff to carry the previous step's required output fields (decisions, constraints, summary) as context, so that early decisions are not lost.
35. As a developer, I want artifacts passed by reference with a hash of their committed content, so that a handoff between Windows and Linux does not fail on line endings.
36. As a developer, I want AHP to snapshot each attempt's workspace into a commit after the process exits, so that verification sees exactly what the agent produced even if it did not commit.
37. As a developer, I want verification to run in a fresh verification worktree built from that snapshot, so that the agent's leftover processes and files cannot influence it.
38. As a developer, I want hidden tests introduced only at verification time, so that the agent cannot see or edit them.
39. As a developer, I want any change to a protected path to fail verification with evidence, so that an agent cannot pass by editing the tests or the test runner.
40. As a developer, I want agent-written tests allowed but never counted toward verification, so that agents can still write tests for their feature.
41. As a developer, I want the verification command to come from the workflow definition, so that the agent cannot redefine what "passing" means.
42. As a developer, I want verification verdicts `pass`, `fail` or `inconclusive` with attached evidence, so that a broken validator is never mistaken for a pass or a fail.
43. As a developer, I want review steps outside evaluation to be labelled "structural verification", so that I know the review's quality was not checked.
44. As a developer, I want a step to succeed only when verification passes, so that agent self-reports never count.
45. As a developer, I want run progress streamed to my terminal (step, attempt, state), so that I can follow a long run.
46. As a developer, I want the docs to state that verification executes agent-written code on my machine, so that I understand the risk.

### Failures, retries and send-back

47. As a developer, I want every attempt failure classified (`rejected`, `config/auth`, `transient`, `agent_error`, `verification_failed`, `inconclusive`, `unknown`), so that each gets the right handling.
48. As a developer, I want `config/auth` failures surfaced without retry, so that a missing login is not retried pointlessly.
49. As a developer, I want `transient` failures retried with exponential backoff and a capped total wait, so that a rate limit does not burn my whole quota.
50. As a developer, I want `verification_failed` retries to receive the failing evidence in a new handoff revision, so that the agent knows what to fix.
51. As a developer, I want same-input retries to be new attempts under the same handoff revision, and changed-input retries to issue a new revision that supersedes the old one, so that the ledger shows exactly what each attempt received.
52. As a developer, I want every retry in a new workspace with a new attempt ID, so that a failed attempt's files never leak into the next.
53. As a developer, I want a review "changes requested" verdict to send back the implement step with findings as evidence, within its retry budget, so that review changes the outcome.
54. As a developer, I want an exhausted budget to reroute (if configured) and otherwise fail the step, so that runs end instead of looping.
55. As a developer, I want `inconclusive` verification re-run or escalated, never counted, so that a crashed validator does not decide the result.

### Cancellation

56. As a developer, I want Ctrl+C on `ahp run` to cancel the current attempt cleanly, so that I can stop a run safely.
57. As a developer, I want cancellation via ACP `session/cancel` where the transport supports it, so that the agent can stop gracefully.
58. As a developer on Windows, I want headless cancellation to kill the whole process tree and record the cancel as forced, so that no orphan agent keeps working and the record is honest.
59. As a developer, I want an attempt marked `cancelled` only after termination is confirmed, so that "cancelled" is never a guess.

### Crash and recovery

60. As a developer, I want every effect preceded by a durable intent record in the ledger, so that a crash never leaves an untracked action.
61. As a developer, I want an attempt whose process state is unknown after a crash to be marked `unknown` and its step `needs_recovery`, never retried automatically, so that work is never silently run twice.
62. As a developer, I want a recovery report for each `unknown` attempt (last ledger events, worktree diff, shared-repo ref diff including remote-tracking refs, transport tool-call log if any, and a statement that host and external effects are undetermined), so that I can decide what to do.
63. As a developer, I want `ahp recover <attempt> --policy adopt` to verify the existing workspace as the result, so that I can keep good work after a crash.
64. As a developer, I want `ahp recover <attempt> --policy abort` to end the step, so that I can stop cleanly.
65. As a developer, I want `ahp recover` to refuse unless the attempt is actually awaiting recovery, so that I cannot corrupt a healthy run.
66. As a developer, I want replay never to re-dispatch an attempt that has a `dispatching` record, so that restart cannot duplicate an agent run.
67. As a developer, I want a stale ledger lock (owner process gone) to trigger a recovery report rather than a silent takeover, so that two runtimes never write one run.

### Approval and external actions

68. As a human approver, I want the run to stop at an approval gate in state `waiting_approval` and the runtime process to exit, so that nothing waits in the background.
69. As a human approver, I want `ahp inspect` to show what I am approving (verified diff, verification evidence, review findings), so that I decide with full information.
70. As a human approver, I want `ahp approve <run> <step>` to resume the run, so that the external action proceeds.
71. As a human approver, I want `ahp reject <run> <step> --reason` to send back the preceding agent step with my reason as evidence, so that my objection gets fixed rather than just ending the run.
72. As a human approver, I want my decision recorded in the ledger with who and when, so that there is an audit trail.
73. As a developer, I want AHP to push the branch or open a PR only after verification and approval, so that agents never publish unverified work.
74. As a developer, I want AHP to check the current remote state before each external action, so that a resumed run never pushes or opens a PR twice.
75. As a developer, I want PRs opened through tools under my own login, so that AHP still stores no credentials.
76. As a developer, I want a step to fail with `forbidden_external_action_detected` when AHP sees that an agent pushed or changed shared refs, so that agent publishing is caught when visible.
77. As a developer, I want reports to state that absence of that evidence is not proof, so that I do not overtrust detection.

### Inspection and reporting

78. As a developer, I want `ahp inspect <run>` to show run, step, attempt, handoff and verification state derived from the ledger, so that I see one consistent account.
79. As a developer, I want to inspect any handoff revision in full, so that I can see exactly what each coding agent received.
80. As a developer, I want each run report to list every applied capability with its enforcement level, so that I know what was enforced, cooperative or not applied.
81. As a developer, I want each attempt to show requested model and reported model (or `unknown`), so that model claims are honest.
82. As a developer, I want usage and cost shown only where the tool reports them, labelled with their source, so that numbers are never invented.
83. As a developer, I want `ahp inspect` to detect and report a corrupted ledger (broken hash chain), and to truncate a torn tail on startup, so that I can trust what replay shows.
84. As a developer, I want raw transcripts stored per attempt, so that I can audit what an agent did.

### Adapters

85. As an adapter author, I want one adapter contract that every adapter implements, so that the core has no provider-specific logic.
86. As an adapter author, I want my adapter to declare its transport, model reporting level (enumerable, pass-through, not exposed), graceful-cancel support, and capabilities with enforcement level per OS, so that the runtime can validate handoffs against them.
87. As an adapter author, I want a shared conformance suite, so that I know my adapter meets the contract.
88. As a developer, I want the Claude Code adapter to run the unmodified `claude` binary headless with my existing login, never via the Agent SDK and never adding or removing `--bare`, so that it follows Anthropic's documented allowed pattern.
89. As a developer, I want the Claude Code adapter to apply capabilities through settings, deny rules and `PreToolUse` hooks written as Node scripts, so that they work on every OS.
90. As a developer, I want the Codex adapter to use the Codex SDK or `codex exec --json` (chosen by the spike), never the experimental app-server, so that it is supported by OpenAI.
91. As a developer, I want the Gemini CLI and OpenCode adapters to use their native ACP, so that permissions, cancel and tool-call logs come from the vendor's own interface.
92. As a developer, I want no third-party ACP bridge in any release-1 adapter, so that version drift does not break me.
93. As a developer on Windows, I want adapters to launch the real executable rather than a `.cmd` shim through a shell, and pass prompts via stdin or file, so that prompt text cannot inject shell commands.
94. As a developer, I want AHP-created worktrees to enable long paths, so that deep paths do not fail on Windows.
95. As a developer, I want the docs to say that subscription use under `ahp run` falls under each vendor's terms and is my responsibility, so that I decide knowingly.
96. As a contributor, I want a mock adapter scripted per attempt (edit files, exit code, stop reason, hang, crash, attempt a push, emit usage), so that all core behaviour is testable without paid access.
97. As a developer, I want mock adapter results labelled and never counted as evidence, so that demos cannot be mistaken for results.

### Evaluation

98. As an evaluator, I want to define a suite of tasks, each with a fixture repo, a task prompt, hidden tests, planted early constraints, seeded defects for review, and protected paths, so that tasks test context loss and verification.
99. As an evaluator, I want tasks and hidden tests frozen with their hashes recorded in the ledger before any condition runs, so that I cannot tune tasks toward AHP afterwards.
100. As an evaluator, I want to run conditions C0 (single agent), C1 (naive text pipeline), C2 (AHP envelope only) and C3 (full AHP with runtime acceptance checks and bounded retry) on the same tasks, so that I can compare them.
101. As an evaluator, I want a matched-budget baseline that gives the single agent as many independent attempts as C3 used, so that I can tell structure apart from simply trying more.
102. As an evaluator, I want every condition scored by the same independent validators after the run, never by agent self-report, so that comparisons are fair.
103. As an evaluator, I want repeated runs per cell with randomized run order, so that results are not an artefact of order or luck.
104. As an evaluator, I want tool versions pinned and configs, prompts and raw transcripts stored per trial, so that any result can be traced and repeated.
105. As an evaluator, I want the network stance identical for a task across all conditions, so that network access is not a hidden variable.
106. As an evaluator, I want evaluation runs to have no approval gates and perform no external actions, so that trials never wait for a person or publish anything.
107. As an evaluator, I want an `unknown` attempt in evaluation to force `abort` and record a harness incident, excluded from condition counts and reported per condition, so that crashes do not distort results.
108. As an evaluator, I want a cell marked invalid when its harness incident rate exceeds a configured threshold, so that a flaky cell does not produce a misleading number.
109. As an evaluator, I want reports with verified success rate, constraint-violation rate, duplicated/reverted work, retries per success, wall time, and usage where reported, with paired per-task comparisons and confidence intervals, so that I can judge the hypothesis.
110. As an evaluator, I want a negative or inconclusive result reported as plainly as a positive one, so that the evaluation is honest.
111. As an evaluator, I want `ahp eval` to stop starting new trials when reported spend reaches a configured cap, so that a pilot cannot overspend.
112. As an evaluator, I want the docs to tell me to set spend limits in each provider console, since AHP can only see reported usage, so that the real limit is enforced.
113. As an evaluator, I want evaluation to expect API-key logins configured in each tool, so that scripted trials stay within vendor terms.
114. As an evaluator, I want a pilot mode sized at 5–8 tasks, 2 agent combinations, 3 repeats, so that I can measure validator determinism, variance and cost before the full suite.

### Support matrix and release

115. As a developer, I want a published support matrix of adapter × OS cells, each marked passed (with tool version and date) or untested, so that I know exactly what was tested.
116. As a maintainer, I want conformance results from my machine (Windows native, Linux via WSL2) recorded into the matrix, so that real-tool results do not require CI to hold logins.
117. As a maintainer, I want WSL2 cells labelled "Linux (WSL2)" and run with worktrees in the Linux filesystem, so that the label is honest.
118. As a maintainer, I want core CI on Windows, macOS and Linux using only the mock adapter, so that core OS support is checked for free.
119. As a maintainer, I want macOS adapter cells shown as untested, so that AHP never claims an OS it was not tested on.
120. As a maintainer, I want an A2A mapping document showing which AHP shapes map to A2A fields and which are in the AHP extension profile, so that AHP is positioned honestly against A2A.
121. As a maintainer, I want the protocol to stay at 0.x until two real adapters have run workflows and the A2A mapping is written, so that the version number reflects maturity.

## Implementation Decisions

### Modules

- **Protocol**: versioned schemas and validation rules, independent of transport. Entities: workflow, step, handoff and handoff revision, artifact reference (path + committed-content SHA-256), capability request, acceptance criteria, verification verdict and evidence, attempt, ledger event. Rejection reasons and failure classes are closed enumerations. Field names follow A2A (Task, Message, Part, Artifact, `contextId`, state names) where semantics match; AHP-specific semantics live in an A2A extension profile under a versioned URI. Where semantics differ, AHP's schema wins.
- **SDK**: workflow definition API, static workflow validation, handoff creation/validation/serialization, and the run API (start run, resume run, apply human decision, apply recovery decision, read derived state). No provider-specific code.
- **Runtime**: the state machines, scheduler (linear only), retry/reroute/send-back logic, workspace manager, snapshotter, verification runner, approval gate handling, external-action executor, recovery reporter. It exits the process whenever a run reaches `waiting_approval` or `needs_recovery`.
- **Ledger**: one append-only JSONL file per run; sequence numbers; hash chain; torn-tail truncation on startup; derived state by replay; single writer enforced by an exclusively-created lock file that records the owner PID. Appends to one open file, never write-temp-then-rename (ADR 0006).
- **Adapter contract**: an interface every adapter implements, with: a static declaration (transport kind, model reporting level, graceful cancel support, capabilities with enforcement level per OS, required login kind); start attempt (handoff rendered as input, workspace path, applied capabilities, network stance, requested model) returning a stream of normalized events (output, tool call, usage with source, reported model, stop reason, exit); cancel; and classification of an ended attempt into a failure class.
- **Adapters**: mock (scripted), Claude Code (headless unmodified binary; ADR 0001), Codex (SDK or `exec --json`, chosen by the spike), Gemini CLI (native ACP), OpenCode (native ACP). A shared process layer resolves real executables (no `.cmd` via shell), passes prompts by stdin or file, and kills process trees on Windows.
- **Evaluation engine**: suite and task loader, freezer (hashes into the ledger), condition runners for C0, C1, C2, C3 and the matched-budget baseline, independent validators, trial scheduler with randomized order, incident accounting, spend cap on reported usage, report generator (machine-readable plus human-readable).
- **CLI (`ahp`)**: `doctor`, `init`, `run`, `inspect`, `eval`, `approve`, `reject --reason`, `recover --policy adopt|abort`. Thin over the SDK. Human-action commands take the ledger lock, apply the decision, and resume the run.
- **Support matrix tooling**: records conformance-suite results (adapter, OS label, tool version, date) and renders the published matrix.
- **Docs**: A2A mapping, support matrix, terms-of-service review per tool (dated), the statement that verification runs agent code on the host, and that a worktree is not a security boundary.

### State machines (from design doc §4, as amended in §9)

- Run: `pending → running → (waiting_approval | needs_recovery) → running → succeeded | failed | cancelled`. Leaving `waiting_approval` or `needs_recovery` happens only through a human-action command.
- Step: `blocked → ready → in_progress → verifying → succeeded | failed | needs_recovery | cancelled | skipped`; approval-gate steps use `ready → waiting_approval → succeeded | failed`. A send-back returns the preceding agent step from `succeeded` to `ready` with a new handoff revision.
- Handoff revision: `issued → accepted | rejected`; `superseded` when a later revision is issued for the same handoff.
- Attempt: `created → dispatching → running → exited(ok | error | timed_out | cancelled) | unknown`. `dispatching` is durable before spawn; `exited` requires observed process termination; an ACP stop reason is recorded as outcome detail; `cancelled` requires termination confirmed and records whether it was graceful or forced.
- Verification: `pending → pass | fail | inconclusive`, with evidence items: test output, diff-scope check, protected-path check, required output fields, planted-constraint checks, `forbidden_external_action_detected`.
- Idempotency key: (handoff ID, revision, attempt ID).

### Ledger events (intent before effect)

Run created; step ready; handoff revision issued/accepted/rejected/superseded; attempt created; attempt dispatching (before spawn); attempt running; attempt exited / unknown; workspace snapshot committed; ref snapshot before/after; verification started / verdict; approval requested / decided (who, when, reason); external action intended / checked / performed; recovery report written; recovery decided; run terminal; for evaluation: task frozen, trial started/ended, harness incident, spend observed.

### Retry and failure defaults

- `rejected`: no retry. `config/auth`: no retry, surfaced. `transient`: separate budget 5, exponential backoff, capped total wait. `agent_error` and `verification_failed`: shared budget of 2 retries per step. `inconclusive`: re-run validator once, then escalate. `unknown`: never retried; step → `needs_recovery`.
- Budget exhausted → reroute if configured (off by default) → step fails.
- Send-back (review "changes requested" or approval reject) spends the preceding agent step's `verification_failed` budget.

### Workspaces and side effects

- Per-attempt git worktree in an AHP-managed location, `core.longpaths` enabled. Ref snapshot of the shared repo (including remote-tracking refs) before and after each attempt.
- Verification worktree built from AHP's snapshot commit of the attempt workspace; hidden tests copied in; ignored files are not carried over; dependencies installed fresh.
- External actions (push, PR, merge) only by the executor, after a passed verification and an approved gate, with a state check first. No deploy.
- Network stance and capabilities are applied by the adapter at whatever enforcement level it achieves on the current OS; the level is recorded per attempt.

### Evaluation conditions

- **C0**: one coding agent performs the whole task in one step; scored by the validators.
- **C1**: the same agents as the pipeline, passing plain text output to the next agent; no handoff envelope, no runtime acceptance checks, no retry.
- **C2**: AHP handoffs validated between steps; no runtime acceptance checks between steps and no retry.
- **C3**: full AHP: handoffs, runtime verification at each step, bounded retry and send-back.
- **Matched-budget baseline**: C0 repeated as many independent times as C3 used attempts for that task; success if any passes.
- All conditions are scored by the same independent validators at the end of each trial; budgets are set per suite and reported.

## Testing Decisions

- **Good tests** exercise external behaviour only: what a caller of the SDK run API or the `ahp` CLI can observe (ledger contents and derived state, verdicts and evidence, reports, files and git refs left behind, exit codes, CLI output). They never assert on internal function calls or module structure, so modules can be refactored freely.
- **Seam 1: SDK run API with the scripted mock adapter** (primary). Tests build a workflow with the SDK, run it against a real temporary git repo, and assert on ledger-derived state, verification evidence, reports and resulting refs/worktrees. This seam covers handoff validation and rejection reasons, all state machines, retries and budgets, handoff revisions, send-back, approval gates, external actions (against a local bare remote), protected paths and hidden tests, enforcement-level reporting, artifact hashing across line-ending settings, ledger hash chain and torn-tail handling, and evaluation conditions, incidents and spend cap with mock trials. Crash and recovery tests run the runtime as a child process, kill it at chosen points (before spawn, mid-attempt, mid-external-action), then assert on the recovery report and on `approve`/`reject`/`recover` behaviour. A small number of CLI tests run `ahp` as a child process for argument handling and output.
- **Seam 2: adapter conformance suite**. One suite every adapter must pass: spawn and normalized events, graceful and forced cancel (including Windows process-tree kill), failure classification, requested vs reported model, usage source labelling, and that each declared capability holds at its declared enforcement level. It runs against the mock adapter in CI and against real adapters on the maintainer's machine (Windows native, Linux via WSL2); its results feed the support matrix. Real-adapter runs are never part of CI and never count as evaluation evidence.
- **CI**: Seam 1 tests and the mock conformance run on Windows, macOS and Linux runners; no credentials in CI.
- **Prior art**: none; the repo is pre-implementation. These suites become the prior art.

## Out of Scope

- Web platform, visual workflow editor, approvals inbox UI.
- Hosting, serving or downloading models; inference-engine benchmarking (Ollama, vLLM, SGLang, TensorRT-LLM); direct model-provider connections; LLM-as-judge validators.
- Reflection/simulation engine; context compaction.
- Parallel steps and any backward edge other than send-back to the immediately preceding agent step.
- The `discard_and_retry` recovery policy.
- Deploy as an external action.
- Containers, VMs or network denial at OS level; any claim that a worktree is a sandbox.
- Third-party ACP bridges; Codex app-server; the Claude Agent SDK; Antigravity CLI.
- An A2A wire binding or any peer transport.
- Tested macOS adapter cells (until a Mac is available).
- Storing any provider credential.

## Further Notes

- Rollout order for tickets follows design doc §8: (1) protocol, SDK, runtime, ledger, mock adapter; (2) transport spike on native Windows; (3) Claude Code and Codex adapters plus the A2A mapping; (4) Gemini CLI and OpenCode; (5) evaluation pilot; (6) support matrix. Steps 1–4 must not require paid API access; Gemini CLI needs paid access and is built last.
- Open until rollout step 5: pilot budget and which keys/subscriptions are available.
- Settled during ticketing (2026-10-24): a single package with internal module boundaries; Vitest as the test runner; PRs opened with the GitHub CLI under the user's own login. Tickets are in `issues/`.
- Research facts from 2026-10-24 (vendor terms, Gemini CLI paid-only, `node:sqlite` stability) may change; the dated terms-of-service review in `docs/` is the place to re-check them before the pilot.
