# 02: Bench quality, tool calls, report and `ahp bench`

**Implement with:** Sonnet 5.5, effort high

**What to build:** Score each engine's answers to small coding prompts by tests and its tool calls by an expected call,
report everything per engine with counts and paired comparisons, and add the `ahp bench` command.

**Blocked by:** 01

**Status:** open

- [ ] `bench/prompts/<id>/`:
  - `prompt.md` and `test.mjs` (`node --test`)
  - the code block of the answer written to a temp dir and tested
  - pass, fail or `no_code`
- [ ] `bench/tools/<id>.json`: the tool schemas, the prompt, and the expected name and arguments. Each answer is scored
      `valid_call`, `wrong_tool`, `bad_arguments`, `no_call` or `malformed`
- [ ] Report (`report.json`, `report.txt`), per engine:
  - TTFT and latency at p50, p95 and p99
  - throughput at each concurrency
  - GPU peak and mean
  - quality and tool-call rates with counts
  - pairs of engines compared per prompt (`comparePaired`)
- [ ] `ahp bench <bench-file> [--out <dir>] [--seed <n>] [--json]`, `runBench` in the SDK
- [ ] Tests: scoring tables, report, CLI
