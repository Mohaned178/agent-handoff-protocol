import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli/main.ts";
import { answerOf, closeEngines, fakeEngine, promptFiles, toolCaseFiles, toolsEnv } from "./helpers/bench.ts";
import { closedBaseURL } from "./helpers/fake-engine.ts";
import { evaluate, GREETS, greetingTaskDir, scripted, suiteOf } from "./helpers/evaluation.ts";
import { removeTempRepos, writeTree } from "./helpers/repo.ts";

// `ahp bench` looks for `nvidia-smi` and `docker` on PATH: never the real ones in a test.
let saved: { PATH?: string; Path?: string };
beforeAll(async () => {
  saved = { PATH: process.env.PATH, Path: process.env.Path };
  // The fake tools come first, so they shadow any real `nvidia-smi` or `docker`; the rest of PATH stays, since the process layer
  // finds PowerShell there to stop a process tree on Windows.
  const env = await toolsEnv();
  const path = [env.PATH!.split(delimiter)[0]!, saved.PATH ?? saved.Path ?? ""].join(delimiter);
  process.env.PATH = path;
  if (process.platform === "win32") process.env.Path = path;
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  if (process.platform === "win32") process.env.Path = saved.Path ?? saved.PATH;
});
afterEach(async () => {
  await closeEngines();
  removeTempRepos();
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function ahp(args: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await main(args, io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** A bench file beside its prompts and tool-call cases, as a person lays them out: they are named relative to the file. */
async function benchDir(engines: { engine: string; baseURL: string }[], extra: Record<string, unknown> = {}): Promise<string> {
  const file = {
    name: "cli bench",
    engines: engines.map(({ engine, baseURL }) => ({ engine, baseURL, model: "fake-model", quantization: "awq" })),
    prompts: "prompts",
    tools: "tools",
    workloads: ["quality", "tools"],
    repeats: 1,
    maxTokens: 64,
    warmup: 0,
    timeoutMs: 10_000,
    ...extra,
  };
  return writeTree({ "bench.mjs": `export default ${JSON.stringify(file, null, 2)};\n`, ...promptFiles({}, "prompts/"), ...toolCaseFiles("tools/") });
}

describe("ahp bench", () => {
  it("runs the bench from the directory of its file, streams what happens, prints the report, keeps the ledger and the report, and exits 0", async () => {
    const engine = await fakeEngine({ chat: (body) => answerOf(body, { wrong: ["sub"] }) });
    const dir = await benchDir([{ engine: "vllm", baseURL: engine.baseURL }]);
    const out = writeTree({});

    // The prompts are found beside the bench file, not in the working directory.
    const { code, stdout, stderr } = await ahp(["bench", join(dir, "bench.mjs"), "--out", out, "--seed", "5"]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain('"cli bench", vLLM; 2 workloads scheduled in a shuffled order (seed 5)');
    expect(stdout).toContain("vLLM: serves its model");
    expect(stdout).toMatch(/vLLM quality, repeat 1 of 1: 3 of 3 requests ok in [\d.]+ s; pass 2, fail 1/);
    expect(stdout).toMatch(/vLLM tools, repeat 1 of 1: 2 of 2 requests ok in [\d.]+ s; valid_call 2/);
    expect(stdout).toContain("quality: pass 2/3 (66.7%); fail 1");
    expect(stdout).toContain("bench completed");
    const [id] = readdirSync(out);
    expect(existsSync(join(out, id!, "ledger.jsonl"))).toBe(true);
    expect(readFileSync(join(out, id!, "report.txt"), "utf8")).toContain("quality: pass 2/3 (66.7%)");
    expect(stdout).toContain(`kept in ${join(out, id!)}`);
  });

  it("with --json prints only the report", async () => {
    const engine = await fakeEngine({ chat: (body) => answerOf(body) });
    const dir = await benchDir([{ engine: "vllm", baseURL: engine.baseURL }], { workloads: ["quality"] });

    const { code, stdout } = await ahp(["bench", join(dir, "bench.mjs"), "--out", writeTree({}), "--json"]);

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.engines[0]).toMatchObject({ engine: "vllm", available: true, quality: { passes: 3, scored: 3 } });
  });

  it("runs one engine of the file with --engine and does not look at the others", async () => {
    const vllm = await fakeEngine({ chat: (body) => answerOf(body) });
    const dir = await benchDir([
      { engine: "vllm", baseURL: vllm.baseURL },
      { engine: "sglang", baseURL: await closedBaseURL() },
    ], { workloads: ["quality"] });

    const { code, stdout } = await ahp(["bench", join(dir, "bench.mjs"), "--engine", "vllm", "--out", writeTree({})]);

    expect(code).toBe(0);
    expect(stdout).toContain("engine vllm only");
    expect(stdout).not.toContain("SGLang");
  });

  it("exits 1, with the engine's error in the report, when nothing could be measured", async () => {
    const dir = await benchDir([{ engine: "ollama", baseURL: await closedBaseURL() }], { workloads: ["quality"] });

    const { code, stdout, stderr } = await ahp(["bench", join(dir, "bench.mjs"), "--out", writeTree({})]);

    expect(code).toBe(1);
    expect(stdout).toContain("Ollama: UNAVAILABLE: GET http://127.0.0.1:");
    expect(stdout).toContain("UNAVAILABLE");
    expect(stderr).toContain("nothing was measured");
  });

  it("is a usage error, and writes nothing, for a bench file that is invalid, missing, or names an engine it does not list", async () => {
    const engine = await fakeEngine({ chat: (body) => answerOf(body) });
    const out = writeTree({});
    const dir = await benchDir([{ engine: "vllm", baseURL: engine.baseURL }], { speed: "fast" });
    const invalid = await ahp(["bench", join(dir, "bench.mjs"), "--out", out]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("unknown bench property `speed`");

    const missing = await ahp(["bench", join(dir, "nope.mjs"), "--out", out]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("cannot load bench file");

    const good = await benchDir([{ engine: "vllm", baseURL: engine.baseURL }]);
    const unlisted = await ahp(["bench", join(good, "bench.mjs"), "--engine", "sglang", "--out", out]);
    expect(unlisted.code).toBe(2);
    expect(unlisted.stderr).toContain("--engine sglang: the bench file does not list it");

    const badSeed = await ahp(["bench", join(good, "bench.mjs"), "--seed", "-1", "--out", out]);
    expect(badSeed.code).toBe(2);
    expect(readdirSync(out)).toEqual([]);
  });

  it("needs a bench file, and takes only one", async () => {
    expect((await ahp(["bench"])).stderr).toContain("bench needs a bench file, or `bench report <bench-dir>...`");
    expect((await ahp(["bench", "a.mjs", "b.mjs"])).stderr).toContain("unexpected argument: b.mjs");
  });

  it("is listed in the usage", async () => {
    const { stdout } = await ahp(["--help", "--all"]);
    expect(stdout).toContain("bench <bench-file>");
    expect(stdout).toContain("bench report <bench-dir>...");
    expect(stdout).toContain("--engine <id>");
  });
});

describe("ahp bench report", () => {
  /** Two benches of one file, one engine each, as the person runs them on an 8 GB GPU. */
  async function twoBenches() {
    const vllm = await fakeEngine({ chat: (body) => answerOf(body) });
    const sglang = await fakeEngine({ chat: (body) => answerOf(body, { wrong: ["sub"] }) });
    const dir = await benchDir([
      { engine: "vllm", baseURL: vllm.baseURL },
      { engine: "sglang", baseURL: sglang.baseURL },
    ]);
    const out = writeTree({});
    for (const engine of ["vllm", "sglang"]) expect((await ahp(["bench", join(dir, "bench.mjs"), "--engine", engine, "--out", out, "--seed", "3"])).code).toBe(0);
    const dirs = readdirSync(out).map((name) => join(out, name));
    return { dir, out, dirs };
  }

  it("combines the benches of several engines, prints one report, and writes it where --out says", async () => {
    const { dirs } = await twoBenches();
    const target = join(writeTree({}), "combined");

    const { code, stdout, stderr } = await ahp(["bench", "report", ...dirs, "--out", target]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("vLLM (fake-model, awq)");
    expect(stdout).toContain("SGLang (fake-model, awq)");
    expect(stdout).toContain("comparisons");
    expect(stdout).toContain("quality: vLLM (fake-model, awq) vs SGLang (fake-model, awq): mean difference +0.333");
    expect(stdout).toContain(`written to ${target}`);
    expect(readFileSync(join(target, "report.txt"), "utf8")).toContain("quality: vLLM (fake-model, awq) vs SGLang");
    expect(JSON.parse(readFileSync(join(target, "report.json"), "utf8")).engines).toHaveLength(2);
  });

  it("prints the report as JSON with --json, and takes the comparisons' seed from --seed", async () => {
    const { dirs } = await twoBenches();

    const { code, stdout } = await ahp(["bench", "report", ...dirs, "--json", "--seed", "42"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).comparisonSeed).toBe(42);
  });

  it("refuses benches made with other prompts, naming what differs, and exits 2", async () => {
    const { dirs } = await twoBenches();
    const other = await fakeEngine({ chat: (body) => answerOf(body) });
    const different = writeTree({ "bench.mjs": readFileSync(join(await benchDir([{ engine: "ollama", baseURL: other.baseURL }]), "bench.mjs"), "utf8"), ...promptFiles({ "add/test.mjs": "// another test\n" }, "prompts/"), ...toolCaseFiles("tools/") });
    const out = writeTree({});
    expect((await ahp(["bench", join(different, "bench.mjs"), "--out", out])).code).toBe(0);

    const { code, stderr } = await ahp(["bench", "report", dirs[0]!, join(out, readdirSync(out)[0]!)]);

    expect(code).toBe(2);
    expect(stderr).toContain("these benches cannot be combined");
    expect(stderr).toContain("in its prompts");
  });

  it("is a usage error for a directory that is not a bench, for none, and for --engine", async () => {
    const { dirs } = await twoBenches();
    const notABench = await ahp(["bench", "report", writeTree({})]);
    expect(notABench.code).toBe(2);
    expect(notABench.stderr).toContain("not a bench directory (it has no ledger.jsonl)");
    expect((await ahp(["bench", "report"])).stderr).toContain("bench report needs the directory of at least one bench");
    expect((await ahp(["bench", "report", dirs[0]!, "--engine", "vllm"])).stderr).toContain("--engine chooses what to run");
  });

  it("reads each --eval directory as an evaluation, refuses one that is the mock's or not an evaluation, and takes --eval only with report", async () => {
    const { dirs, dir } = await twoBenches();
    const { dir: evaluation } = await evaluate(suiteOf([greetingTaskDir()], { implement: scripted(GREETS) }, { conditions: ["C0"] }));

    const mocked = await ahp(["bench", "report", ...dirs, "--eval", evaluation]);
    expect(mocked.code).toBe(2);
    expect(mocked.stderr).toContain("ran on the mock adapter: its results are not evidence of any engine");
    const notOne = await ahp(["bench", "report", ...dirs, "--eval", writeTree({})]);
    expect(notOne.stderr).toContain("not an evaluation directory (it has no ledger.jsonl)");
    expect((await ahp(["bench", join(dir, "bench.mjs"), "--eval", evaluation])).stderr).toContain("--eval puts evaluations beside benches already made");
    expect((await ahp(["--help", "--all"])).stdout).toContain("bench report <bench-dir>... [--eval <eval-dir>]...");
  });
});
