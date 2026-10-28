// What the ACP adapters (OpenCode, Gemini CLI) share about tool calls: a call as the agent has described it so far, the
// log of calls the runtime reads into a recovery report, and the redaction of an error message. Nothing here is about
// which agent speaks: what a call's fields mean is ACP's (`tool_call`, `tool_call_update`).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { ToolCallLogEntry } from "../../protocol/index.ts";
import type { ToolCallRequest } from "./permissions.ts";

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
  const clean = message
    .replace(/\bsk-[\w*-]+/g, "sk-[redacted]")
    .replace(/\bAIza[\w-]{20,}/g, "[redacted key]")
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]");
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

const MAX_TITLE_CHARS = 300;

export interface ToolCallLogger {
  call(call: ToolCall): void;
  permission(toolCallId: string, call: ToolCallRequest, permission: "allowed" | "rejected"): void;
}

/** Appends a line to the runtime's tool-call log when a call's status, title or paths change, and when a permission request is answered. Never fails the attempt. */
export function toolCallLogger(file: string | null, workspace: string): ToolCallLogger {
  if (file !== null) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Made now, so a log with no entry reads as the agent having made no tool call, not as an adapter that keeps none.
      appendFileSync(file, "");
    } catch {
      // the log is a convenience for a person; the attempt does not depend on it
    }
  }
  const last = new Map<string, string>();
  const pathOf = (path: string) => {
    const rel = relative(workspace, path);
    return rel === "" ? "." : rel.startsWith("..") ? path : rel.replaceAll("\\", "/");
  };
  const write = (entry: ToolCallLogEntry) => {
    if (file === null) return;
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      // see above
    }
  };
  const entry = (toolCallId: string, parts: Omit<ToolCallLogEntry, "time" | "toolCallId">): ToolCallLogEntry => ({
    time: new Date().toISOString(),
    toolCallId,
    ...parts,
    title: parts.title === null ? null : parts.title.slice(0, MAX_TITLE_CHARS),
    paths: parts.paths.map(pathOf),
  });
  return {
    call(call) {
      const fingerprint = JSON.stringify([call.kind, call.title, call.status, call.paths]);
      if (last.get(call.toolCallId) === fingerprint) return;
      last.set(call.toolCallId, fingerprint);
      write(entry(call.toolCallId, { kind: call.kind, title: call.title, status: call.status, paths: call.paths, permission: null }));
    },
    permission(toolCallId, call, permission) {
      write(entry(toolCallId, { kind: call.kind, title: call.title, status: "permission_requested", paths: call.paths, permission }));
    },
  };
}
