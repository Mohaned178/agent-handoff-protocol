# 17: A2A mapping document

**What to build:** A document showing which AHP shapes map to A2A v1.0.0 fields and semantics, and which AHP-specific semantics live in the AHP extension profile under a versioned URI.

**Blocked by:** 02, 11

**Status:** implemented and committed; waiting on the maintainer for the decisions below

**Model:** Sonnet 5.5 · high

- [x] Maps handoff/step/artifact/state shapes to A2A Task, Message, Part, Artifact, `contextId` and state names where semantics match (`docs/a2a-mapping.md` §2; every row says matches, partial, lossy or no counterpart)
- [x] Lists AHP-specific semantics in the extension profile: acceptance criteria, verification evidence and verdict, artifact integrity, capability requests and enforcement levels, attempts and recovery, provenance (§5, with where each sits in `metadata[<uri>]`)
- [x] Names where AHP's schema deliberately differs and why (§4; reasons only where the repository records one, and the `cancelled` spelling is flagged as having none)
- [x] States that there is no wire binding or peer transport in release 1 and the protocol stays 0.x (§6)

## Comments

2026-10-28, implementation notes. Document: `docs/a2a-mapping.md`; drift test `test/a2a-mapping.test.ts`. A2A facts were checked against the v1.0.0 specification page and `a2a.proto` (package `lf.a2a.v1`) on this date, using v1.0.0's own names (`TASK_STATE_*`, a Part holds exactly one of `text|raw|url|data`, no `kind` discriminator), not the design doc's lowercase list. No tdd seam: a document has no behaviour; the test only pins that the closed-list values the document names still exist and that the extension URI's version tracks `PROTOCOL_VERSION`.

- Changed in code: one `//` comment in `src/protocol/handoff.ts` (it called the profile "ticket 17"; it now points at the document). No `.describe()` string, so `schemas/` is unchanged. `PROTOCOL_VERSION` stays `0.1.0`.
- The state table is from the code's `StepState` (ten values, including `waiting_approval`), not design doc §4a. `blocked`, `needs_recovery` and `skipped` have no A2A counterpart, and `verifying` and `waiting_approval` are lossy; the document says so rather than forcing a fit.
- Found while mapping: a send-back returns a *succeeded* step to `ready`, which a terminal A2A Task cannot do (decision 3).
- Only `handoff-revision` and `rejection-reason` have a published JSON Schema. The attempt, verdict, recovery and approval shapes are TypeScript types and ledger events, and the extension payloads have no schema. I did not generate any (out of scope).
- "Provenance" is not a field anywhere in the code. The document describes it as a grouping of what is recorded and says it is not a schema.

**Decisions this ticket leaves open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **The document lives at `docs/a2a-mapping.md`.** *Recommended: adopt* (beside the adapter docs; `CLAUDE.md` points to it).
2. **The extension URI is `https://github.com/Mohaned178/agent-handoff-protocol/extensions/ahp/0.1`.** An identifier under the repository the maintainer controls, which need not resolve; its version is `PROTOCOL_VERSION`'s major.minor, and while the protocol is 0.x a breaking change to the profile mints a new URI. *Recommended: adopt.* The cost: the identity moves with the repository if it is renamed or transferred; a domain of your own would not.
3. **A Step is the A2A Task, attempts are inside it, and a send-back opens a new Task in the same `contextId` with `referenceTaskIds`** (a terminal Task cannot be reopened). *Recommended: adopt.* This is the document's choice; the glossary only reserved the word "Task".
4. **`required: true` for the profile as a whole.** The flag is per extension, not per field, so acceptance criteria and capability requests cannot be required without the rest. *Recommended: adopt:* a peer that dropped them would change what a handoff means.
5. **Keep `cancelled` (not `CANCELED`) and the lowercase state names.** No rationale is recorded for the spelling; design doc §9.2 says AHP's schema wins. *Recommended: keep,* and say so in the document (it does).
6. **`needs_recovery` and `blocked` have no A2A counterpart, and `waiting_approval` maps to `INPUT_REQUIRED` as lossy.** *Recommended: adopt.* Showing `needs_recovery` as `INPUT_REQUIRED` would invite a free-form reply where AHP wants `adopt` or `abort`.
7. **The wording of the 0.x rule.** The document says it is the mapping that the version rule waits on, and does *not* say the other condition (two real adapters having run workflows) is met. *Recommended: adopt;* when to leave 0.x is yours to call.

**Confirmed by the maintainer on 2026-10-28 ("do recommendation"): decisions 1 to 7 above stand as recommended; reopen one only with a new decision.** Decision 2 includes the extension URI `https://github.com/Mohaned178/agent-handoff-protocol/extensions/ahp/0.1`, and decision 7 leaves the move out of 0.x to the maintainer.
