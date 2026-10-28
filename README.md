# AHP: Agent Handoff Protocol and LLM Evaluation

AHP makes handoffs between AI coding agents explicit, verifiable and measurable, and evaluates whether doing so improves real task outcomes.

Release 1 targets four coding-agent CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode), combinable in one workflow, each through a dedicated adapter. A step succeeds only when verification passes, never on an agent's own claim; every event is written to an append-only ledger so a crash never silently runs work twice; and an evaluation engine tests whether structured handoffs actually beat a single agent and a plain-text pipeline. A negative result is a legitimate outcome.

**Status: early development.** Linear multi-step workflows run end to end with the mock adapter, each step receiving a validated, versioned handoff, a run whose process stopped is recovered with `ahp recover`, and Ctrl+C cancels a run. Adapters exist for Claude Code, Codex CLI and OpenCode; the Gemini CLI adapter has never run a turn. See the [support matrix](docs/support-matrix.md).

## Development

Requires Node.js 24 or newer and git. Developed on Windows; CI runs on Windows, macOS and Linux.

```sh
npm install
npm run typecheck   # tsc, no emit
npm test            # Vitest: the whole suite
npx vitest run test/run.test.ts   # one test file
npm run build       # compile to dist/
npm run schemas     # regenerate schemas/*.json after changing a protocol schema
```

Try it against any git repository with a commit (after `npm run build`):

```sh
node bin/ahp.mjs run workflow.ts --repo <repo>
node bin/ahp.mjs inspect <run-id> --repo <repo>
node bin/ahp.mjs recover <run-id> --repo <repo>                            # after the runtime died
node bin/ahp.mjs recover <attempt-id> --policy adopt|abort --repo <repo>   # decide an unknown attempt
```

`ahp run` and `ahp recover` exit 0 when the run succeeded, 1 when it failed (or ahp did), 2 on a usage error, 3 when the run stopped for a recovery decision and 130 when it was cancelled.

A workflow file (`.ts` or `.js`) default-exports a workflow definition. The package is not published yet, so either `npm link` it into the target repository or export the same definition as a plain object. With the mock adapter:

```ts
import { defineWorkflow, mock } from "agent-handoff-protocol";

export default defineWorkflow({
  name: "greeting",
  steps: [
    {
      id: "implement",
      agent: mock({ attempts: [{ edits: [{ path: "greeting.txt", content: "hello\n" }], exitCode: 0 }] }),
      verification: { command: "node verify.mjs" },
    },
  ],
});
```

### Several steps and handoffs

A workflow is a linear list of steps; each runs after the one before it. Parallel steps are rejected before anything runs. A step can declare:

- `verification.command`: run in the verification worktree; exit 0 passes.
- `verification.requiredOutputFields`: fields (`summary`, `decisions`, `constraints`, ...) the coding agent must report. A missing or blank one fails verification, with the missing names as evidence. A step with fields and no command gets a *structural verification*, which checks only that the output is complete and says nothing about its quality. Every step needs a command, fields, or both.
- `artifacts`: repository-relative paths of files it hands to the next step. Each must be a file in the step's snapshot (one it wrote or one already in the repository; a file git ignores is not in the snapshot), or the next handoff is rejected.
- `instructions`: what the step is to do.

Before an attempt starts, the runtime issues the step an immutable, versioned **handoff** and validates it on the recipient's behalf. The handoff carries the step's contract, the previous step's required output fields as context, and the previous step's artifacts by reference: each is a path plus the SHA-256 of its *committed* content, so the same artifact hashes identically whatever line endings a checkout applied. The step's workspace starts from the previous step's snapshot, so those artifacts are present in it. A rejected handoff fails the step as `rejected` and no attempt runs. Rejection reasons are a closed set: `schema_invalid`, `artifact_hash_mismatch`, `unmet_dependency`; each comes with a JSON Pointer into the handoff. `ahp inspect` prints every handoff revision in full, and `validateHandoff(handoff, { repo })` from the SDK runs the same validation on any handoff document.

The protocol's JSON Schemas are generated from its Zod schemas and published in [`schemas/`](schemas/) (run `npm run schemas` after changing one). They are at version 0.1.0, and the protocol stays 0.x.

```ts
import { defineWorkflow, mock } from "agent-handoff-protocol";

export default defineWorkflow({
  name: "plan-then-implement",
  steps: [
    {
      id: "plan",
      instructions: "Plan the endpoint.",
      agent: mock({ attempts: [{ edits: [{ path: "PLAN.md", content: "# Plan\n" }], outputFields: { summary: "..." } }] }),
      verification: { requiredOutputFields: ["summary"] },
      artifacts: ["PLAN.md"],
    },
    {
      id: "implement",
      agent: mock({ attempts: [{ edits: [{ path: "greeting.txt", content: "hello\n" }] }] }),
      verification: { command: "node verify.mjs" },
    },
  ],
});
```

### Verification and worktrees

A step succeeds only when its verification passes: the command exits 0 in a fresh verification worktree built from AHP's snapshot of the attempt, and every required output field is present. The verification command runs through the system shell on your machine and executes code the agent wrote. Mock adapter results are labelled `[mock]` and are never evidence. AHP keeps each run's ledger and snapshot refs inside the repository's git directory (`.git/ahp/runs/`, `refs/ahp/`), so they never appear in your working tree. Attempt and verification worktrees live outside every repository, under `AHP_HOME` (default `%LOCALAPPDATA%\ahp` on Windows, `~/Library/Application Support/ahp` on macOS, `$XDG_STATE_HOME/ahp` or `~/.local/state/ahp` on Linux), so verification cannot pick up your checkout's `node_modules` or config by walking up parent directories. AHP enables `core.longpaths` in every worktree it creates (deep paths fail on Windows otherwise). To keep that out of your own configuration it uses git's per-worktree config, which switches on `extensions.worktreeConfig` in the repository's `.git/config`; that one flag is the only change AHP makes to your repository configuration, and it is skipped in a repository that sets `core.worktree`. A git worktree is workspace isolation, not a security boundary.

### The ledger

A run's ledger is one JSONL file, `.git/ahp/runs/<run>/ledger.jsonl`, appended to and flushed to disk after every event, and never rewritten or renamed. Each event carries a sequence number, the previous event's hash and its own SHA-256 over its canonical JSON, so an event changed, reordered or missing anywhere but at the end breaks the chain: `ahp inspect` then names the line and exits 1 without showing any state, and `readRun` in the SDK throws `LedgerCorruptError`. Events lost from the very end leave a valid, shorter chain, which the file alone cannot reveal. A last line that a write did not finish, a *torn tail* such as a crash leaves, was never recorded: readers leave it out and `ahp inspect` reports it, and the next process to open the run for writing (`ahp recover`) truncates it and records the truncation.

Only one process writes a run. It holds `ledger.lock` beside the ledger, created exclusively and naming its host, PID and start time, until it finishes. `ahp inspect` says who is writing a run, and flags a run whose writer is gone (a stale lock, or an unfinished run with no lock) as needing recovery. AHP never takes a stale lock over by itself: `ahp recover` does when you ask, and records whose it was (a run that had already ended takes no more events, so its stale lock is just removed, and `ahp recover` says so). `ahp inspect --json` prints `{ state, ledger, lock }`.

### Crashes and recovery

Every effect is recorded before it happens: an attempt's `dispatching` event is on disk before its agent is spawned. If the runtime dies, `ahp recover <run-id>` takes over its stale lock and continues the run from wherever its ledger stops. An attempt that was dispatched and has no record of how it ended is never dispatched again: its outcome is `unknown`, as is that of an attempt whose adapter lost contact with its agent. Each unknown attempt gets a recovery report: the last ledger events, what its workspace holds against the step's base commit, how the shared repository's refs (remote-tracking refs included) moved since just before it was dispatched, the transport's tool-call log if the adapter keeps one (none does yet), and the statement that host and external effects are undetermined. AHP cannot see files the agent changed elsewhere on the machine, its network calls, or a push that leaves no local ref behind.

What happens next is the step's `recovery` policy:

- `manual` (the default): the run stops in `needs_recovery` and you decide. `ahp recover <attempt-id> --policy adopt` verifies the attempt's workspace as its result (a result that fails ends the step as `verification_failed`: no new agent starts while the old one may still be running); `--policy abort` fails the step as `unknown`. `ahp recover` refuses an attempt that is not awaiting a decision.
- `adopt` or `abort`: applied at once, without stopping.

`discard_and_retry` is deferred past release 1: its only safety check would be the ref diff, which cannot see a push that leaves no local ref behind. The shared refs are recorded just before every attempt is dispatched and again once it has exited or been found unknown, so a moved ref shows in the ledger.

### Cancelling

Ctrl+C on `ahp run` (or `ahp recover`) cancels the run; in the SDK, abort the `signal` you pass to `runWorkflow`. The cancel is recorded first, then the running agent and every process it started are stopped: on Linux and macOS SIGTERM to the agent's process group, then, after a grace period (5 s, `cancelGraceMs` in the SDK), SIGKILL to the group; on Windows a forced kill of the whole tree (`taskkill /T /F`), since a process without a console of its own cannot be asked to stop. An adapter whose transport has a cancel of its own (ACP `session/cancel`) uses it first. The attempt is recorded `cancelled` only once every process of its tree is seen gone, with whether that was graceful or forced; if that cannot be confirmed, its outcome is `unknown` and the run stops for you to decide, as after a crash. No further agent is dispatched, a verification command that is running is stopped (its verdict is `inconclusive`, which says nothing about the attempt), and the run ends `cancelled`. A second Ctrl+C does not interrupt the cancel. If ahp itself dies while cancelling, `ahp recover <run-id>` finishes the cancel.

Agents are started without a shell: AHP resolves the tool's real executable on PATH, and on Windows reads an npm `.cmd` shim to run its JavaScript entry point with Node rather than run the shim through `cmd.exe`. The prompt goes to the agent on stdin, never on a command line.

## Read first

- [Support matrix](docs/support-matrix.md): which core and adapter combinations are tested, on which system, with which tool version.
- [Limits](docs/limits.md): a worktree is not a security boundary; verification runs agent-written code on your machine; subscription terms; no credentials stored.
- [Design direction](docs/design/ahp-v2-direction.md): the agreed direction; §9 records the settled decisions.
- [Architecture decisions](docs/adr/)
- [Glossary](GLOSSARY.md)
- [Release-1 spec](.scratch/ahp-release-1/spec.md) and [tickets](.scratch/ahp-release-1/issues/)

`AHP-presentation.pdf` shows the original design and is superseded by the documents above. `docs/diagrams/ahp-user-workflow.excalidraw` shows the reference scenario as the spec defines it.

## License

[Apache-2.0](LICENSE)
