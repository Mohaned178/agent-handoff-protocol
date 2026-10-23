# 07: Cancellation and the shared process layer

**What to build:** Ctrl+C on `ahp run` cancels the current attempt safely on every OS. All adapters launch agents through one shared process layer that resolves real executables, passes prompts safely, and kills whole process trees.

**Blocked by:** 01

**Status:** ready-for-agent

**Model:** Opus 5.5 · high

- [ ] Executables are resolved to the real binary; `.cmd` shims are never run through a shell
- [ ] Prompts are passed via stdin or file, never as shell arguments; a test with shell metacharacters in the prompt proves no injection
- [ ] Cancel uses the transport's graceful path when the adapter declares one; otherwise graceful signal → grace period → process-tree kill, and on Windows a forced tree kill
- [ ] `cancelled` is recorded only after termination is confirmed, and records graceful vs forced
- [ ] An unconfirmed kill makes the attempt `unknown`
- [ ] Mock adapter can be scripted to hang and to spawn child processes; tests prove no orphans remain on all three CI OSes

## Implementer notes

- Launch with execa and `shell: false` always.
- Resolving on Windows: search `PATH` with `PATHEXT`. If a real `.exe` exists, use it. If only an npm `.cmd` shim exists, parse the shim to find the JavaScript entry point and run it with the current Node executable (`process.execPath`). If neither works, fail with a clear message that `ahp doctor` also shows. Never run a `.cmd` through `cmd.exe`.
- POSIX: start the agent in its own process group (detached), send SIGTERM to the group, wait the grace period, then SIGKILL the group.
- Windows: `taskkill /PID <pid> /T /F`, then confirm every process in the tree has gone before recording `cancelled`; record `forced: true`.
- Confirmation: poll until the PIDs are gone, up to a timeout; if they don't disappear, the attempt becomes `unknown`.
- Test with a mock script that spawns a grandchild which ignores signals; assert no process from the tree survives, on all three CI OSes.
- Test prompt passing with a prompt containing `& | ; $() " '` and newlines; assert the agent receives it byte-for-byte via stdin and nothing executes.
