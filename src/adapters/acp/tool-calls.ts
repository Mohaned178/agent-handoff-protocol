// What an ACP adapter (OpenCode) needs about tool calls: a call as the agent has described it so far, and the redaction
// of an error message. Nothing here is about which agent speaks: what a call's fields mean is ACP's (`tool_call`,
// `tool_call_update`). The calls are written to the attempt's activity log by `activityLogger` (`../activity.ts`).

import { withoutSecrets } from "../activity.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A tool call as the agent has described it so far: each `tool_call_update` fills in or replaces what it carries. */
export interface ToolCall {
  toolCallId: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  paths: string[];
  /** The shell command of an `execute` call, when the agent states it as `rawInput.command`. */
  command: string | null;
}

/** The call after a `tool_call` or `tool_call_update`, given what was known of it before; null when the update names no call. */
export function mergeToolCall(update: Json, known: ToolCall | undefined): ToolCall | null {
  const id = text(update.toolCallId);
  if (id === null) return null;
  const before = known ?? { toolCallId: id, kind: null, title: null, status: null, paths: [], command: null };
  const locations = Array.isArray(update.locations) ? update.locations.flatMap((location) => (isObject(location) && typeof location.path === "string" ? [location.path] : [])) : [];
  const rawInput = isObject(update.rawInput) ? update.rawInput : {};
  return {
    toolCallId: id,
    kind: text(update.kind) ?? before.kind,
    title: text(update.title) ?? before.title,
    status: text(update.status) ?? before.status,
    paths: locations.length > 0 ? locations : before.paths,
    command: text(rawInput.command) ?? before.command,
  };
}

/** Keeps a message from a tool, or a secret that got into one, from being copied whole into the ledger. */
const MAX_ERROR_CHARS = 500;

/** An API key in a message (a masked one too) is not repeated: this record is public. */
export function redacted(message: string): string {
  const clean = withoutSecrets(message);
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}
