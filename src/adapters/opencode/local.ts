// A local OpenAI-compatible engine as OpenCode's model provider (ADR 0007, inference-evaluation ticket 03). AHP never starts,
// downloads or serves the model: the person starts the engine (`bench/engines/`), and OpenCode reaches it through a custom
// provider that AHP adds to the attempt's inline config. Nothing here speaks HTTP; `src/inference/` alone does, when the
// evaluation records the engine for a trial.

import { ENGINE_NAMES, isBaseURL, isEngineId, type EngineId } from "../../inference/engines.ts";

/** The provider id AHP gives a local engine in OpenCode's config: a step's model is then `ahp-local/<model id>`. */
export const LOCAL_PROVIDER = "ahp-local";

/** The AI SDK package OpenCode loads for an OpenAI-compatible provider. */
export const LOCAL_PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";

/** Where a local engine serves, and the model ids it serves, as `/v1/models` lists them. */
export interface LocalEndpoint {
  /** Which engine it is (`ENGINES`): it names the provider and says where the engine's version is read. */
  engine: EngineId;
  /** The engine's OpenAI-compatible base, ending exactly in `/v1`: `http://localhost:8001/v1`. */
  baseURL: string;
  /** The model ids the engine serves, as it lists them; the step's model is one of them. */
  models: string[];
}

const ENDPOINT_KEYS = ["engine", "baseURL", "models"];

/** One message per problem with a `localEndpoint` option; unknown keys are refused, as the adapter's own options are. */
export function localEndpointProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["`localEndpoint` must be `{ engine, baseURL, models }`"];
  const endpoint = value as Record<string, unknown>;
  const problems = Object.keys(endpoint)
    .filter((key) => !ENDPOINT_KEYS.includes(key))
    .map((key) => `\`localEndpoint.${key}\` is not one of ${ENDPOINT_KEYS.join(", ")}`);
  if (!isEngineId(endpoint.engine)) problems.push(`\`localEndpoint.engine\` must be one of ${Object.keys(ENGINE_NAMES).join(", ")}`);
  if (!isBaseURL(endpoint.baseURL)) problems.push("`localEndpoint.baseURL` must be an http or https URL ending in /v1, such as http://localhost:8001/v1");
  const { models } = endpoint;
  if (!(Array.isArray(models) && models.length > 0 && models.every((model) => typeof model === "string" && model.trim() !== "" && model === model.trim()))) {
    problems.push("`localEndpoint.models` must be a non-empty array of the model ids the engine lists");
  } else if (new Set(models).size !== models.length) problems.push("`localEndpoint.models` names a model twice");
  return problems;
}

/** The model id OpenCode selects for a local model: `ahp-local/<id>`. */
export const localModelOf = (model: string): string => `${LOCAL_PROVIDER}/${model}`;

/** The served model a requested `ahp-local/<id>` names, when `<id>` is one the endpoint lists; null otherwise. */
export function servedModelOf(endpoint: LocalEndpoint, requested: string | null): string | null {
  const prefix = `${LOCAL_PROVIDER}/`;
  if (requested === null || !requested.startsWith(prefix)) return null;
  const model = requested.slice(prefix.length);
  return endpoint.models.includes(model) ? model : null;
}

/** The `provider` block of OpenCode's config for the endpoint: one OpenAI-compatible provider holding its models. */
export function providerBlockOf(endpoint: LocalEndpoint): Record<string, unknown> {
  return {
    [LOCAL_PROVIDER]: {
      npm: LOCAL_PROVIDER_PACKAGE,
      name: `${ENGINE_NAMES[endpoint.engine]} (local, AHP)`,
      options: { baseURL: endpoint.baseURL },
      models: Object.fromEntries(endpoint.models.map((model) => [model, {}])),
    },
  };
}
