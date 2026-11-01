import { describe } from "./client.ts";
import { VERSION_PATHS, type EngineId } from "./engines.ts";

/** What the engine check found: whether the engine serves the model, what it lists, and the version it says it is. */
export interface EngineCheck {
  /** True only when `/v1/models` answered and listed the model. */
  available: boolean;
  /** The ids `/v1/models` listed; null when it did not answer with a list. */
  models: string[] | null;
  /** The version the engine says it is (`VERSION_PATHS`); null when none of its paths answered with one, never a guess. */
  version: string | null;
  /** Why the engine is unavailable; null when it is available. */
  error: string | null;
}

export interface CheckEngineOptions {
  /** How long each of the check's requests may take (default 10000 ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const CHECK_TIMEOUT_MS = 10_000;

/**
 * Checks, before any workload, that an engine serves its model: `GET <baseURL>/models` must list it. The version is then read
 * from the engine's own paths on its origin. Never throws for what the engine or the network does; the answer says.
 * The evaluation's per-trial engine record (ticket 03) uses this too, so there is one check.
 */
export async function checkEngine(target: { engine: EngineId; baseURL: string; model: string }, options: CheckEngineOptions = {}): Promise<EngineCheck> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const listed = await getJson(`${target.baseURL}/models`, timeoutMs, options.signal);
  if ("error" in listed) return { available: false, models: null, version: null, error: `GET ${target.baseURL}/models: ${listed.error}` };
  const data = (listed.json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { available: false, models: null, version: null, error: `GET ${target.baseURL}/models did not answer with a list of models` };
  const models = data.flatMap((entry) => (typeof (entry as { id?: unknown })?.id === "string" ? [(entry as { id: string }).id] : []));
  const version = await versionOf(target.engine, target.baseURL, timeoutMs, options.signal);
  if (!models.includes(target.model)) {
    return { available: false, models, version, error: `the engine does not list the model ${target.model} (it lists: ${models.join(", ") || "nothing"})` };
  }
  return { available: true, models, version, error: null };
}

async function versionOf(engine: EngineId, baseURL: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  const origin = new URL(baseURL).origin;
  for (const path of VERSION_PATHS[engine]) {
    const answer = await getJson(`${origin}${path}`, timeoutMs, signal);
    const version = "json" in answer ? (answer.json as { version?: unknown })?.version : undefined;
    if (typeof version === "string" && version.trim() !== "") return version.trim();
  }
  return null;
}

async function getJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ json: unknown } | { error: string }> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.any(signals) });
    const text = await response.text();
    if (!response.ok) return { error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    try {
      return { json: JSON.parse(text) };
    } catch {
      return { error: "the answer is not JSON" };
    }
  } catch (error) {
    if ((error as Error).name === "TimeoutError") return { error: `timed out after ${timeoutMs} ms` };
    return { error: describe(error) };
  }
}
