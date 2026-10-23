# AHP v2 direction (pre-implementation)

Status: agreed direction, 2026-10-24. Not frozen. Inputs to the grilling → spec → ticket → implement flow.
This supersedes the scope of `AHP-presentation.pdf` where they differ (see "Changes from the deck").

Items marked **(verify)** are believed but not confirmed against a primary source.

## 1. Product

AHP (Agent Handoff Protocol and LLM Evaluation) makes handoffs between AI coding agents explicit, verifiable and measurable, and provides a reproducible evaluation system that tests whether doing so improves real task outcomes.

**Core hypothesis:** on a fixed coding task set, structured validated handoffs with runtime-checked acceptance criteria produce a higher verified success rate and less context loss/rework than (a) a single agent and (b) a plain-text pipeline of the same agents, at acceptable time/cost overhead. A negative result is a legitimate outcome.

### Components

| Component | Is | Is not |
|---|---|---|
| Protocol | Versioned spec: entities, envelope schema, lifecycle states, validation/rejection rules | A transport, an agent framework, or a security boundary |
| SDK (TypeScript, Node.js) | Create/validate/serialize/process handoffs, define workflows | Provider-specific in any way |
| Adapters | One per tool: invocation, input rendering, output parsing, error classification, capability declaration | A promise that an arbitrary CLI works |
| Runtime | State machine, scheduling, retries, workspaces, verification, approval gates | In control of what an agent does inside its run |
| Ledger | Durable append-only event record; state is derived by replay | An exactly-once guarantee for external side effects |
| Evaluation engine | Suites, conditions, repeated runs, independent validators, reports | An inference-speed benchmark; never trusts agent self-reports |
| CLI (`ahp`) | doctor, init, run, inspect, eval | A web platform (later) |

### Release 1 targets
Claude Code, OpenAI Codex CLI, Gemini CLI, OpenCode, combinable in one workflow (e.g. Claude Code plans → Codex implements → OpenCode reviews → tests verify). Users connect only the tools they have. AHP never stores credentials. OS targets: Windows, macOS, Linux, with a published support matrix that separates core OS support from adapter × OS cells actually tested.

### Out of scope for release 1
Web platform, visual editor, hosting/serving/downloading models, Ollama/vLLM/SGLang/TensorRT-LLM benchmarking, reflection/simulation engine, direct model-provider connections.

### Changes from the deck
- Evaluation targets end-to-end coding-agent workflows, not inference engines.
- Agents are external coding CLIs, not model backends behind an inference adapter.
- "Recipient accepts or rejects" becomes: the **runtime** validates on the recipient's behalf using adapter capabilities.
- Per-tool-call policy enforcement is not generally possible; see enforcement levels (§4).
- Resolved open decisions: SDK language = TypeScript; AHP does not serve models; editor depth and reflection/simulation postponed.

## 2. Coding-agent adapters vs model-provider connections

| | Coding-agent adapter (release 1) | Model-provider connection (out of scope) |
|---|---|---|
| Talks to | A full agent with its own model, tools and loop | A model API or local engine |
| Auth | The tool's own login, subscriptions included | API keys |
| AHP controls | Input, workspace, flags, process lifetime, verification | Every model call |

**Model reporting** — each adapter declares one level; AHP never claims to discover subscription entitlements:
1. Enumerable: the integration lists selectable models (e.g. ACP session config option of category `model`, where provided).
2. Pass-through: the tool accepts a model name (believed for all four; **verify** flags). Passed unvalidated.
3. Not exposed.

The ledger records `requested_model` and `reported_model`; the latter is `unknown` when the tool does not report it.

Direct provider connections stay out unless an LLM-as-judge validator becomes necessary. Current evaluation relies on tests and deterministic checks.

## 3. Relationship to A2A and ACP

Findings (2026-10-24):
- **ACP (Agent Client Protocol):** client↔coding-agent, JSON-RPC over stdio. `session/prompt`, streamed `session/update` (plan, tool_call, tool_call_update, usage_update), `session/cancel`; stop reasons `end_turn | max_tokens | max_turn_requests | refusal | cancelled`; `session/request_permission` (agent MAY ask; options allow_once/allow_always/reject_once/reject_always); tool kinds read/edit/delete/move/search/execute/think/fetch/switch_mode/other; session config options with categories mode/model/model_config/thought_level. Listed agents include Codex (via `codex-acp` adapter), "Claude Agent" (via Zed's `claude-agent-acp`; whether it uses a Claude Code subscription: **verify**), Gemini CLI and OpenCode (native vs adapter: **verify**).
- **A2A v1.0.0:** networked peer agent protocol. Task, Message, Part, Artifact, AgentCard; states submitted/working/input_required/auth_required/completed/failed/canceled/rejected; `contextId`; `messageId` dedupe; versioned extension URIs with a `required` flag and no silent fallback. **No** artifact hashes, acceptance criteria, verification evidence, fine-grained capability scopes, or attempt/recovery model.

Positioning:
```
[A2A]  later  ← northbound: expose AHP workflows/handoffs to other systems
   AHP: handoff semantics, verification, attempts, ledger, evaluation
[ACP]  now    → southbound: one possible transport for driving coding agents
```

| Concern | Decision |
|---|---|
| Driving agents | Reuse ACP where reliable; fall back to native headless mode (`-p` / `exec` / `run`). Chosen per adapter after a spike. |
| Tool-call permission | Reuse ACP `request_permission` as a **cooperative** hook, never described as enforced. |
| Task/Artifact/Part shapes, state names, context grouping | Map to A2A field names/semantics where they match. |
| Acceptance criteria, verification evidence/verdict, artifact integrity, capability requests + enforcement level, attempts/recovery, provenance | AHP-specific, defined as an A2A extension profile (versioned URI) plus the ledger. No new wire protocol. |
| Peer transport | None in release 1. |

The protocol stays 0.x until two real adapters have run workflows through it and the A2A mapping is written.

## 4. State model (four separate concerns)

### 4a. Run and step state
- Run: `pending → running → {waiting_approval | needs_recovery} → succeeded | failed | cancelled`
- Step: `blocked → ready → in_progress → verifying → succeeded | failed | needs_recovery | cancelled | skipped`
- A step succeeds only when verification passes.

### 4b. Handoff validation
Immutable envelope: `issued → accepted | rejected`; `superseded` when a retry issues a new revision. Rejection reasons (machine-readable): schema invalid, artifact hash mismatch, unmet dependency, capability unsatisfiable at the required enforcement level on this OS.

### 4c. Attempt state
`created → dispatching → running → exited(ok | error | timed_out | cancelled) | unknown`
- `dispatching` is durably written before spawn.
- `exited` requires observed termination (exit code or ACP stop reason).
- `cancelled` requires cancel sent (ACP `session/cancel`, or graceful signal → grace period → process-tree kill) and termination confirmed.
- `unknown`: no terminal record after restart, unconfirmed kill, or lost contact.

### 4d. Verification
`pending → pass | fail | inconclusive`, with evidence (test output, diff-scope check, required output fields, planted-constraint checks). `inconclusive` = the validator broke; never treated as pass or fail.

### Failure classes and retry
| Class | Example | Default |
|---|---|---|
| rejected | validation failed | No retry |
| config / auth | not logged in, bad flag | No retry; surface to user |
| transient | rate limit, quota, provider network | Backoff retry; separate quota budget |
| agent_error | non-zero exit, refusal, max_turn_requests | Retry within budget |
| verification_failed | hidden tests fail | Retry with evidence attached, within budget |
| inconclusive | validator crashed | Re-run validator or escalate |
| unknown | crash mid-attempt | **Never auto-retried**; step → `needs_recovery` |

Budget exhausted → reroute to an alternative adapter with the same contract (if configured) → human escalation. Every retry is a new attempt ID in a new workspace. (handoff ID, attempt ID) is the idempotency key; replay never re-dispatches an attempt that has a `dispatching` record.

**Recovery policy for `unknown`** (per step, default `manual`): `manual` | `adopt` (verify existing workspace as the result) | `discard_and_retry` (only if step is `workspace_only` and the policy is explicitly enabled) | `abort`.

## 5. Workspace isolation and side effects

A git worktree is workspace isolation, **not a security boundary**.

| Class | Examples | AHP can see | AHP can undo |
|---|---|---|---|
| Workspace | files in the attempt worktree | yes | yes (discard) |
| Shared repo | refs, other branches, hooks, `.git/config`, stash (worktrees share `.git`) | partly (ref snapshot before/after) | sometimes |
| Host | files outside the worktree, global installs, caches | no | no |
| External | push, PRs, network/API calls, publishing | no | no |

Rules:
1. AHP itself performs gated external actions (push, PR, merge) after verification and approval, idempotently (check state first). Agents are instructed and, where possible, configured not to.
2. Each applied capability carries an enforcement level: `enforced_by_tool` | `cooperative` | `none`, shown in run reports.
3. Each step declares a side-effect class, `workspace_only` or `may_have_external_effects` (user intent, not verified by AHP).
4. After a crash, each `unknown` attempt gets a recovery report: last ledger events, worktree diff, shared-repo ref diff, ACP tool-call log if any, and an explicit statement that host/external effects are undetermined. Nothing proceeds without the recovery policy.
5. Containers/VMs/network denial: optional, after release 1. Docs never call a worktree a sandbox.

## 6. Ledger
Append-only, event-sourced; run/step/attempt state derived by replay. Intent before effect. Single writer per run (lock file), sequence numbers, hash chain, torn-tail detection and truncation on startup. Storage (hardened JSONL vs SQLite) is open.

## 7. Evaluation
- Conditions: **C0** single agent; **C1** naive text pipeline; **C2** AHP envelope only; **C3** full AHP (envelope + runtime acceptance checks + bounded retry). C2 vs C3 separates the envelope's effect from retry-on-failure.
- Tasks carry hidden tests, planted early constraints (context-loss checks) and, for review, seeded defects.
- Metrics: verified success rate, constraint-violation rate, duplicated/reverted work, retries per success, wall time, usage only where reported (labelled with source, not compared across mismatched units).
- Rigor: repeated runs, paired per-task comparisons with confidence intervals, pinned tool versions, stored configs/prompts/raw transcripts, randomized run order.
- **Pilot first:** 5–8 tasks, 2 agent combinations, 3 repeats per cell. Goals: validator determinism, test discrimination, variance, quota cost per cell, harness bugs. It does not test the hypothesis; the full suite is sized from its numbers.
- Mock adapter results are labelled and never count as evidence.

## 8. Incremental rollout (all four ship in release 1)
1. Protocol 0.x, SDK, runtime, ledger, mock adapter.
2. Transport spike: each tool via ACP and via native headless on one OS (cancellation, permission requests, model and usage reporting, output stability).
3. Claude Code and Codex adapters; A2A mapping document.
4. Gemini CLI and OpenCode adapters.
5. Evaluation pilot.
6. Support matrix. Public release requires all four adapters passing their integration suite on at least one OS each; other cells labelled untested.

## 9. Decisions to settle before implementation

Grilling sessions of 2026-10-24 settled most of these. Where this section conflicts with §1–§8, this section and `docs/adr/` win; terms are defined in `GLOSSARY.md`.

1. **Adapter transport — settled (ADR 0001).** Vendor-maintained interface (native ACP, vendor SDK, or vendor app-server protocol) where one exists, else headless; the spike picks per tool, on native Windows first. No third-party ACP bridges in release 1. One attempt = one fresh process; an ACP stop reason is outcome detail, not proof of exit. Known constraints: Claude Code via the unmodified `claude` binary headless, never the Agent SDK; Codex via SDK or `exec`, not app-server; Gemini CLI kept but needs paid access, built last.
2. **A2A alignment depth — settled.** Align the data model and define the extension profile now, via the §8 step 3 mapping document; wire binding later. Where semantics differ, AHP's own schema wins over A2A field names.
3. **Recovery for `unknown` — settled.** Policies `manual` (default), `adopt`, `abort`. `discard_and_retry` is deferred: its only safety check (shared-repo ref diff) cannot see pushes made outside the local remote. In `ahp eval`, `unknown` forces `abort` and the trial is a harness incident, reported per condition; a cell whose incident rate exceeds a threshold set from the pilot is invalid.
4. **External actions and network stance — settled (ADR 0003).** Only AHP performs push/PR/merge; no deploy in release 1; `forbidden_external_action_detected` evidence, with detection labelled partial. Network stance covers the agent's tool use only, default `deny`, implement may opt in to package registries, identical across C0–C3.
5. **Ledger storage and minimum Node version — settled (ADR 0006).** Hardened JSONL, Node ≥ 24. Artifact hashes are over committed content (ADR 0005).
6. **Verification location and trust — settled (ADR 0002).** Host, fresh verification worktree from an AHP-made snapshot commit; hidden tests introduced at verification time; protected paths; verification command from the workflow. Verification is the runtime's phase inside every step, not a "Tester" agent; review steps outside evaluation get structural verification only, labelled as such.
7. **Workflow shapes — settled (ADR 0004).** Linear, with retry, reroute, approval gates and send-back to the immediately preceding agent step. No parallel steps.
8. **Retry defaults — settled.** `agent_error` + `verification_failed` share 2 retries per step; `transient` has a separate budget of 5 with exponential backoff and a capped total wait; reroute off by default. Same-input retries are new attempts under the same handoff revision; changed-input retries (evidence, send-back, reroute) issue a new handoff revision. Idempotency key = (handoff ID, revision, attempt ID). Evaluation suites set budgets explicitly and include a matched-budget baseline for C0.
9. **Pilot inputs — partly settled.** Tasks are authored in small purpose-built repos, with hidden tests, planted constraints and seeded defects, frozen (hashes in the ledger) before any condition runs. `ahp eval` and the pilot use API keys for every tool, configured through each tool (AHP stores none); subscription logins are for a user's own `ahp run` only, with docs stating that subscription use falls under each vendor's terms. Each tool's terms are reviewed and recorded with a date in `docs/` before the pilot. Spend is capped by provider-console limits plus an `ahp eval` cap on reported spend that stops new trials. *Open until rollout step 5: pilot budget and which subscriptions/keys are available.*
10. **Public-release support bar — settled.** Core CI (mock adapter) on Windows, macOS, Linux. Adapter integration suites run on the maintainer's machine: Windows native, and Linux via WSL2 (labelled "Linux (WSL2)", worktrees in the Linux filesystem, separate tool logins). macOS adapter cells are untested until a Mac is available. Every adapter passes on at least one OS; results recorded in the support matrix with OS, tool version and date.

Also settled: **license** Apache-2.0.

Also settled:
- **Approval gates:** a step kind with no agent, step state `waiting_approval`; humans approve or reject only (no edit); a reject is a send-back. Evaluation runs have no approval gates.
- **Human-action CLI:** `ahp approve`, `ahp reject --reason`, `ahp recover --policy adopt|abort`. The run process exits at `waiting_approval` or `needs_recovery`; these commands take the ledger lock and resume it.
- **Context compaction** (deck slide 10) is dropped from release 1; handoff context is the sending step's required output fields.
- **Reference scenario:** plan (Claude Code) → implement (Codex; hidden tests) → review (OpenCode; send-back on changes requested) → approval gate → AHP pushes or opens a PR.

## Sources
- A2A specification: https://a2a-protocol.org/latest/specification/
- ACP introduction: https://agentclientprotocol.com/overview/introduction
- ACP agents: https://agentclientprotocol.com/overview/agents
- ACP prompt turn: https://agentclientprotocol.com/protocol/prompt-turn
- ACP tool calls: https://agentclientprotocol.com/protocol/tool-calls
- ACP session config options: https://agentclientprotocol.com/protocol/session-config-options
