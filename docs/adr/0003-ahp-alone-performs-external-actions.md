# Only AHP performs external actions; no deploy in release 1

Push, PR and merge are performed only by AHP, after verification and an approval gate, checking current state first so they are idempotent. Coding agents are instructed, and configured where the tool allows, not to perform them; when one is seen to have done so, verification fails with `forbidden_external_action_detected`. Detection is partial (a push through `gh api` or another URL leaves no local trace), so its absence is never reported as proof. Deploy, which the original deck gated, is out of scope for release 1. Evaluation runs have no approval gates and perform no external actions.

A step's network stance governs only the coding agent's own tool use (web fetch and search, shell network), never its connection to its model provider. The default is `deny` for every role; an implement step may opt in to package-registry access. The stance must be identical for a given task across evaluation conditions C0–C3.
