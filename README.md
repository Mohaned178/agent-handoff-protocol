# AHP: Agent Handoff Protocol and LLM Evaluation

AHP makes handoffs between AI coding agents explicit, verifiable and measurable, and evaluates whether doing so improves real task outcomes.

Release 1 targets four coding-agent CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode), combinable in one workflow, each through a dedicated adapter. A step succeeds only when verification passes, never on an agent's own claim; every event is written to an append-only ledger so a crash never silently runs work twice; and an evaluation engine tests whether structured handoffs actually beat a single agent and a plain-text pipeline. A negative result is a legitimate outcome.

**Status: pre-implementation.** There is no code yet.

## Read first

- [Design direction](docs/design/ahp-v2-direction.md): the agreed direction; §9 records the settled decisions.
- [Architecture decisions](docs/adr/)
- [Glossary](GLOSSARY.md)
- [Release-1 spec](.scratch/ahp-release-1/spec.md) and [tickets](.scratch/ahp-release-1/issues/)

`AHP-presentation.pdf` and `docs/diagrams/ahp-user-workflow.excalidraw` show the original design and are superseded by the documents above.

## License

[Apache-2.0](LICENSE)
