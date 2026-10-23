# 10: External actions

**What to build:** After verification passes and an approval gate is approved, AHP itself pushes the branch or opens a PR, checking current state first so a resumed run never acts twice (ADR 0003). If AHP sees that an agent pushed or changed shared refs, the step fails with `forbidden_external_action_detected`.

**Blocked by:** 09

**Status:** ready-for-agent

**Model:** Opus 5.5 · high

- [ ] External-action step kinds: push branch, open PR, merge; no deploy
- [ ] Static validation rejects an external action without a preceding approval gate
- [ ] Intent is recorded before the action; current remote state is checked first; an already-done action is recorded, not repeated
- [ ] PRs are opened with the GitHub CLI under the user's own login; AHP stores no credentials
- [ ] Tests use a local bare remote, including a kill mid-action followed by resume
- [ ] A mock agent that pushes or changes refs triggers `forbidden_external_action_detected`
- [ ] Reports state that absence of that evidence is not proof

## Implementer notes

- Put PR operations behind a small provider interface (find existing PR for a branch, open PR, merge PR). The real implementation calls `gh`; tests use an in-memory fake. Real `gh` is never called in CI.
- Push idempotency: before pushing, read the remote branch's commit (`git ls-remote`); if it already equals the commit to push, record "already done" and do not push.
- PR idempotency: look for an open PR from the branch first; if one exists, record it and do not open another.
- Detection: compare the ref snapshots from before and after the attempt (local branches, tags, remote-tracking refs). Any change the runtime did not make is `forbidden_external_action_detected`.
- Test the crash case: kill the runtime after the "intended" event and before "performed", resume, and assert exactly one push reached the bare remote.
