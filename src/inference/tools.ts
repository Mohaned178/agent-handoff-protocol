// The `tools` workload: a prompt, OpenAI-style tool schemas and the call the answer is expected to make. A case is one JSON file,
// `<id>.json`, read once, so the bytes hashed are the bytes sent. The score looks at the first tool call the stream built.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Of } from "./bench.ts";
import type { StreamedToolCall } from "./client.ts";

/** What a tool-call answer is scored as: a closed list (the report counts each). */
export const TOOL_OUTCOMES = ["valid_call", "wrong_tool", "bad_arguments", "no_call", "malformed"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

/** The call a case expects: the tool's name, and arguments the call must carry with exactly these values. */
export interface ExpectedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCase {
  id: string;
  prompt: string;
  /** Sent as the request's `tools`, as they are. */
  tools: unknown[];
  expect: ExpectedCall;
  sha256: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CASE_KEYS = ["prompt", "tools", "expect"];
const EXPECT_KEYS = ["name", "arguments"];

/** One message per problem with a case's shape; unknown keys are refused, as in the bench file. */
export function validateToolCase(value: unknown): string[] {
  if (!isRecord(value)) return ["must be an object { prompt, tools, expect }"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!CASE_KEYS.includes(key)) problems.push(`unknown property \`${key}\``);
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") problems.push("`prompt` must be a non-empty string");
  if (!Array.isArray(value.tools) || value.tools.length === 0 || !value.tools.every(isRecord)) problems.push("`tools` must be a non-empty array of tool schemas (objects)");
  if (!isRecord(value.expect)) {
    problems.push("`expect` must be { name, arguments }");
  } else {
    for (const key of Object.keys(value.expect)) if (!EXPECT_KEYS.includes(key)) problems.push(`unknown property \`expect.${key}\``);
    if (typeof value.expect.name !== "string" || value.expect.name === "") problems.push("`expect.name` must be the name of the tool the answer should call");
    else if (Array.isArray(value.tools) && value.tools.length > 0 && !value.tools.some((tool) => isRecord(tool) && isRecord(tool.function) && tool.function.name === (value.expect as { name: string }).name)) {
      problems.push(`\`expect.name\` ${value.expect.name} is not the name of any of the case's tools`);
    }
    if (!isRecord(value.expect.arguments)) problems.push("`expect.arguments` must be an object of the arguments the call must carry");
  }
  return problems;
}

/** Reads every `<id>.json` under `dir`, sorted by id. A case that does not parse or is invalid is a problem; none at all is one too. */
export async function loadToolCases(dir: string): Promise<{ cases: ToolCase[]; problems: string[] }> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    return { cases: [], problems: [`cannot read the tool-call cases directory ${dir}: ${(error as Error).message}`] };
  }
  const problems: string[] = [];
  const cases: ToolCase[] = [];
  for (const name of entries) {
    const id = name.slice(0, -".json".length);
    if (!CASE_ID.test(id)) {
      problems.push(`tool-call case "${name}" must be named with letters, digits, - and _`);
      continue;
    }
    const bytes = await readFile(join(dir, name));
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      problems.push(`tool-call case ${id}: ${name} is not JSON`);
      continue;
    }
    const found = validateToolCase(parsed);
    if (found.length > 0) {
      problems.push(...found.map((problem) => `tool-call case ${id}: ${problem}`));
      continue;
    }
    const { prompt, tools, expect } = parsed as { prompt: string; tools: unknown[]; expect: ExpectedCall };
    cases.push({ id, prompt, tools, expect, sha256: sha256Of(bytes) });
  }
  if (cases.length === 0 && problems.length === 0) problems.push(`the tool-call cases directory ${dir} holds no <id>.json`);
  return { cases, problems };
}

const SHOWN = 300;
const shown = (text: string) => (text.length > SHOWN ? `${text.slice(0, SHOWN - 3)}...` : text);

/**
 * Scores the first tool call of an answer against the expected one; the answer's later calls are not looked at (the detail says
 * how many there were). In this order:
 * - no call at all (text only, or nothing): `no_call`;
 * - a call without a name, or whose arguments are not a JSON object (an empty text counts as `{}`): `malformed`;
 * - another tool's name: `wrong_tool`;
 * - an expected argument missing or with another value (compared deeply, extra arguments allowed): `bad_arguments`;
 * - else `valid_call`.
 * Malformed comes before the name is compared: an unreadable call is not a call to any tool.
 */
export function scoreToolCall(calls: readonly StreamedToolCall[], expect: ExpectedCall): { outcome: ToolOutcome; detail: string | null } {
  const first = calls[0];
  if (!first) return { outcome: "no_call", detail: null };
  const more = calls.length > 1 ? ` (${calls.length} calls; the first is scored)` : "";
  if (first.name === null || first.name === "") return { outcome: "malformed", detail: `a tool call with no name${more}` };
  let given: unknown;
  try {
    given = first.arguments.trim() === "" ? {} : JSON.parse(first.arguments);
  } catch {
    return { outcome: "malformed", detail: shown(`${first.name}: arguments are not JSON: ${first.arguments}${more}`) };
  }
  if (!isRecord(given)) return { outcome: "malformed", detail: shown(`${first.name}: arguments are not a JSON object: ${first.arguments}${more}`) };
  if (first.name !== expect.name) return { outcome: "wrong_tool", detail: shown(`called ${first.name}, expected ${expect.name}${more}`) };
  for (const [key, wanted] of Object.entries(expect.arguments)) {
    if (!(key in given)) return { outcome: "bad_arguments", detail: shown(`${first.name}: argument ${key} is missing${more}`) };
    if (!isDeepStrictEqual(given[key], wanted)) return { outcome: "bad_arguments", detail: shown(`${first.name}: ${key} is ${JSON.stringify(given[key])}, expected ${JSON.stringify(wanted)}${more}`) };
  }
  return { outcome: "valid_call", detail: more === "" ? null : more.trim() };
}
