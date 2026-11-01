# 02: Bench quality, tool calls, report and `ahp bench`

**Implement with:** Sonnet 5.5, effort high

**What to build:** Score each engine's answers to small coding prompts by tests and its tool calls by an expected call,
report everything per engine with counts and paired comparisons, and add the `ahp bench` command.

**Blocked by:** 01

**Status:** done (2026-11-01)

- [x] `bench/prompts/<id>/`:
  - `prompt.md` and `test.mjs` (`node --test`)
  - the code block of the answer written to a temp dir and tested
  - pass, fail or `no_code`
- [x] `bench/tools/<id>.json`: the tool schemas, the prompt, and the expected name and arguments. Each answer is scored
      `valid_call`, `wrong_tool`, `bad_arguments`, `no_call` or `malformed`
- [x] Report (`report.json`, `report.txt`), per engine:
  - TTFT and latency at p50, p95 and p99
  - throughput at each concurrency
  - GPU peak and mean
  - quality and tool-call rates with counts
  - pairs of engines compared per prompt (`comparePaired`)
- [x] `ahp bench <bench-file> [--engine <id>] [--out <dir>] [--seed <n>] [--json]`, `runBench` in the SDK
- [x] `ahp bench report <bench dir>...` combines the benches of several engines into one report, refusing two
      different hardware fingerprints, prompt sets or settings (they would not be comparable). Ticket 03 adds `--eval`
- [x] `bench/local.mjs`: the bench file of the real run, listing all four engines with the ports and models of
      `bench/engines/`, all four workloads and the defaults
- [x] Tests: scoring tables, report, CLI

## Implementation notes (2026-11-01)

1. **A bench file that names no workloads runs `latency` and `throughput` only** (`DEFAULT_WORKLOADS`), not "every
   workload". `quality` needs a `test.mjs` beside every prompt and `tools` needs a directory of cases, so defaulting to
   them would make a plain bench file invalid. `bench/local.mjs` names all four. Reason: ticket 01's files and tests keep
   their meaning, and nothing is run that the file did not ask for.
2. **`quality` tests every prompt: a prompt without `test.mjs` is a problem** (`BenchInvalidError`, before anything is
   written), not a prompt skipped. A silent partial score would read as the whole prompt set. A bench that only times the
   prompts needs no tests. `tools` needs the new bench-file key `tools` (a directory, resolved like `prompts`) and every
   case valid; a missing or empty directory, bad JSON, an unknown key or an `expect.name` that none of the case's tools
   carries is a problem.
3. **Tool-call cases are `bench/tools/<id>.json` with their own ids**, kept apart from the prompts' (a `ScheduledWorkload`
   of `tools` lists case ids; `runWorkload` takes a separate `toolCases` map), so a prompt and a case with the same id are
   never mixed in the report. `bench_created` gained `prompts[].testSha256` and `toolCases` (both additive, read with
   `?? null` / `?? []`, `BenchView.prompts[].testSha256` and `.toolCases`), and `BenchView.request`, so a report can tell
   two benches to have used the same files, tests and cases by SHA-256, read once.
4. **`quality` and `tools` run at concurrency 1, each id once per repeat.** Ticket 01 treated "not latency" as
   "throughput" in `scheduleOf`, `requestsOf` and `runWorkload`'s worker count; all three now branch on `throughput`
   (`workersOf`), and a test pins that the other three never get the sweep or the cycling. The shuffle draws for a bench
   with only `latency` and `throughput` are unchanged.
5. **Scoring runs after the workload has ended and its sampling has stopped** (`scoreWorkload`), so the node processes that
   run the tests are not in the workload's GPU or host figures. Only a request that ran to `[DONE]` is scored: an engine
   error (HTTP status, timeout, a rejected `tools` field) is recorded as an error with `score: null`, never as `fail` or
   `no_call`, and the report keeps errors beside every rate, outside its denominator. The score is `{ outcome, detail
   (at most 300 characters: the first failing test line, the call that was made), codeSha256 }`; the answer's text is
   still not recorded. If the harness itself fails (no temporary directory, `node` does not start) the request has
   `score: null` and `scoreProblem` says why: no new outcome value was added. After a cancel, answers still unscored get
   `scoreProblem: "not scored: the bench was cancelled"`.
6. **Edge cases, pinned in `test/bench-scoring.test.ts`.**
   - *Code:* the first fenced block that is JavaScript (no language, `js`, `javascript`, `mjs`, `node`) is taken; a block
     in another language is not code. A block the answer never closes is run as far as it goes, with a detail saying the
     answer was cut off (`finish_reason: length`) or never closed. No block is `no_code`; a test run that outlives its
     limit (20 s, an option so tests use 400 ms) is `timed_out` with the tree stopped.
   - *Tools:* only the first call is scored (the detail says how many there were). In order: no call is `no_call`; a call
     with no name, or arguments that are not a JSON object (an empty text counts as `{}`), is `malformed`; another tool's
     name is `wrong_tool`; an expected argument missing or unequal (deep equality; extra arguments allowed) is
     `bad_arguments`; else `valid_call`. Malformed comes before the name is compared: an unreadable call is not a call
     to any tool.
7. **Model-written code runs on the host** (`quality.ts`): `process.execPath --test --test-reporter=tap test.mjs` in a fresh
   temporary directory, from the process layer, with a time limit and `terminate()` of the tree. It is not a sandbox;
   `docs/limits.md` says so.
8. **The report is a pure function of replayed views** (`reportOf`, `report.ts`), so it is recomputed from ledgers, one
   bench or several. Percentiles are nearest-rank (rank `ceil(p/100 × n)`), stated in the text with a note that p99 of
   fewer than 100 values is the slowest; every one has its `n`. Throughput per level is the median, minimum and maximum
   over the repeats' per-workload figures (requests/s; output tokens/s only from workloads whose every request reported
   usage, with the repeat count beside it). GPU, host and container figures merge the engine's ended workloads: peak is the
   largest peak, mean is weighted by samples. Cancelled workloads are left out of the figures and counted; workloads
   never run are counted too, so a cancelled bench does not read as complete.
9. **Comparisons are only of rates**, because `comparePaired` compares them: for `quality` the share of answers that pass
   and for `tools` the share that are valid calls, per prompt (or case) as the task, engine pairs in `ENGINES` order. Prompts
   with no valid answer on a side are listed as excluded. Latency and throughput get percentiles and counts, not a
   test. The bootstrap seed is `--seed` of `bench report`, default 0 (fixed, so a report is the same every time), and
   is recorded in `report.json` (`comparisonSeed`).
10. **Combining benches.** A report holds each engine once (the same engine in two benches is refused: it would be
    ambiguous which to report), and refuses benches whose hardware fingerprint (GPU, CPU, RAM, OS; not why a read failed),
    prompt files and tests, tool-call cases, settings (not how often resources were sampled) or request settings differ,
    listing every difference (`BenchesNotComparableError`; exit 2). `runBench` writes `report.json` and `report.txt` for
    its own bench beside the ledger (best effort); `bench report` prints and, with `--out`, also writes them.
11. **CLI.** `bench` is in `COMMANDS`; `bench report <dir>...` is read before `main`'s one-target rule, since it takes
    several directories. `--engine` is a new option, `--out` for `bench` is the directory the bench's own is made in (as for
    `eval`), `--seed` is the schedule's seed (the comparisons' for `report`). Exit: 0 completed with something measured,
    130 cancelled, 1 stopped on an error **or completed with nothing measured because no engine was available** (the
    report still lists each with its error; a script otherwise could not tell an empty bench from a good one).
12. **SDK.** `src/index.ts` exports `runBench`, `readBench`, `validateBench`, `benchReportOf` (`reportOf`, renamed so it is not
    taken for the evaluation's), `formatBenchReport`, the errors, `WORKLOADS`, `ENGINES`, the outcome lists and the main
    types; the rest of `src/inference/` stays inside.
13. **The shipped bench is tested without a GPU.** Eight prompts (`fizzbuzz`, `palindrome`, `roman`, `flatten`,
    `group-by`, `parse-duration`, `lru-cache`, `merge-intervals`) each with a `test.mjs`, and a reference solution under
    `bench/reference/<id>/solution.mjs` that must pass and a stub that must fail; five tool-call cases; `bench/local.mjs`
    validated against them and against the ports and `container_name`s of `bench/engines/`. The reference solutions are for
    the test and are never sent to an engine.
14. **For the maintainer (ticket 00's spike owns it):** `vllm.yml` has `--enable-auto-tool-choice --tool-call-parser` and
    `sglang.yml` has `--tool-call-parser`; Ollama calls tools natively; `tensorrt-llm.yml` says whether tool calls are
    parsed is still to be found out. If it does not parse them, its `tools` workload will come back as `no_call` or as
    request errors; that is a finding to record, not something to hide. No compose file was edited.
15. **Test speed.** Each workload stops its sampling `nvidia-smi` with a process-tree kill, which costs a second or more on
    Windows, so `test/bench-report.test.ts` makes four benches once and shares them, and checks the refusals by changing a
    view in memory. `test/cli-bench.test.ts` calls `main` in-process with the fake tools first on PATH and the rest of PATH
    kept (the process layer finds PowerShell there).
16. **Stopping a test run is checked, not assumed** (found in review). The limit and a cancel both start one stop of the test
    run's process tree; its `Termination` is read, a `terminate` that rejects is caught (never an unhandled rejection that
    would end the bench with no `bench_ended`), and a tree not seen gone is `score: null` with a problem rather than a wait
    without end (`STOP_CONFIRM_MS` 5 s, then at most 2 s for the pipe). Only a confirmed stop gives `timed_out`.
17. **A cancel while answers are being scored cuts the workload short.** `scoreWorkload` returns `cutShort` when a cancel left an
    answer unscored (before its tests ran, or by stopping them), and `workload_ended.cancelled` is
    `measured.cancelled || cutShort`. Without it the workload was recorded complete, and its partial scores would have entered
    the pass rate and the per-prompt comparison; a cancelled workload is left out of the report and counted.
18. **A comparison names what each side served.** `PairComparison.served` and the text line give the model and quantization of
    both engines (`vLLM (Qwen/..., awq) vs Ollama (qwen2.5-coder:..., q4_K_M)`): the engines serve different artifacts (D2), so a
    difference is not an engine effect alone and the report does not read as one.
19. **Checked from the build.** `npm run build`, then `node bin/ahp.mjs bench` (usage error, exit 2), `--help --all` (lists
    `bench`) and `bench bench/local.mjs --engine vllm` with nothing listening (the real `nvidia-smi` fingerprint, every workload
    skipped with the connection error, exit 1 "nothing was measured"): the shipped file, prompts and tool-call cases load
    through the real entry point.
