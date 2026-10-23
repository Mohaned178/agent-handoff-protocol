# An artifact hash is the hash of committed content, never working-tree bytes

An artifact's hash is SHA-256 over its committed (normalized) git blob content, not over the bytes in a working tree. Git on Windows commonly converts LF to CRLF on checkout, so a raw-bytes hash of the same artifact differs between Windows and Linux, and every cross-OS handoff would be rejected with "artifact hash mismatch" for a reason unrelated to the agents. AHP-created worktrees also enable `core.longpaths`, because nested worktrees quickly exceed Windows' default 260-character path limit.
