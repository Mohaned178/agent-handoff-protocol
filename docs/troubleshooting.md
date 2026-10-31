# Troubleshooting

Most problems end in a line from `ahp` that names the fix. This page is for when that line is not enough. Each entry
gives the symptom (what `ahp` printed), the cause and the command to run. `ahp doctor` is the first thing to run
whenever a tool is involved: it reports Node, git and each coding agent tool, whether it is logged in, and how to
install or log in to the ones that are not.

## Before a run starts

### "no coding agent tool is usable here"

**Cause:** none of Claude Code, Codex CLI or OpenCode is installed, logged in and supported by this build of AHP.
`ahp doctor` says which of these it is for each tool.

**Fix:** install one and log in with your own account:

| Tool | Install | Log in |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | run `claude` and type `/login` |
| Codex CLI | `npm install -g @openai/codex` | `codex login` |
| OpenCode | `npm install -g opencode-ai` | `opencode auth login` |

`ahp demo`, or `--mock` on a task, shows the flow with scripted agents, which do none of the work.

### "git does not know who you are"

**Cause:** AHP offered to make a repository or a first commit, and git has no name and email to commit as. AHP checks
this before it asks, so nothing was changed.

**Fix:**

```sh
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

### "this project names no command that checks the work"

**Cause:** AHP looked at your repository's root for, in order: a `test` script in `package.json` (other than npm's
placeholder), then `pyproject.toml`, `pytest.ini` or a `tests/` folder (`pytest`), `Cargo.toml` (`cargo test`), `go.mod`
(`go test ./...`) and a `Makefile` with a `test` target (`make test`), and found none. It reads
those files only and runs nothing to find out.

**Fix:** name the command: `ahp "<task>" --check "npm run test:unit"`. In a terminal AHP asks instead, and also offers
"none: review only", which the summary and the receipt then label **not verified**.

### "the check already fails on your last commit"

**Cause:** after you choose Run, AHP runs the check once on your last commit, before any agent starts. It failed. Two
cases:

- **The command cannot run** (the line says "is not recognized", "command not found" or similar): the check's tool is
  not installed or not on `PATH`. Every attempt would fail the same way, so fix this first, or pass the right command
  with `--check`.
- **The tests fail:** often that is the task itself (a bug with a failing test). Answer "Run it anyway?" with yes; the
  agents are asked to make the check pass.

`--no-precheck` skips this run of the check.

### "... is your home folder, not a project" / "the git repository around ... is your home folder"

**Cause:** AHP was started in your home folder, or in a folder whose git repository is your home folder (some people
keep their home folder under git). That is rarely the project you mean.

**Fix:** `cd` into the project's folder, or pass `--repo <dir>`. If the home repository really is the one you mean,
pass `--repo` naming it.

### "publishes to the remote ..., which this repository does not have"

**Cause:** `--push` (which means `origin`) or `--push <remote>` names a remote the repository lacks. AHP checks this
before any agent runs.

**Fix:** `git remote add origin <url>`, or leave out `--push`: the approved work then goes on a local branch
`ahp/<task>`.

### "unknown command: ... (a task is one argument, in quotes ...)"

**Cause:** the task's words were given without quotes, so they arrived as separate arguments. AHP never reads them as
a task, so a misspelt command never starts agents.

**Fix:** put the whole task in quotes: `ahp "fix the cart total"`.

## During a run

### A step stops with "to log in: ..."

**Cause:** the tool's login expired, or its quota, usage limit or payment ran out, during the run. AHP classes this as
a configuration problem and does not retry it: another attempt would fail the same way and spend the step's budget.

**Fix:** run the login command the line names (the table above has all three), or wait for your plan's limit to reset,
then start the task again.

### "the attempt ran for ... (the step's timeout.totalMs)" / "printed nothing for ... (the step's timeout.idleMs)"

**Cause:** an attempt ran past its limit: 20 minutes in all, or 10 minutes without printing anything, by default. AHP
stopped the agent and every process it started.

**Fix:** a task run has no flag for the limits. Save the workflow with `--save task.workflow.mjs`, raise the step's
`timeout: { totalMs, idleMs }` in the file (0 turns a limit off), and run it with `ahp run task.workflow.mjs`.

### A rate limit

**Cause:** the tool reported a rate limit or another passing error (a timeout, a 5xx). AHP retries it on its own, up to
five times, waiting 2, 4, 8, 16 and 32 seconds, and at most two minutes in all.

**Fix:** none while it is retrying. If the step still fails, wait and start the task again.

### The run stopped with exit code 3, or `ahp runs` says "recover"

**Cause:** AHP's process stopped mid-run (a crash, a closed terminal, a reboot), or an attempt ended with no record of
how (`unknown`). AHP never retries an `unknown` attempt on its own, because its agent may have done something.

**Fix:** `ahp runs` names the command for each run that waits. Usually:

```sh
ahp recover <run-id>                          # pick the run up where its ledger left off
ahp recover <attempt-id> --policy adopt       # check what the unknown attempt left as its result
ahp recover <attempt-id> --policy abort       # end that step instead
```

`ahp inspect <run-id>` shows the recovery report: what the attempt was doing and, for OpenCode, its last tool
calls.

### "lock held by PID ... on ..."

**Cause:** another `ahp` process is writing this run's ledger: one run is written by one process at a time.

**Fix:** wait for that process, or stop it. If it is already gone (its PID no longer runs), the lock is stale:
`ahp recover <run-id>` takes it over and records the old owner in the ledger.

## Windows

### A path too long ("Filename too long", `ENAMETOOLONG`)

**Cause:** Windows limits paths to 260 characters unless long paths are turned on. AHP's own worktrees, under
`%LOCALAPPDATA%\ahp\worktrees`, set git's `core.longpaths`, so git itself copes there. Your project's install or tests
can still fail on a deep `node_modules`.

**Fix:** turn long paths on for your own checkout, `git config --global core.longpaths true`, and for Windows itself
(as administrator, then sign out and in):

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
```

### A locked file (`EBUSY` or `EPERM`)

**Cause:** another program holds a file open that AHP needs: an editor or a terminal opened inside one of AHP's
worktrees, an antivirus scan, or a search indexer. AHP retries its ledger's file operations briefly on Windows; a lock
held longer than that fails the command.

**Fix:** close what holds the file (a terminal whose current folder is inside `%LOCALAPPDATA%\ahp\worktrees` is the
usual one), then `ahp recover <run-id>` if a run was stopped.

### A task with double quotes in it loses them

**Cause:** Windows PowerShell 5.1 drops double quotes inside an argument when it starts a program; PowerShell 7.3 and
later passes them as typed. Measured on 2026-10-31 with Windows PowerShell 5.1.26100 and PowerShell 7.6.9:

| You type | PowerShell 7.6 passes | Windows PowerShell 5.1 passes |
|---|---|---|
| `ahp 'fix the "total" bug'` | `fix the "total" bug` | `fix the total bug` |
| `ahp 'fix the \"total\" bug'` | `fix the \"total\" bug` | `fix the "total" bug` |
| `ahp "fix the cart's total"` | `fix the cart's total` | `fix the cart's total` |

**Fix:** in Windows PowerShell 5.1, write `\"` for each double quote inside the task, or leave the quotes out (the
agent reads the task as words). In PowerShell 7, put the task in single quotes and type the double quotes as they are.
An apostrophe is safe in both inside double quotes.

## Still stuck

`ahp inspect` (the newest run, or `ahp inspect <run-id>`) prints the receipt, then every attempt with its error, its
check's output and the review's findings. Each attempt's raw transcript is kept under the run's folder in
`<repository>/.git/ahp/runs/<run-id>/transcripts/`. If you open an issue, describe what you ran and what `ahp` printed;
leave out your credentials and any private code.
