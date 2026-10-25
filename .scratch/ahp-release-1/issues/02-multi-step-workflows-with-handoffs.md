# 02: Multi-step linear workflows with handoffs

**What to build:** A developer defines a linear workflow of several steps; the runtime issues an immutable, versioned handoff to each step, validates it on the recipient's behalf, and passes the previous step's required output fields (decisions, constraints, summary) as context and its artifacts by reference. Invalid handoffs are rejected with machine-readable reasons, and invalid workflows are rejected before running.

**Blocked by:** 01

**Status:** implemented; awaiting first CI run (Windows verified locally; macOS and Linux not yet)

**Model:** Sonnet 5.5 · xhigh

- [x] Protocol schema for handoff and handoff revision, versioned; A2A field names used where semantics match
- [x] Handoff states `issued → accepted | rejected`
- [x] Rejection reasons are a closed enumeration: schema invalid, artifact hash mismatch, unmet dependency (capability unsatisfiable arrives in 11)
- [x] Steps declare required output fields; missing fields fail verification with evidence
- [x] Required output fields of step N appear as context in the handoff to step N+1
- [x] Artifact references carry SHA-256 over committed content (ADR 0005); a test proves the same artifact hashes identically with CRLF and LF checkouts
- [x] AHP-created worktrees enable `core.longpaths`
- [x] Static workflow validation rejects parallel steps and unknown adapters with clear messages
- [x] `ahp inspect` shows every handoff revision in full

## Implementer notes

- Define protocol schemas with Zod and export JSON Schema from them; the exported JSON Schema is the published protocol artifact. Every schema carries a `schemaVersion` starting at `0.1.0`.
- A handoff revision is immutable once written: a change is always a new revision with a pointer to the one it supersedes.
- Artifact hash = SHA-256 over the blob content as stored in git (read it from the commit, not from the working tree). Test it in a temporary repo with `core.autocrlf=true` and again with `false`; the hash must be identical.
- Keep rejection reasons and failure classes as closed string unions shared by schema and code; a new reason is a protocol change.
- Stop and ask the user if a schema decision would contradict `GLOSSARY.md` or an ADR.

## Comments

2026-10-25, implementation notes. The ticket left several shapes open; these are the choices made, so ticket 04 and later can build on them or reopen them.

- **Handoff shape** (`src/protocol/handoff.ts`, published as `schemas/handoff-revision.schema.json`): `schemaVersion`, `handoffId`, `revision`, `supersedes`, `contextId` (the run), `from` (sender step and attempt, null for step 1), `to` (step, adapter, requested model), `base.commit`, `contract` (instructions, acceptance criteria), `context.fields`, `artifacts`, `requires`. The only A2A names used are `contextId` and the `rejected` state; everything else is AHP's own, and ticket 17 owns the formal mapping. Capability requests are not in the schema yet (ticket 11 adds them, with the fourth rejection reason).
- **Where output fields come from:** the adapter reports them (`AttemptExit.reportedOutput`, recorded in `attempt_exited`), not files the agent writes into the workspace, so agent-authored bytes stay out of the snapshot that ticket 03's diff-scope check inspects. A field value is text or a list of text; a field counts as present when it holds some non-blank text. The mock adapter prints them as JSON on stdout.
- **Context** for step N+1 is only the declared `requiredOutputFields` of step N's passing attempt.
- **Workspace chaining:** step N+1's workspace starts from step N's passing snapshot commit (the first step from the run's base commit). That is what makes artifacts "by reference" point at something the recipient can see, and `base.commit` is the commit artifact hashes are read from.
- **Artifacts** are declared on the sending step (`artifacts: [paths]`, exact files, no globs) and hashed from the blob in the base commit (`git cat-file blob`, streamed into SHA-256; never working-tree bytes). Files a step merely changed are not passed. A declared path that is not a file in the step's snapshot (never written, or git-ignored) is not a failure of the sender's verification; it makes the next handoff unsatisfiable (`unmet_dependency`). A file that was already in the repository and is untouched counts as present: the check is "is a file in the snapshot", not "the step wrote it".
- **Rejection reasons**, defined narrowly. `unmet_dependency`: a required field missing from the context, a required artifact not listed, a listed artifact (or the base commit) absent from the repository. `artifact_hash_mismatch`: the artifact exists at the base commit but hashes differently. `schema_invalid`: anything the Zod schema rejects, one reason per issue. Each reason carries a JSON Pointer. Inside a run the runtime builds well-formed handoffs, so only `unmet_dependency` is reachable there; the other two are tested through `validateHandoff`, which the SDK exports for any handoff document.
- **Revisions in replay:** `supersedes` is in the schema (revision N supersedes N-1). Replay marks the earlier revision `superseded` when a later one is issued for the same handoff, and refuses a ledger that re-issues or skips a revision, decides a revision twice, or starts an attempt under a handoff that is not `accepted`. Nothing in the runtime issues a second revision yet: ticket 04 does, so those rules are tested by appending hand-made events to a real ledger. An attempt records the `handoffId` and revision it runs under.
- **`verification.command` is optional.** A step with only `requiredOutputFields` is a *structural verification* (no command, no verification worktree; `verification_started` and the verdict are still recorded, and the verdict passes only if every evidence item passes). A step with neither is rejected statically. Reports label command-less verification "structural verification"; ticket 08 still owns making review steps use it.
- **`instructions`** (optional text on a step) was added so a handoff can say what to do; the ticket did not list it.
- **Static validation** now also rejects unknown properties on a workflow, step, agent or verification, and branching properties (`parallel`, `dependsOn`, `needs`, `after`), as well as parallel groups (a nested array in `steps`), unknown adapters, invalid output field names, and unsafe or repeated artifact paths.
- **`core.longpaths`:** `git config` run inside a linked worktree writes the user's shared repository config, so AHP uses per-worktree config instead, which needs `extensions.worktreeConfig` switched on in the repository. That one flag is the only change AHP makes to the user's repository configuration; it is skipped (checkout-only long paths) when the repository sets `core.worktree`. Veto this if a repository-config change is unacceptable; the alternative is to pass `-c core.longpaths=true` on each git command and put it in the agent's environment.
- Ticket 01's expected ledger sequence now includes `handoff_issued` and `handoff_accepted` before `attempt_created`, and the exhaustive switch in replay means a new event type fails the typecheck until handled.
- **Published JSON Schema** carries the repository-path rule as a regex, so a third-party validator rejects the same paths the SDK does; the cross-field rules (revision/supersedes, unique entries) are in the schema description only. A test validates real handoffs against the schemas with ajv (a dev dependency).
- **Limits:** validation checks a handoff document against the repository, not against a run: it does not check that `contextId`, `to` or `from` match a run, because the runtime builds the handoff itself. Inside a run only `unmet_dependency` is reachable, so `schema_invalid` and `artifact_hash_mismatch` are tested through `validateHandoff`. With `core.worktree` set, long paths apply to the checkout only.
- Not done: no size cap on field values (a very long reported field goes into the ledger and the next handoff); artifact lists do not include deleted files; deriving artifacts from the diff was rejected because a step that installs dependencies would hand on thousands of files.
