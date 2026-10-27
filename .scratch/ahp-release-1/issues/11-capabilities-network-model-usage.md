# 11: Capabilities, network stance, model and usage reporting

**What to build:** Adapters declare what they can apply on each OS and how strongly; steps request capabilities and a network stance; the runtime rejects handoffs that cannot be satisfied and every report shows the enforcement level actually applied, the requested vs reported model, and usage labelled with its source.

**Blocked by:** 02

**Status:** done

**Model:** Sonnet 5.5 · high

- [x] Adapter contract static declaration: transport kind, model reporting level (enumerable / pass-through / not exposed), graceful cancel support, capabilities with enforcement level per OS, required login kind
- [x] Steps declare capability requests and a network stance (default `deny`; implement may opt in to package registries)
- [x] Rejection reason "capability unsatisfiable at the required enforcement level on this OS"
- [x] Each attempt records applied capabilities with `enforced_by_tool | cooperative | none`; reports show them
- [x] Each attempt records `requested_model` and `reported_model` (`unknown` when not reported)
- [x] Usage is recorded only when the adapter reports it, with its source; never estimated
- [x] Docs and messages never describe prompt instructions or ACP permission requests as enforcement

## Comments

2026-10-27, implementation notes.

**Decisions the ticket left open. Each with a recommendation; answer "do recommendation" to adopt them all:**

1. **Three capability kinds, a closed list: `read_only`, `write_scope { paths }` and `no_external_actions`.** The ticket names none ("e.g. write only under a path" is the spec's one example); these are the ones the design doc's reference scenario needs (a plan or review step that changes nothing, an implement step kept to its paths, and ADR 0003's "agents are configured not to push"). Each kind at most once per step; `read_only` with `write_scope` is a contradiction and refused. Adding a kind is a protocol change, and every adapter's declaration must then state it. *Recommended: keep.*
2. **A request carries the weakest enforcement level it accepts (`require`), which is what "unsatisfiable at the required enforcement level" compares against.** A capability the workflow lists defaults to `cooperative` (the adapter must at least ask the agent: a workflow that lists a capability wants it, and an adapter that cannot even ask is rejected rather than the run going on without it). The network stance defaults to `none`, and so does the baseline in decision 5, so that neither can reject a handoff unless the workflow raises the bar: no tool can block the network use of every shell command, so a stricter default would reject every real adapter. The order is `none < cooperative < enforced_by_tool`. *Recommended: keep.*
3. **The applied level is the adapter's declared level for the running OS, resolved by the runtime and recorded in `attempt_created` before the agent starts. It is not an observation of the tool.** Reports say "as the adapter declares them", and say what each level means. An adapter that cannot apply a capability must fail the attempt (throw from `startAttempt`) rather than apply it more weakly, and ticket 12's conformance suite is what checks that a declaration holds. The alternative, `startAttempt` returning the levels it actually reached, would let an adapter degrade at run time and have the report show it; it can be added without changing the declaration when the first real adapter (ticket 15) shows it is needed. *Recommended: keep the declared level.*
4. **`UsageReport.source` is a required, non-empty free-form string, not a closed list.** Which sources exist is not known until the transport spike (ticket 14); a closed list now would invent them. A report with no source, a negative or non-finite number, or no number at all is not recorded (`isUsageReport`), rather than repaired. Fields are `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens` and `cost { amount, currency }`, each null when not reported (never 0), and AHP never totals them or derives one from another. *Recommended: keep.*
5. **Every agent step carries a baseline `no_external_actions`, with `require: none`: it is reported, never a reason to reject.** ADR 0003 says agents are instructed and, where possible, configured not to push; ticket 10 left that to this ticket and to the adapters (15 to 19). This ticket gives each adapter a place to declare how strongly it can do so, and the report a line saying how strongly it was asked. Rendering the instruction into a prompt, or writing the deny rule, is each adapter's. *Recommended: keep.*
6. **The network stance is a closed list, `deny` (default) and `package_registries`, and is not restricted by step.** "Implement may opt in" is a name in the ticket, not a step kind the workflow has. It covers the agent's own tool use only, never its connection to its model provider, and is applied at the level the adapter declares, reported beside the capabilities. *Recommended: keep.*
7. **`PROTOCOL_VERSION` stays `0.1.0`.** The handoff gained required `capabilities` and `network`, as tickets 04, 09 and 10 added evidence kinds without a bump; nothing is published, and the protocol stays 0.x until two real adapters have run. Replay reads the new event fields with `?? null`, so a ledger written before this ticket still replays and inspects (an attempt in one shows "capabilities: not recorded"), though it cannot be run again. *Recommended: keep.*
8. **The operating system is injectable (`ExecuteRunOptions.platform`, default `process.platform`, also on resume and recover), but not an SDK `runWorkflow` option.** Tests need it to see one adapter's levels differ by OS on any runner; a user has no reason to run as another OS. `validateHandoff` takes a `platform` option for the same reason. A platform outside `win32`/`darwin`/`linux` reads as `none` rather than throwing. *Recommended: keep.*
9. **The mock adapter declares `cooperative` for every capability and `none` for the network, and does nothing about what it is told.** A script may do what it was asked not to (ticket 10's tests rely on a mock agent that pushes), so it must not claim more. Its usage is labelled "mock script (scripted, not measured)". Tests that need `enforced_by_tool` or a per-OS difference wrap `mockAdapter` with another `declaration` and pass it to `executeRun`'s `adapters`, as `test/cancel.test.ts` does for its own wrappers. *Recommended: keep.*
10. **A cancelled attempt records the model and usage its adapter reported, if it reported any.** The cancel discards the agent's reported output, not what the tool measured. The mock reports none for a killed agent. *Recommended: keep.*

**Shapes:**

- Protocol (`src/protocol/capabilities.ts`, new): `ENFORCEMENT_LEVELS`, `meetsLevel`, `CAPABILITY_KINDS`, `NETWORK_STANCES`, `OPERATING_SYSTEMS`, `LevelsByOs`, `levelOn`, `sameOnEveryOs`, `TRANSPORT_KINDS` (`acp`, `sdk`, `headless`, `mock`), `MODEL_REPORTING_LEVELS`, `LOGIN_KINDS` (`none`, `tool_login`, `api_key`), `UNKNOWN_MODEL`, `UsageReport`, `isUsageReport`. `HANDOFF_REJECTION_REASONS` gains `capability_unsatisfiable`; the handoff has `capabilities` (`CapabilityRequestSchema`) and `network` (`NetworkRequestSchema`), published in the regenerated schema. `StepDefinition` has `capabilities` and `network`; `AppliedCapabilities` is in `attempt_created`, `reportedModel` and `usage` in `attempt_exited`; `AttemptView` has `usage` and `capabilities` beside `reportedModel`.
- Adapter contract: `AdapterDeclaration` is complete and static (`transport`, `modelReporting`, `login`, `gracefulCancel`, `capabilities`, `network`); `AttemptInput.capabilities`; `AttemptExit.reportedModel` and `.usage` (required, so an adapter says null).
- Runtime: `src/runtime/capabilities.ts` (`requestsOf`, `resolveCapabilities`, `currentPlatform`); `validateHandoffRevision` takes the recipient (`HandoffRecipient`), and an adapter that does not exist is `unmet_dependency` at `/to/adapter`.
- Mock adapter: `reportedModel` and `usage` in an attempt script.
- `ahp inspect`: per attempt, the capabilities and network with their levels and what each level means, the requested and reported model (noting a difference), and the usage with its source or "not reported by the tool (none is estimated)". The handoff dump already shows the requests.

**Not done:**

- A pre-flight check of every step's handoff against its adapter at run start. A request one adapter cannot satisfy is found when that step's handoff is validated, so earlier steps have already run (and cost something). The ticket asks for the runtime to reject handoffs; a pre-flight over `validateWorkflow` plus the declarations could be a later ticket.
- Telling a coding agent what it may not do (the prompt text, the deny rules and hooks) is each real adapter's (15 to 19); so is checking that a declaration holds (12). `ahp doctor` showing the declared levels per OS is ticket 13.
- Totals of usage per step or run, and comparing it across tools, are the evaluation's (20 and 21); nothing here sums it.
- The side-effect class of a step (`workspace_only` / `may_have_external_effects`, spec story 15) is still not part of any ticket so far.

**After review (code-review against this ticket and the repo's standards):**

- Fixed: the mock declared `cooperative` but was never told anything; its agent now receives what the adapter asks of it (and logs that it did not act on it), which is all `cooperative` means. A usage report the runtime does not record (no source, a negative number, nothing reported) was shown as "not reported by the tool", which could be false; `ahp inspect` now says "none recorded: the adapter reported none it could vouch for". The reported model is recorded as the tool said it (no trimming; only a blank is `unknown`). The mock's usage check reuses `isUsageReport`; a duplicated `kinds` computation in the handoff schema.
- Left as they are, on purpose: an accepted handoff that can no longer be satisfied when its attempt is created (the system or adapter changed since) throws before recording anything, as does an attempt in a pre-ticket ledger; the lock is per host, so the system cannot change under a resume in practice, and a run that cannot go on at the required level should say so loudly. A `capability_unsatisfiable` rejection is `rejected` and never rerouted, as for any rejection. `LOGIN_KINDS` and `TRANSPORT_KINDS` are new closed lists the ticket's "transport kind" and "required login kind" need. The levels in a report are declared, not observed, until ticket 12 checks them, and nothing yet detects a `write_scope` or `read_only` violation, so `cooperative` is a request only; the report and glossary say so.

**Confirmed by the maintainer on 2026-10-27 ("yes", to recording "do recommendation"): decisions 1 to 10 above stand as recommended; reopen one only with a new decision.**

First green CI run: GitHub Actions run 40423048506 (commit a4053ba). 409 tests passed on Linux and macOS (1 skipped: the signal test). Windows had 407 passed and 3 skipped: the signal test, the POSIX resolution test and the Ctrl+C CLI test.
