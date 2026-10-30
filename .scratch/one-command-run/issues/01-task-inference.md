# 01: Task inference

**What to build:** A pure function that reads a project and says how to check and install it, and who plays each step,
each answer with where it came from, so `ahp "<task>"` asks nothing it can work out.

**Blocked by:** none

**Status:** done (2026-10-30)

- [x] Check command from the project, first match wins, each with its source: `package.json` `scripts.test` (unless it is
      npm's placeholder `echo "Error: no test specified" && exit 1`) → `npm test`; `pyproject.toml`/`pytest.ini`/`tests/`
      → `pytest`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`; `Makefile` with a `test` target →
      `make test`; else none (spec D3)
- [x] Install command from the lockfile: `package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install
      --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package.json` alone → `npm install`;
      Python, Rust and Go need none for their test commands
- [x] Casting from `ahp doctor`'s report: `assignRoles` as today, then the per-user defaults (ticket 03) on top
- [x] Branch name from the task: `ahp/` + a slug of its first words (`slugOf`, already in `src/setup`), a number added
      when the branch exists
- [x] Reads files only, runs nothing (no `npm`, no tool), and never reads outside the repository
- [x] Tests: a table of small fixture projects → expected check, install and sources

## Notes

- Lives beside `src/setup/` (it is the questions `ahp setup` asks, answered from the project instead).
- An inferred command is shown, never hidden: the summary prints it with its source, so a wrong guess is seen before
  anything runs.

## Implementation notes (2026-10-30)

`src/setup/infer.ts`: `inferCommands(dir)` (check and install, each `{ command, source }` or null), `castRoles(report,
defaults)`, `branchFor(task, existing)` and `inferTask` over all three. Tests: `test/infer.test.ts`. Choices made:

1. **The existing branches are an input** (`branches`), not read by the inference: it runs nothing, not even git.
   Ticket 02 lists them (`git for-each-ref refs/heads`) and passes them in. The number added is `-2`, `-3`, ...
2. **A Node install is inferred whenever there is a `package.json`**, whatever the check: a `make test` can need
   `node_modules` as much as `npm test`. The cost is a needless `npm ci` in a Python project that also has a
   `package.json`; the summary shows it with its source. A lockfile without a `package.json` installs nothing.
3. **A per-user default whose tool is not usable here is set aside**, keeping `assignRoles`' casting, and the reason
   says so ("your default, Claude Code, is not usable here; ..."). A default that applies has the reason
   `your default`, for ticket 02's summary to show. `RoleDefaults` is the shape ticket 03 will store.
4. **Never outside the repository:** only fixed names at the root (and whether `tests/` is a directory) are looked at,
   and a symbolic link is treated as absent. The test of that skips on Windows when links cannot be created.
5. A `Makefile` has a `test` target when a rule line names `test` among its targets before a `:` that is not `:=`
   (`.PHONY: test` alone is not one). A `package.json` that does not parse gives no check but still `npm install`.
