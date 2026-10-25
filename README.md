# AHP: Agent Handoff Protocol and LLM Evaluation

AHP makes handoffs between AI coding agents explicit, verifiable and measurable, and evaluates whether doing so improves real task outcomes.

Release 1 targets four coding-agent CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode), combinable in one workflow, each through a dedicated adapter. A step succeeds only when verification passes, never on an agent's own claim; every event is written to an append-only ledger so a crash never silently runs work twice; and an evaluation engine tests whether structured handoffs actually beat a single agent and a plain-text pipeline. A negative result is a legitimate outcome.

**Status: early development.** Linear multi-step workflows run end to end with the mock adapter, each step receiving a validated, versioned handoff; no real coding-agent adapter exists yet.

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
```

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

## Read first

- [Design direction](docs/design/ahp-v2-direction.md): the agreed direction; §9 records the settled decisions.
- [Architecture decisions](docs/adr/)
- [Glossary](GLOSSARY.md)
- [Release-1 spec](.scratch/ahp-release-1/spec.md) and [tickets](.scratch/ahp-release-1/issues/)

`AHP-presentation.pdf` and `docs/diagrams/ahp-user-workflow.excalidraw` show the original design and are superseded by the documents above.

## License

[Apache-2.0](LICENSE)
