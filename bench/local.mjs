// The bench file of the real run (spec D1/D2): all four engines of bench/engines/ on the maintainer's machine (RTX 4060 with
// 8 GB), one model everywhere, all four workloads, the defaults for the rest. One engine fits 8 GB at a time, so run it once per
// engine, starting that engine first from bench/engines/:
//
//   ahp bench bench/local.mjs --engine vllm --out bench/results/<date>
//
// then combine the directories it made with `ahp bench report <dir>...`. An engine that is not running is recorded unavailable,
// with its error, never left out.

export default {
  name: "local",
  engines: [
    { engine: "ollama", baseURL: "http://localhost:11434/v1", model: "qwen2.5-coder:7b-instruct-q4_K_M", quantization: "q4_K_M" },
    { engine: "vllm", baseURL: "http://localhost:8001/v1", model: "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ", quantization: "awq", container: "ahp-vllm" },
    { engine: "sglang", baseURL: "http://localhost:8002/v1", model: "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ", quantization: "awq", container: "ahp-sglang" },
    { engine: "tensorrt_llm", baseURL: "http://localhost:8003/v1", model: "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ", quantization: "awq", container: "ahp-tensorrt-llm" },
  ],
  prompts: "prompts",
  tools: "tools",
  workloads: ["latency", "throughput", "quality", "tools"],
};
