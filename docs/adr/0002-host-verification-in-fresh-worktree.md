# Verification runs on the host in a fresh verification worktree

After an attempt's process exits, AHP snapshots its workspace into a commit and runs verification in a fresh verification worktree built from that commit, not in the agent's live worktree. Hidden tests are introduced only at verification time, the verification command comes from the workflow definition, and any change to a protected path (hidden tests, test runner config, test scripts, CI config) fails verification. We chose the host over containers for release 1 because a container requirement would hurt Windows support and the pilot schedule; the cost is that verification executes agent-written code on the host, which the docs must state plainly. Containers are an optional mode after release 1.

## Consequences

- Ignored files (build outputs) do not carry into verification; dependencies are installed fresh per verification.
- Agent-written tests are allowed but never count toward verification.
