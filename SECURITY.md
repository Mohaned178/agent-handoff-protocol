# Security policy

## Reporting a problem

Report a security problem privately, through GitHub: on the repository's **Security** tab, choose **Report a
vulnerability** (a private security advisory). Do not open a public issue for it.

Say what you found, the version (`ahp --version`), the system, and the steps that show it. AHP is maintained by one
person: you will get an answer on the advisory, with no promised response time. A fix is released as a new version,
named in the [changelog](CHANGELOG.md), and the advisory is published once the fix is out.

## Supported versions

Only the newest published version gets fixes. While AHP is 0.x, upgrade to fix.

## In scope

- AHP's own code: the CLI, the SDK, the runtime and the adapters, as published.
- The ledger: anything that lets a run's recorded history be changed without the hash chain showing it, lets two
  processes write one run, or makes AHP derive a state its ledger does not record.
- External actions: anything that lets an agent push, open or merge, or lets AHP do one without the approval its
  workflow requires, or publish a commit other than the one approved.
- AHP reading, keeping or printing a credential it should not.

## Not in scope

These are AHP's documented limits ([docs/limits.md](docs/limits.md)), not vulnerabilities:

- **A git worktree is not a security boundary.** An agent runs as you, with your files, network and environment.
  Limits such as `read_only` are mostly `cooperative`: the agent is told and the tool is asked. Only a level
  recorded `enforced_by_tool` is claimed as enforcement, and a way around one of those *is* in scope.
- **Verification runs the code the agent wrote** on your machine, as do the install command and evaluation
  validators.
- A coding agent tool's own behaviour, its terms and its login: report those to its vendor.
- What an agent or a tool printed into a ledger or a transcript: those are plain files, to be read before sharing.
