# Spec: usable and easy for developers

**Status:** planned (2026-10-31); decisions D1 to D7 adopted 2026-10-31 ("do recommendation")

Asked for by the maintainer on 2026-10-31: "i want the app is being useable for developer and easy to use, then make a
plan for all", after finding the CLI's output "so bad" and asking whether people could use AHP now.

## Problem

AHP works for its maintainer and passes about 895 tests, but a developer who finds it today would not get far:

- **It has not been tried on real work.** `ahp "<task>"` (the one-command run) has only run on the mock and fake tools.
  Nobody knows what breaks on a real project with a real agent.
- **It says too much.** Every block carries long sentences (the receipt's and the usage's headings, the mock note,
  evidence inline), which the CLI guidelines and comparable tools all advise against (`.scratch/cli-ux/research.md`).
- **The first ten minutes have sharp edges.** No tool logged in, no git identity, no test script, a Windows path: each
  ends in a message that says what is wrong but not always the command that fixes it.
- **It is not packaged.** It installs from GitHub and builds on the user's machine, at version 0.0.0, `private`. The
  npm name `agent-handoff-protocol` belongs to someone else's package, and so does `ahp`.
- **CI is red.** Two Windows tests exceed the 60 s limit on the hosted runner (run 41143276777).
- **There is no evidence it helps.** The pilot has not run; the README says so.

## What "usable" means here (the bar for release 0.1.0)

A developer on Windows or Linux with one of the three tools logged in can, from nothing:

1. install it with one npm command, with no build on their machine;
2. run `ahp "<task>"` in their project and understand every line it prints;
3. approve the diff and know how to get the branch into their work;
4. when something goes wrong, read one line that names the fix (a command to run, a flag to pass);
5. find out in the README, in under a minute, whether AHP is the right tool for the task at all.

And the project can say: CI green on three systems; the maintainer used it on at least five real tasks with no open
blocker; one real receipt in the README.

## Decisions (open; each has a recommendation)

- **D1. Package name.** `@mohaned178/ahp` (scoped, free), `ahp-cli` or `ahp-agents` (free, unscoped).
  *Recommendation:* `@mohaned178/ahp`: a scope cannot be squatted and says whose it is; the command stays `ahp`.
- **D2. What is published.** Prebuilt `dist/` in the package, or a build on install as today.
  *Recommendation:* prebuilt. Installing then runs nothing of ours (no install scripts warning, 30 s faster); the
  GitHub install keeps working for contributors.
- **D3. Version and label.** *Recommendation:* 0.1.0, labelled alpha in the README and `ahp --version`'s line;
  protocol stays 0.x (design direction).
- **D4. How much is printed by default.** *Recommendation:* short by default (a line per step, a two-to-four-line
  receipt, details only on failure); `--verbose` for everything, as today. No new `--quiet`: the short output is it.
- **D5. Where the honesty rules live.** They must stay true (a report is a claim; usage as reported, never summed or
  estimated). *Recommendation:* short labels on screen ("reported", "as each tool reported it"), the full wording in
  `ahp inspect` and the docs, not repeated on every run.
- **D6. Telemetry.** *Recommendation:* none. AHP stores no credentials and phones nowhere; feedback is GitHub issues.
- **D7. Order.** *Recommendation:* CI green → short output → first-run fixes → maintainer dogfooding → docs →
  package and release. Dogfooding comes before publishing, so the first public version has met real work.

## Out of scope

- A hosted service, accounts or a web UI (out of scope for release 1).
- New step kinds, adapters or protocol changes.
- macOS support beyond "untested" unless someone with a Mac runs the conformance suite (ticket 08 says how).
- The evidence question itself: the mini pilot is `.scratch/one-command-run/issues/06-mini-pilot.md` and waits on the
  budget; Claude Code integration is that plan's ticket 07. Both are linked from here, not repeated.

## Tickets

1. `01-ci-green.md`: CI green on all three systems, and kept green
2. `02-short-output.md`: the summary, the live view, the receipt and the run's end, said briefly
3. `03-first-run.md`: every first-ten-minutes failure names its fix; next steps at every stop
4. `04-dogfood.md`: the maintainer runs `ahp "<task>"` on five to ten real tasks (needs the maintainer)
5. `05-fixes-from-dogfood.md`: what ticket 04 found (filled in by it)
6. `06-docs.md`: a three-command quickstart, troubleshooting, one real receipt
7. `07-package-and-release.md`: publish 0.1.0 to npm, prebuilt, from a tagged CI job
8. `08-platform-coverage.md`: Codex and OpenCode conformance on Linux (WSL2); how a Mac user records macOS
9. `09-production-basics.md`: what a tool developers depend on needs beyond working: versioning and upgrade policy,
   security policy, issue templates, a support statement, no data loss on upgrade
10. `10-outside-developers.md`: five developers who are not the maintainer use it on their own work; what they hit
    decides 1.0

## After 0.1.0: production (added 2026-10-31)

The maintainer asked that the app "be a production after that and developer will use it". Two things are different and
the plan treats them apart:

- **Production quality** is in AHP's hands: tickets 01 to 09. 0.1.0 is the first version others install; 1.0 is
  promised when ticket 10's developers have used it without a blocker and the protocol's shapes have held for a release.
- **Developers using it** cannot be guaranteed by any ticket; it can only be earned and measured. Ticket 10 measures it
  with real outside users, and the pilot (one-command run, ticket 06) gives the evidence the README needs to say why
  a developer should use AHP rather than an agent alone. A negative pilot result is reported as it is, and would change
  what AHP is offered for (spec of the one-command run: "on some tasks AHP should lose").

## Comments

- 2026-10-31: the maintainer adopted D1 to D7 ("do recommendation") and asked that the app reach production and be
  used by developers after this plan; tickets 09 (production basics) and 10 (outside developers) were added for that.
