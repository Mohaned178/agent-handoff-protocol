# 01: Task inference

**What to build:** A pure function that reads a project and says how to check and install it, and who plays each step,
each answer with where it came from, so `ahp "<task>"` asks nothing it can work out.

**Blocked by:** none

**Status:** planned

- [ ] Check command from the project, first match wins, each with its source: `package.json` `scripts.test` (unless it is
      npm's placeholder `echo "Error: no test specified" && exit 1`) → `npm test`; `pyproject.toml`/`pytest.ini`/`tests/`
      → `pytest`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`; `Makefile` with a `test` target →
      `make test`; else none (spec D3)
- [ ] Install command from the lockfile: `package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install
      --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package.json` alone → `npm install`;
      Python, Rust and Go need none for their test commands
- [ ] Casting from `ahp doctor`'s report: `assignRoles` as today, then the per-user defaults (ticket 03) on top
- [ ] Branch name from the task: `ahp/` + a slug of its first words (`slugOf`, already in `src/setup`), a number added
      when the branch exists
- [ ] Reads files only, runs nothing (no `npm`, no tool), and never reads outside the repository
- [ ] Tests: a table of small fixture projects → expected check, install and sources

## Notes

- Lives beside `src/setup/` (it is the questions `ahp setup` asks, answered from the project instead).
- An inferred command is shown, never hidden: the summary prints it with its source, so a wrong guess is seen before
  anything runs.
