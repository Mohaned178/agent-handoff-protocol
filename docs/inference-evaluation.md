# Inference evaluation

AHP can compare local inference engines (Ollama, vLLM, SGLang, TensorRT-LLM) on one model in two layers, as ADR 0007 and
`.scratch/inference-evaluation/spec.md` decided:

- **`ahp bench`** talks to each engine directly over its OpenAI-compatible API and measures latency, throughput under
  concurrency, GPU and memory use, the quality of the code it writes for small prompts, and whether its tool calls are valid.
- **`ahp eval`** runs the pilot tasks through OpenCode backed by each engine (`pilot/local/<engine>.mjs`), so "task quality"
  means *verified success*: hidden tests that no agent sees, as in [docs/evaluation.md](evaluation.md).

**No results exist yet.** Nothing in this repository claims that one engine is faster or better than another. The results
write-up, `docs/results/inference-evaluation-<date>.md`, is written only from a real run on the maintainer's machine, and
every number in it is copied from a named `report.json`. Output from a fake engine, a fake `nvidia-smi` or the mock adapter
(which the tests use) is never evidence.

AHP never starts, downloads or serves a model. You start one engine at a time from [`bench/engines/`](../bench/engines/README.md);
AHP checks that it serves the model (`/v1/models`), records its version and measures it. An engine that is not running is
recorded **unavailable, with its error**, and shown in the report; it is never left out.

## Setup

1. **Hardware.** The plan targets one GPU with 8 GB (an RTX 4060), 16 GB of RAM, Windows 11 with WSL2. One engine fits at a
   time. Run `nvidia-smi` first: the bench records the GPU, driver, CPU, RAM and OS as the *hardware fingerprint*.
2. **One model everywhere**: Qwen2.5-Coder-7B-Instruct at int4 (AWQ on vLLM, SGLang and TensorRT-LLM; GGUF Q4_K_M on
   Ollama). The quantization differs by engine, and it is recorded with every result. Read that as a limit of the comparison.
3. **Start an engine** following [`bench/engines/README.md`](../bench/engines/README.md) (Docker Compose files with pinned
   tags, Ollama natively, or a WSL2 venv for vLLM and SGLang). Check `curl <baseURL>/models` lists the model.
4. **Bench it**, with the same seed for each engine's evaluation:

   ```sh
   ahp bench bench/local.mjs --engine vllm --out bench/results/<date>/vllm
   ```

   `bench/local.mjs` lists all four engines and runs the four workloads (`latency`, `throughput`, `quality`, `tools`) with
   the defaults: concurrency 1, 2, 4 and 8; 3 repeats; `max_tokens` 512; 2 warmup requests that are never measured. `--engine`
   runs one. Ctrl+C stops the workload in hand and starts no other.
5. **Evaluate it** (optional, long; see [docs/pilot.md](pilot.md), "On a local engine"):

   ```sh
   ahp eval pilot/local/vllm.mjs --seed 20261101 --out pilot/results/<date>/vllm
   ```

   Use the same seed for every engine, so the trial order is the same.
6. Stop the engine and repeat from step 3 for the next one.
7. **Combine**:

   ```sh
   ahp bench report bench/results/<date>/ollama bench/results/<date>/vllm \
     --eval pilot/results/<date>/ollama --eval pilot/results/<date>/vllm --out bench/results/<date>
   ```

   This writes `report.json` and `report.txt`. It refuses benches made on another machine, or with other prompts or
   settings, and says which differs.

## The reproducibility checklist

A result can be reproduced only if all of this is recorded beside it. Fill it in for the run, and commit it with the data.

| What | Where it comes from |
|---|---|
| Image tags (Docker engines) | the Compose files in `bench/engines/`; they are pinned, and a tag changes only together with the bench that records it |
| Engine version | read by the bench from the engine and shown in the report (`version`) |
| Model and revision | the Hugging Face commit pinned in each Compose file and in the spike; the Ollama tag. The model id is in the bench file |
| Quantization | the bench file (`quantization`), different by engine |
| Engine flags | the Compose file or the command that started it: `--max-model-len`, `--gpu-memory-utilization`, the tool-call parser. Copy the exact command used (the spike records what each engine actually needed on 8 GB) |
| GPU driver | `fingerprint.gpu.driver` in the report |
| Hardware | `fingerprint` (GPU, memory, CPU, RAM, OS) in the report |
| Seed | `--seed` of the bench (workload and prompt order; drawn if not given, and recorded) and of each evaluation |
| Prompts and tool cases | their SHA-256 hashes are in the ledger; the report lists their ids |
| AHP version and commit | `git rev-parse HEAD` at the time of the run |
| Tool versions (evaluation) | OpenCode's version, recorded by the evaluation |

## Reading the report

`report.txt` is the report as text and `report.json` holds the same numbers; copy figures from `report.json`.

- **Percentiles** are p50 / p95 / p99, nearest-rank. With fewer than 100 values, p99 is the slowest of them.
- **Time to first token** and **request latency** are per request. The **inter-chunk gap** is the time between streamed
  chunks. A chunk is not a token, so it is never called a per-token latency.
- **Output tokens per second** is computed only from the token counts the engine itself reports in `usage`. Where an engine
  reports none, the figure is `n/a`, never a count made from chunks.
- **Throughput** is per concurrency level, as the median across repeats with the minimum and maximum beside it.
- **Quality** is the fraction of answers whose code passes the prompt's `test.mjs`. **Tool calls** is the fraction of answers
  with a valid call to the right tool with the expected arguments (a call written into the message text instead of the
  `tool_calls` field does not count as one). Both show the counts, not only a rate.
- **Resources**: GPU utilization, memory and power from `nvidia-smi`, the whole machine's memory and CPU, and the container's
  memory and CPU from `docker stats` for an engine that runs in Docker (`n/a` with the reason for one that does not).
- **UNAVAILABLE** is an engine that could not run, with the error it gave. All of its workloads are skipped, and it still
  appears in the report.
- **Verified success** (with `--eval`) is each engine's rate of trials that passed the hidden tests, per condition, with
  counts, and an engine-against-engine comparison task by task (paired bootstrap, as in [docs/evaluation.md](evaluation.md)).
  An interval that includes 0 means *no detectable difference*, not a tie.

## What a result does not tell you

- **One GPU, one model, one machine.** It says nothing about a larger model or another GPU.
- **The format differs by engine** (AWQ against GGUF Q4_K_M), so a difference may come from the quantization and not the engine.
- **Context is limited on 8 GB.** Each engine is started with a 16,384-token context; OpenCode's own prompt takes about 12k.
- **Engines differ in what they do with a long prompt**: one may truncate it silently where another refuses it. The spike
  records which.
- **A model that writes a tool call as text** gets no valid call from any engine whose parser does not read it. That is a
  property of the model's output under that parser, and the report shows it as it is.
- **A small pilot** (five to eight tasks) gives wide intervals. It measures; it does not prove.
