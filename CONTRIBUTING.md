# Contributing

Thank you for helping. AHP is maintained by one person, in the open; issues and pull requests are answered on
GitHub, with no promised response time. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Setting up

You need Node.js 24 or newer and git.

```sh
git clone https://github.com/Mohaned178/agent-handoff-protocol
cd agent-handoff-protocol
npm install
npm run typecheck
npm test                    # Vitest: real git repositories, the mock adapter and fake tools; never a real agent
node src/cli/bin.ts --help  # the CLI from source, no build needed
```

The code is TypeScript run by Node's type stripping: imports use `.ts` extensions, and only erasable syntax is allowed
(no enums, namespaces or parameter properties). `CLAUDE.md` describes every module and the rules the design depends
on; `GLOSSARY.md` holds the terms, and `docs/adr/` the decisions that are hard to reverse.

## Changes

- **Tests first, on what can be observed**: a run's ledger, the CLI's output, files and refs. No test runs a real
  coding agent or needs a credential; adapters are tested against fake tools that print captured output
  (`test/helpers/`).
- **Never fabricate a result.** Mock output is never evidence; usage and models are reported only as a tool
  reported them; an agent's "done" is never success.
- Work is planned in tickets under `.scratch/<feature>/issues/`, one file each, with a `Status:` line and a
  `## Comments` section. A pull request names the ticket it implements, or says what it fixes.
- CI runs typecheck, tests and build on Windows, Linux and macOS; a pull request needs it green.
- A change people will notice gets a line in `CHANGELOG.md`, written for them.

## Recording a system the maintainer cannot

The [support matrix](docs/support-matrix.md) names a system for an adapter only when the adapter's conformance suite
has been run there and recorded. The maintainer runs Windows and Linux through WSL2, so **macOS and native Linux are
untested for every tool** until someone records them. If you have one of those systems and the tool, you can:

1. Install the tool and log in with your own account (the suite starts real agent turns, a few dozen, on your plan).
2. Check that `ahp doctor` (or `node src/cli/bin.ts doctor` from a clone) reports the tool installed and logged in.
3. From a clone, with no API key in the environment (the suite must use the tool's own login), run one of:

   ```sh
   env -u ANTHROPIC_API_KEY npm run conformance -- run claude-code
   env -u OPENAI_API_KEY -u CODEX_API_KEY npm run conformance -- run codex
   env -u OPENAI_API_KEY npm run conformance -- run opencode
   ```

   The suite refuses to run in CI. It records the tool's version, or asks for `--tool-version <v>`.
4. It writes one file, `conformance/results/<adapter>--<system>.json`. Read it: it holds the checks and their
   details, not credentials. Then regenerate the published pages with `npm run conformance -- matrix --write`
   (it rewrites `docs/support-matrix.md` and the README's table of tools).
5. Open a pull request with the result file and the two regenerated pages, saying the tool version and system.

A result that is `failed` or `untested` is as welcome as a pass: the matrix publishes it as it is.

## Releasing (the maintainer)

1. Every test green on `main`, and no ticket marked blocker.
2. `CHANGELOG.md`: the version's section dated; `package.json`'s version matching; the README's install line naming
   the npm package.
3. Tag and push: `git tag v<version> && git push origin v<version>`. The release workflow tests on the three systems
   and publishes with provenance, using the repository's `NPM_TOKEN` secret; it refuses a tag that does not name
   `package.json`'s version.
4. Check the published package from outside the repository: `npm install -g @mohaned178/ahp`, `ahp doctor`,
   `ahp demo`, `npm uninstall -g @mohaned178/ahp`, on Windows and in WSL2.
5. Keep a ledger from the new version for the upgrade tests: approve an `ahp demo` run to its end and copy its
   `ledger.jsonl` to `test/fixtures/ledgers/<version>/`, with its expected replay in `test/ledger-releases.test.ts`.
