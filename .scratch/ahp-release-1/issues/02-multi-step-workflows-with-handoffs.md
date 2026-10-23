# 02: Multi-step linear workflows with handoffs

**What to build:** A developer defines a linear workflow of several steps; the runtime issues an immutable, versioned handoff to each step, validates it on the recipient's behalf, and passes the previous step's required output fields (decisions, constraints, summary) as context and its artifacts by reference. Invalid handoffs are rejected with machine-readable reasons, and invalid workflows are rejected before running.

**Blocked by:** 01

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · xhigh

- [ ] Protocol schema for handoff and handoff revision, versioned; A2A field names used where semantics match
- [ ] Handoff states `issued → accepted | rejected`
- [ ] Rejection reasons are a closed enumeration: schema invalid, artifact hash mismatch, unmet dependency (capability unsatisfiable arrives in 11)
- [ ] Steps declare required output fields; missing fields fail verification with evidence
- [ ] Required output fields of step N appear as context in the handoff to step N+1
- [ ] Artifact references carry SHA-256 over committed content (ADR 0005); a test proves the same artifact hashes identically with CRLF and LF checkouts
- [ ] AHP-created worktrees enable `core.longpaths`
- [ ] Static workflow validation rejects parallel steps and unknown adapters with clear messages
- [ ] `ahp inspect` shows every handoff revision in full

## Implementer notes

- Define protocol schemas with Zod and export JSON Schema from them; the exported JSON Schema is the published protocol artifact. Every schema carries a `schemaVersion` starting at `0.1.0`.
- A handoff revision is immutable once written: a change is always a new revision with a pointer to the one it supersedes.
- Artifact hash = SHA-256 over the blob content as stored in git (read it from the commit, not from the working tree). Test it in a temporary repo with `core.autocrlf=true` and again with `false`; the hash must be identical.
- Keep rejection reasons and failure classes as closed string unions shared by schema and code; a new reason is a protocol change.
- Stop and ask the user if a schema decision would contradict `GLOSSARY.md` or an ADR.
