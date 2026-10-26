# 10: External actions

**What to build:** After verification passes and an approval gate is approved, AHP itself pushes the branch or opens a PR, checking current state first so a resumed run never acts twice (ADR 0003). If AHP sees that an agent pushed or changed shared refs, the step fails with `forbidden_external_action_detected`.

**Blocked by:** 09

**Status:** done

**Model:** Opus 5.5 · high

- [x] External-action step kinds: push branch, open PR, merge; no deploy
- [x] Static validation rejects an external action without a preceding approval gate
- [x] Intent is recorded before the action; current remote state is checked first; an already-done action is recorded, not repeated
- [x] PRs are opened with the GitHub CLI under the user's own login; AHP stores no credentials
- [x] Tests use a local bare remote, including a kill mid-action followed by resume
- [x] A mock agent that pushes or changes refs triggers `forbidden_external_action_detected`
- [x] Reports state that absence of that evidence is not proof

## Implementer notes

- Put PR operations behind a small provider interface (find existing PR for a branch, open PR, merge PR). The real implementation calls `gh`; tests use an in-memory fake. Real `gh` is never called in CI.
- Push idempotency: before pushing, read the remote branch's commit (`git ls-remote`); if it already equals the commit to push, record "already done" and do not push.
- PR idempotency: look for an open PR from the branch first; if one exists, record it and do not open another.
- Detection: compare the ref snapshots from before and after the attempt (local branches, tags, remote-tracking refs). Any change the runtime did not make is `forbidden_external_action_detected`.
- Test the crash case: kill the runtime after the "intended" event and before "performed", resume, and assert exactly one push reached the bare remote.

## Comments

2026-10-27, implementation notes.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **An external action is a step `{ id, action: { kind, ... } }`**: `push_branch { branch, remote? }`, `open_pr { branch, base, title, body?, remote? }`, `merge_pr { branch, method?: merge | squash | rebase, remote? }` (remote defaults to `origin`, method to `merge`). `deploy` is refused naming ADR 0003. One action per step, so each has its own intent, check and outcome. *Recommended: keep.*
2. **Placement: an action follows an approval gate with nothing but external actions between them, and publishes the commit that gate approved.** An agent step in between would publish work nobody approved, so validation refuses it, and replay refuses an intent naming any other commit. A gate cannot follow an action (a rejection must reach an agent step), nor can a review send one back. `open_pr` needs a `push_branch` of the same branch and remote after the same gate, and `merge_pr` an `open_pr`. *Recommended: keep.*
3. **The approved snapshot commit is pushed as it is**, to `refs/heads/<branch>`, never forced: the branch's history is the chain of AHP snapshot commits (author "AHP", message "AHP snapshot of ..."), plus any commits the agents made. No squash or rewrite, because the approval names that commit; a branch the push would not fast-forward fails the step. *Recommended: keep; a squashed commit with a chosen message would be a new option, and the approval would then have to name its tree rather than its commit.*
4. **Idempotency is decided by the remote, checked before every attempt to act**: push is done when `git ls-remote` shows the branch at the approved commit; `open_pr` when an open pull request from the branch exists (or a merged one whose head is the approved commit); `merge_pr` when a merged pull request's head is the approved commit. The merge passes `--match-head-commit`, so it never merges anything but the approved commit. Events: `external_action_intended` (target recorded before anything), `external_action_checked { done, observed }`, `external_action_performed`, `external_action_failed`. *Recommended: keep.*
5. **A failed external action is a new failure class, `external_action_failed`, never retried** (a protocol change: FAILURE_CLASSES is closed). The remote is checked again after the failure first: if it shows the action done, that is recorded instead. The run fails, and `ahp inspect` says the approved commit stays pinned and how to push it by hand (`git push <remote> <commit>:refs/heads/<branch>`). That means a `gh` not logged in, or a push refused, costs a new run (the agents run again). *Recommended: keep for release 1; stopping in a state a person can resume after fixing the login would be a new human-action command.*
6. **`forbidden_external_action_detected` fails verification like any failing evidence**: any change between the attempt's before and after ref snapshots (branches, tags, remote-tracking refs, stash) is listed, the verification command is not run (as for a protected path), and the failure is `verification_failed`, retried within the step's budget with the changed refs as handoff evidence; a step with no budget left fails. ADR 0003 says "verification fails"; the ticket's "the step fails" holds once the budget is spent. AHP cannot tell who moved a ref, so your own commit or an editor's background fetch during an attempt is a false positive; the retry keeps that from ending the run. *Recommended: keep (the cheaper reading); the alternative, failing the step at once with no retry, makes every false positive cost a new run.*
7. **A cancel never starts an action**: one whose intent is recorded is checked (read-only) and never performed after the cancel; found done, it succeeds (a cancel cannot take a push back), otherwise the step ends `cancelled`. A push or `gh` call already running is not stopped by AHP; the check after it decides. *Recommended: keep.*
8. **Pull requests go through `PullRequestProvider` (`find`, `open`, `merge`)**, set as `pullRequests` in the SDK's run options; the default `githubCli()` runs `gh` with `GH_PROMPT_DISABLED=1` and `--repo HOST/OWNER/REPO` read from the remote's URL, so the pull request's head and base are both in that repository (no forks). The default body names the run, the approved commit, the gate, who approved it and when. *Recommended: keep.*
9. **The `gh` implementation is not tested here**: the ticket keeps real `gh` out of CI, and the agreed seams are the SDK run API with the mock adapter and the CLI. A test of `githubCli()` against a fake `gh` (a Node script given as `file`/`prefixArgs`) would check its arguments and its parsing of `gh pr list --json` without a login. *Recommended: add it as that new seam, in this ticket's tidy-up, if you agree.*

**Shapes:**

- Protocol: `ExternalActionStepDefinition` (`action: PushBranchAction | OpenPullRequestAction | MergePullRequestAction`), `isExternalAction`, `isAgentStep`, `EXTERNAL_ACTION_KINDS`, `MERGE_METHODS`, `isBranchName`, `isRemoteName`; `StepKind` gains `external_action` and `StepView.action` (`ExternalActionView`: target, checks, performed, failure; `isExternalActionDone`); `ExternalActionTarget`, `ExternalObservation`, `PullRequestRecord`; four events; the failure class `external_action_failed`; the evidence `ForbiddenExternalActionEvidence`, also a handoff evidence kind (schema regenerated).
- Replay: an intent only for a ready action step, not after a cancel, naming the commit approved at the gate before it; checks, a performed or a failure only while the action is under way (a performed only after a check that found it not done); the step `succeeded` only once done, `failed` only with a failure, `cancelled` only when a check found it not done; `external_action_failed` is that step's class and no other's.
- Mock adapter: `git: string[][]`, git commands the agent runs in its workspace after its edits and commit (a push, a branch, a tag).

**Not done:**

- `gh` itself is never run by a test (decision 9). Pull requests across forks are not supported.
- Detection sees only the shared refs; a push to a URL or through an API is invisible, and `ahp inspect` says so in every run with a verified attempt. A ref moved by another AHP run's external action during an attempt is a false positive too.
- Evaluation runs have no external actions (ticket 20 enforces that).
- The side-effect class of a step (`workspace_only` / `may_have_external_effects`, spec story 15) is not part of this ticket.

**After review (code-review against this ticket and the repo's standards):**

- Fixed: `open_pr` counted any open pull request from the branch as done, whatever its base; now only one into the step's base does (a new test opens its own pull request beside one into another base). A cancel that stops a running push or `gh` call (a console's Ctrl+C reaches them too) ended the step `failed`; now the failure is not recorded under a cancel, and the step ends `cancelled` once a check finds the action not done (tested). The check after a failed attempt to act is recorded, not only used. An agent that pushed and then failed, so was never verified, was reported as "none detected"; `ahp inspect` now reads detection from every attempt's ref snapshots and lists the changed refs under an unverified attempt (tested). The walk back to the approving gate is one function (`gateBefore`) shared by replay and the executor; `recordCheck` returns what it saw; CLAUDE.md's list of step kinds; the fake's unused `failFind`, and the export of `githubRepositoryOf`.
- Left as they are, on purpose: an agent that pushed and then failed is retried as `agent_error` with the same input, so its retry is not told what it changed (detection is verification evidence, and an attempt whose agent failed is not verified, as before); agent steps may follow an external action (nothing forbids it, and they receive the agent step's result); `cli-recovery`'s adopt now fails on the ref its crashed "agent" moved, which is the behaviour this ticket adds (the SDK recovery tests still cover an adopt that succeeds); the throw for an attempt with a missing ref snapshot stays a throw, since every verified attempt has both by construction; external calls have no timeout (decision 7).
- Not done, assigned elsewhere: telling coding agents not to push, open or merge (ADR 0003's "instructed, and configured where the tool allows") belongs to how each adapter renders the handoff and applies capabilities, tickets 11 and 15 to 19; nothing in the mock adapter or the core does it yet.

**Confirmed by the maintainer on 2026-10-27 ("do recommendation"): decisions 1 to 9 above stand as recommended; reopen one only with a new decision.** Decision 9 is done: `test/pull-requests.test.ts` runs `githubCli()` against a fake `gh` (`test/helpers/fake-gh.ts`, a Node script given as `file`/`prefixArgs`) and checks the arguments it passes (`--repo` read from the remote's URL, `--match-head-commit`), that `GH_PROMPT_DISABLED` is set, its parsing of `gh pr list --json`, a remote URL that names no hosted repository, and a failure's message. Real `gh` still never runs in a test.

First green CI run: GitHub Actions run 40403664608 (commit eefbfc2). 352 tests passed on Linux and macOS (1 skipped: the signal test). Windows had 350 passed and 3 skipped: the signal test, the POSIX resolution test and the Ctrl+C CLI test. The kill-mid-push crash test (`test/cli-external.test.ts`, a `post-receive` hook run by git's own sh) passed on all three.
