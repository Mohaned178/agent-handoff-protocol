/** The inference engines a bench measures: a closed list, like the rejection reasons. */
export const ENGINES = ["ollama", "vllm", "sglang", "tensorrt_llm"] as const;
export type EngineId = (typeof ENGINES)[number];

export const ENGINE_NAMES: Record<EngineId, string> = {
  ollama: "Ollama",
  vllm: "vLLM",
  sglang: "SGLang",
  tensorrt_llm: "TensorRT-LLM",
};

export const isEngineId = (value: unknown): value is EngineId => typeof value === "string" && (ENGINES as readonly string[]).includes(value);

/**
 * Where each engine says its own version, tried in order on the engine's origin (not under `/v1`); the first JSON answer
 * with a string `version` is the one recorded. An engine none of them answers is recorded with no version, never a guess.
 */
export const VERSION_PATHS: Record<EngineId, readonly string[]> = {
  ollama: ["/api/version"],
  vllm: ["/version"],
  sglang: ["/version", "/get_server_info"],
  tensorrt_llm: ["/version"],
};
