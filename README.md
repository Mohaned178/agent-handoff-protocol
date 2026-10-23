# AHP: Agent Handoff Protocol and LLM Evaluation

AHP makes handoffs between AI coding agents explicit, verifiable and measurable, and evaluates whether doing so improves real task outcomes.

Release 1 targets four coding-agent CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode), combinable in one workflow, each through a dedicated adapter. A step succeeds only when verification passes, never on an agent's own claim; every event is written to an append-only ledger so a crash never silently runs work twice; and an evaluation engine tests whether structured handoffs actually beat a single agent and a plain-text pipeline. A negative result is a legitimate outcome.

**Status: early development.** A one-step workflow runs end to end with the mock adapter; no real coding-agent adapter exists yet.

## Development

Requires Node.js 24 or newer and git. Developed on Windows; CI runs on Windows, macOS and Linux.

```sh
npm install
npm run typecheck   # tsc, no emit
npm test            # Vitest: the whole suite
npx vitest run test/run.test.ts   # one test file
npm run build       # compile to dist/
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

A step succeeds only when its verification command exits 0 in a fresh verification worktree built from AHP's snapshot of the attempt. The verification command runs through the system shell on your machine and executes code the agent wrote. Mock adapter results are labelled `[mock]` and are never evidence. AHP keeps each run's ledger and snapshot refs inside the repository's git directory (`.git/ahp/runs/`, `refs/ahp/`), so they never appear in your working tree. Attempt and verification worktrees live outside every repository, under `AHP_HOME` (default `%LOCALAPPDATA%\ahp` on Windows, `~/Library/Application Support/ahp` on macOS, `$XDG_STATE_HOME/ahp` or `~/.local/state/ahp` on Linux), so verification cannot pick up your checkout's `node_modules` or config by walking up parent directories. A git worktree is workspace isolation, not a security boundary.

## Read first

- [Design direction](docs/design/ahp-v2-direction.md): the agreed direction; §9 records the settled decisions.
- [Architecture decisions](docs/adr/)
- [Glossary](GLOSSARY.md)
- [Release-1 spec](.scratch/ahp-release-1/spec.md) and [tickets](.scratch/ahp-release-1/issues/)

`AHP-presentation.pdf` and `docs/diagrams/ahp-user-workflow.excalidraw` show the original design and are superseded by the documents above.

## License

[Apache-2.0](LICENSE)
