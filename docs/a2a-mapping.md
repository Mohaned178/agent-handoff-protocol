# A2A mapping

Which AHP shapes map to A2A, and which belong to an AHP extension profile. Written against **A2A v1.0.0, checked 2026-10-28** (the specification page and `a2a.proto`, package `lf.a2a.v1`) and **AHP protocol 0.1.0**. Ticket 17.

**This is a mapping, not an implementation.** No code emits A2A JSON, there is no AgentCard, no `A2A-Extensions` header, no wire binding and no peer transport (see the last section). Every JSON example here is *illustrative, not produced by code*. The ledger is the source of truth; an A2A shape is a view derived from it by replay. Where semantics differ, AHP's own schema wins over A2A's field names (design doc §9.2).

Words kept apart: a **Step** is AHP's unit of work and the nearest A2A **Task** (GLOSSARY reserves "Task" for the A2A shape); `contextId` identifies the **run**; the handoff's `context.fields` (the previous step's required output fields) is *not* `contextId`.

## 1. Who says what

A handoff is issued by the **runtime**, to the recipient step's coding agent. The sender step's attempt sends nothing: it appears only as `from` (step and attempt) and as the snapshot the handoff's `base.commit` names. Read northbound, the runtime is the A2A server, and each handoff revision is a `Message` with `role: ROLE_USER` in the step's Task history (the requester speaking to the step's agent). The coding agent itself never speaks A2A: adapters drive it through ACP, an SDK or a headless CLI (ADR 0001). That choice of role is this document's, not a recorded decision of the protocol.

## 2. Shapes that map

| AHP | A2A v1.0.0 | Fit |
|---|---|---|
| Run (`runId`, `run_…`) | `contextId` (on Task, Message, events) | **Matches.** Already used: `HandoffRevision.contextId`. A run has no lifecycle in A2A, so run state has no counterpart. |
| Step | `Task` (`id`, `contextId`, `status`, `artifacts`, `history`, `metadata`) | **Partial**, see §4: AHP authors the step id, A2A's `taskId` is server-generated; a sent-back step reopens, a terminal Task cannot. |
| Attempt | none | **No counterpart.** A2A has no retry or attempt model; attempts are internal to a Task and live in the extension (§5). |
| Handoff revision | `Message` (`messageId`, `contextId`, `taskId`, `role`, `parts`, `metadata`, `extensions`) | **Partial.** A revision is immutable, numbered and supersedes the one before; `Message` has no revision. A proposed `messageId` is `<handoffId>:<revision>`. |
| `contract.instructions` | `Part` with `text` | **Matches.** |
| `context.fields` (decisions, constraints, summary; text or list of text) | `Part` with `data` and `mediaType: application/json` | **Matches.** One Part holds exactly one of `text`, `raw`, `url`, `data`; no `kind` discriminator in v1.0.0. |
| Required output fields of a passing attempt | `Artifact` with one `data` Part | **Matches.** A2A puts outputs in artifacts, not messages. |
| `artifacts[]` (`path`, `sha256`, read from `base.commit`) | `Artifact` (`artifactId`, `name`, `parts`, `metadata`, `extensions`) | **Partial.** A file passed *by reference to a git commit* has no A2A form: `raw` would copy bytes and `url` needs a locator AHP does not define for a path in a commit. Proposed: `artifactId` and `Part.filename` are the repo path (unique within a handoff, validated), one `data` Part names the path and base commit, and the hash is extension data (§5). |
| Handoff rejected before any agent runs | `TASK_STATE_REJECTED` | **Matches.** Reasons (§5) are extension data. |
| Cancel | `CancelTask` → `TASK_STATE_CANCELED` | **Matches.** A2A cancel is a request that may not succeed; AHP records `cancelled` only after the agent's tree is confirmed gone. |

An approval gate or an external-action step has no handoff and no attempt. As a Task it only goes `SUBMITTED → INPUT_REQUIRED → COMPLETED` (gate) or `SUBMITTED → WORKING → COMPLETED | FAILED` (external action).

### Step states

Mapped from the code's `StepState` (`src/protocol/index.ts`), which has ten values.

| AHP step state | A2A `TaskState` | Fit |
|---|---|---|
| `blocked` | none (no Task exists yet) | **No counterpart.** A Task would be created when the step's handoff is issued. |
| `ready` | `TASK_STATE_SUBMITTED` | Lossy: also covers a retry or send-back waiting for its next attempt. |
| `in_progress` | `TASK_STATE_WORKING` | **Matches.** |
| `verifying` | `TASK_STATE_WORKING` | **Lossy.** A2A has no verification phase. The Task must not read `COMPLETED` until verification passes; an agent finishing is not that. |
| `waiting_approval` | `TASK_STATE_INPUT_REQUIRED` | **Lossy.** The approval is bound to a commit and is approve or reject only; a free-form reply (what A2A allows) means nothing to AHP. |
| `succeeded` | `TASK_STATE_COMPLETED` | **Matches, stricter**: reached only by a passing verification. |
| `failed` | `TASK_STATE_FAILED`; `TASK_STATE_REJECTED` when the failure class is `rejected` | Matches. The failure class is extension data. `config_auth` is `FAILED`, not `TASK_STATE_AUTH_REQUIRED`: that state is interrupted and resumable, and AHP's step ends. |
| `needs_recovery` | none that keeps its meaning | **No counterpart.** The nearest, `INPUT_REQUIRED`, would invite a free-form reply where AHP wants `adopt` or `abort`. Not recommended without the extension. |
| `cancelled` | `TASK_STATE_CANCELED` | Matches (spelling differs, §4). |
| `skipped` | none | Declared in `StepState`, never entered in release 1 (linear workflows). |

Not mapped at all: run states (`RunState`), attempt states (`AttemptState`, `AttemptOutcome`), verification states (`VerificationState`), and handoff states other than `rejected` (`issued`, `accepted`, `superseded`). A2A has no shape for them; they are extension data or ledger only.

## 3. Illustrative example

*Illustrative, not produced by code.* A first handoff revision as the Message a northbound client would read in a step's history (field names are A2A v1.0.0 JSON; the extension payload uses AHP's own names):

```json
{
  "messageId": "hnd_7k2m:1",
  "contextId": "run_4f9c",
  "role": "ROLE_USER",
  "parts": [
    { "text": "Implement the password-reset endpoint." },
    { "data": { "decisions": ["use the existing mailer"] }, "mediaType": "application/json" }
  ],
  "extensions": ["https://github.com/Mohaned178/agent-handoff-protocol/extensions/ahp/0.1"],
  "metadata": {
    "https://github.com/Mohaned178/agent-handoff-protocol/extensions/ahp/0.1": {
      "handoff": { "handoffId": "hnd_7k2m", "revision": 1, "supersedes": null, "from": { "stepId": "plan", "attemptId": "att_1" } },
      "contract": { "acceptance": { "verificationCommand": "npm test", "requiredOutputFields": ["summary"] } },
      "capabilities": [{ "kind": "no_external_actions", "require": "none" }],
      "network": { "stance": "deny", "require": "none" }
    }
  }
}
```

## 4. Where AHP deliberately differs, and why

Only reasons the repository records are given; where none is recorded, that is said.

- **Success is a passing verification, never a declared `COMPLETED`.** `succeeded` is reached only when verification passes (design doc §4, GLOSSARY *Verification*); an agent's self-report is a claim. A client must therefore not treat anything but the Task's final state as the result.
- **Step ids are authored; `taskId` is server-generated.** A2A does not support a client-provided `taskId` (§3.4.2). AHP workflows name their steps (they appear in paths and git ref names). A view would carry the Task id it generates and the AHP `stepId` in extension data. No recorded decision beyond AHP's schema winning (§9.2).
- **A send-back reopens a succeeded step; a terminal Task cannot be reopened.** A review or a rejected approval returns the step before it from `succeeded` to `ready` (ADR 0004). In A2A a terminal Task takes no further message; follow-up work is a new Task in the same `contextId` with `referenceTaskIds` (§3.4.3). A view must therefore show the new round as a new Task referencing the earlier one. Recommended; not previously decided.
- **A retry is a new attempt in a new workspace, inside one Task.** A2A has no attempt; the Task stays non-terminal across retries and attempts are extension data.
- **An artifact is a path and the SHA-256 of its committed content** (ADR 0005), never working-tree bytes. A2A artifacts carry parts, not a content hash.
- **State names are lowercase snake_case, not `TASK_STATE_*`.** AHP's own schema wins where semantics differ (§9.2).
- **`cancelled`, not `CANCELED`.** The repository records no rationale for this spelling; it is a choice of the AHP schema. Flagged, not defended.
- **Ids are prefixed** (`run_…`, `hnd_…`, `att_…`) and a handoff revision is immutable; A2A requires neither.
- **A handoff carries required capabilities and a network stance, and a retry carries evidence.** A2A has no field for either; both are extension data (§5).

## 5. The AHP extension profile

A2A extensions are identified by a URI (`AgentExtension.uri`), declared in the AgentCard's `capabilities.extensions`, requested by a client (the `A2A-Extensions` header or a Message's `extensions` list), and carry their data in the `metadata` of a Message, Task or Artifact keyed by that URI. An extension should put its version in the URI and mint a new URI for a breaking change; an agent must not silently fall back to an earlier version.

**URI (proposed, decision 2 in the ticket): `https://github.com/Mohaned178/agent-handoff-protocol/extensions/ahp/0.1`.** It is an identifier under the repository the maintainer controls; it need not resolve. The version tracks the protocol's major.minor (`PROTOCOL_VERSION` is `0.1.0`); while the protocol is 0.x, a breaking change to the profile mints `…/0.2`.

**`required`.** The flag is per extension, not per field, so the profile is all-or-nothing. Recommended: `required: true`. A peer that dropped acceptance criteria or capability requests would change what a handoff means, and for an extension marked required that a client does not declare, A2A has the agent return an error (`ExtensionSupportRequiredError`) rather than carry on without it.

| AHP-only semantics | Where it sits | Shape and source |
|---|---|---|
| **Handoff identity and supersession** | `Message.metadata[uri].handoff` | `handoffId`, `revision`, `supersedes`, `from`, `to` (`stepId`, `adapter`, `requestedModel`), `base.commit`: `HandoffRevisionSchema`. |
| **Acceptance criteria** | `Message.metadata[uri].contract.acceptance` | `verificationCommand`, `requiredOutputFields`; also `requires` (fields and artifacts the recipient cannot start without). |
| **Artifact integrity** | `Artifact.metadata[uri]` (and `Message.metadata[uri].artifacts`) | `path`, `sha256` of committed content at `base.commit`. |
| **Capability requests and enforcement levels** | `Message.metadata[uri].capabilities`, `.network`; applied levels in `Task.metadata[uri].applied` | A request has a `kind` (`read_only`, `write_scope`, `no_external_actions`), `require` and, for `write_scope`, `paths`. Applied: the level the adapter's declaration reaches on the run's OS, recorded before the agent starts (`AppliedCapabilities`). |
| **Rejection reasons** | `Task.metadata[uri].rejection` | `schema_invalid`, `artifact_hash_mismatch`, `unmet_dependency`, `capability_unsatisfiable`, each with an RFC 6901 `pointer`. |
| **Retry evidence** | `Message.metadata[uri].evidence` | The trimmed handoff shape, below. |
| **Verification verdict and evidence** | `Task.metadata[uri].verification` | `verdict` (`pass`, `fail`, `inconclusive`) and the ledger's `EvidenceItem` list, below. |
| **Failure class** | `Task.metadata[uri].failureClass` | `rejected`, `config_auth`, `transient`, `agent_error`, `verification_failed`, `inconclusive`, `unknown`, `external_action_failed`. |
| **Attempts and recovery** | `Task.metadata[uri].attempts` | Per attempt: id, handoff and revision (the idempotency key), outcome (`ok`, `error`, `timed_out`, `cancelled`), `unknown` reasons (`no_terminal_record`, `lost_contact`, `unconfirmed_kill`), recovery policy (`manual`, `adopt`, `abort`) and who decided. |
| **Approval** | `Task.metadata[uri].approval` | The verified attempt, snapshot commit and changed paths the decision is bound to; the decision (`approved`, `rejected`), its reason, and the user. |
| **External actions** | `Task.metadata[uri].externalAction` | `push_branch`, `open_pr`, `merge_pr`: intent, check, outcome. AHP alone performs them (ADR 0003). Not on the ticket's list, present in the code. |
| **Provenance** | grouping, see below | Not a schema. |

**Two evidence shapes, not one.** The ledger's `EvidenceItem` (what verification recorded) has `test_output`, `required_output_fields`, `diff_scope`, `review_verdict`, `protected_paths`, `forbidden_external_action_detected` and `validator_error`. The handoff's `evidence` (what a retry tells the agent) is a trimmed shape, `HandoffEvidenceSchema`: `test_output`, `required_output_fields`, `review_verdict`, `protected_paths`, `forbidden_external_action_detected`, plus `review_findings` and `approval_rejected`; it leaves out `diff_scope` and `validator_error`, withholds the output of hidden tests (`output: null`) and never lists the protected paths. A client that reads evidence from a Message must not assume it is the Task's verification evidence.

**Provenance has no field of that name.** It is a grouping of what is already recorded: who handed what to whom (`from`, `to.adapter`), the model requested and the model reported (`unknown` when the tool did not say, never filled in from the request), usage with the `source` the tool gave (null where not reported, never estimated), the snapshot commit of an attempt, the hash chain over the ledger (`prevHash`, `hash`) and the approver's user name. A mock adapter's values are flagged (`mock`) and are never evidence.

**What has a published schema.** `schemas/` publishes only `handoff-revision` and `rejection-reason`. Attempts, verdicts, evidence, recovery and approvals are TypeScript types in `src/protocol/index.ts` and ledger events; the extension payloads above have no published schema yet.

**Enforcement levels are not copied here.** They are per adapter and per OS and go stale. See each adapter's declaration and the support matrix. Only `enforced_by_tool` is enforcement; `cooperative` (prompt instructions, ACP permission requests) is not.

## 6. What release 1 does not have

- **No wire binding and no peer transport.** AHP does not speak A2A over HTTP, gRPC or JSON-RPC, serves no AgentCard, sends or reads no `A2A-Extensions` header, and no code emits A2A JSON.
- **The protocol stays 0.x** (`PROTOCOL_VERSION` is `0.1.0`). This document is the mapping that the version rule waits on; it does not say the other conditions (two real adapters having run workflows) are met, and the version is not changed here.
- Exposing workflows northbound over A2A is later work (design doc §3).
