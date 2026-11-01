// The activity log every adapter appends to while its agent works (`AttemptInput.activityLog`): tool calls, the agent's
// messages, usage as the tool reports it and the limits it reports. A person watching reads it, and so does a recovery
// report, which no adapter's `exited` reaches; so it is written as things happen, one JSON line each, never rewritten.
// It is never the record: the ledger is. A write that fails never fails the attempt.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { isUsageReport, type ActivityEntry, type ActivityLimit, type UsageReport } from "../protocol/index.ts";

/** An activity entry before the logger stamps its time. */
export type ActivityItem = ActivityEntry extends infer E ? (E extends ActivityEntry ? Omit<E, "time"> : never) : never;

/** A tool call as an adapter knows it: what the tool said of it so far. */
export interface ToolCallFacts {
  toolCallId: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  paths: string[];
}

/** A permission request as the agent's tool described its call. */
export interface PermissionFacts {
  kind: string | null;
  title: string | null;
  paths: string[];
}

/** An API key in a text (a masked one too) is not repeated: the activity log and the ledger are read by people. */
export function withoutSecrets(text: string): string {
  return text
    .replace(/\bsk-[\w*-]+/g, "sk-[redacted]")
    .replace(/\bAIza[\w-]{20,}/g, "[redacted key]")
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]");
}

/** How much of a tool call's title, and of an agent's message, is kept. */
export const MAX_ACTIVITY_TEXT = 300;

const cut = (text: string) => (text.length > MAX_ACTIVITY_TEXT ? `${text.slice(0, MAX_ACTIVITY_TEXT)}…` : text);

export interface ActivityLogger {
  /**
   * Any entry. A message is redacted and cut, a title cut, paths made relative to the workspace; a usage report that is
   * not one (`isUsageReport`) and the same limit report twice in a row are not written.
   */
  write(item: ActivityItem): void;
  /** A tool call, written only when its kind, title, status or paths changed since it was last written. */
  call(call: ToolCallFacts): void;
  /** AHP's answer to the tool's permission request for a call. */
  permission(toolCallId: string, call: PermissionFacts, permission: "allowed" | "rejected"): void;
  message(text: string): void;
  usage(scope: "attempt" | "message", usage: UsageReport | null): void;
  /** A limit the logger's tool reported. */
  limit(limit: Omit<ActivityLimit, "tool">): void;
}

/**
 * The logger for one attempt's activity log at `file`, for the adapter named `tool`. The file is made at once, so a log
 * with no entry reads as an agent that did nothing yet, not as an adapter that keeps none. With no file (a caller that
 * keeps no log), nothing is written.
 */
export function activityLogger(file: string | null, workspace: string, tool: string): ActivityLogger {
  if (file !== null) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, "");
    } catch {
      // the log is for watching; the attempt does not depend on it
    }
  }
  const pathOf = (path: string) => {
    if (!isAbsolute(path)) return path.replaceAll("\\", "/");
    const rel = relative(workspace, path);
    return rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? path : rel.replaceAll("\\", "/");
  };
  const lastCall = new Map<string, string>();
  const lastLimit = new Map<string, string>();

  const append = (entry: ActivityEntry) => {
    if (file === null) return;
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      // see above
    }
  };

  const write = (item: ActivityItem) => {
    const time = new Date().toISOString();
    switch (item.type) {
      case "tool_call":
        return append({ ...item, time, title: item.title === null ? null : cut(item.title), paths: item.paths.map(pathOf) });
      case "message": {
        const text = cut(withoutSecrets(item.text.trim()));
        if (text !== "") append({ type: "message", time, text });
        return;
      }
      case "usage":
        if (isUsageReport(item.usage)) append({ ...item, time });
        return;
      case "limit": {
        // A tool that repeats the same report (Claude Code sends one after each message) is written once until it changes.
        const fingerprint = JSON.stringify(item);
        if (lastLimit.get(`${item.tool} ${item.kind}`) === fingerprint) return;
        lastLimit.set(`${item.tool} ${item.kind}`, fingerprint);
        return append({ ...item, time });
      }
    }
  };

  return {
    write,
    call({ toolCallId, kind, title, status, paths }) {
      const fingerprint = JSON.stringify([kind, title, status, paths]);
      if (lastCall.get(toolCallId) === fingerprint) return;
      lastCall.set(toolCallId, fingerprint);
      write({ type: "tool_call", toolCallId, kind, title, status, paths, permission: null });
    },
    permission(toolCallId, { kind, title, paths }, permission) {
      write({ type: "tool_call", toolCallId, kind, title, status: "permission_requested", paths, permission });
    },
    message(text) {
      write({ type: "message", text });
    },
    usage(scope, usage) {
      if (usage !== null) write({ type: "usage", scope, usage });
    },
    limit(limit) {
      write({ type: "limit", tool, ...limit });
    },
  };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a parsed line is an activity entry. A line of an old run's `tool-calls/` log has no `type` and is read as a
 * `tool_call` (`legacy`).
 */
export function activityEntryOf(value: unknown, legacy = false): ActivityEntry | null {
  if (!isObject(value) || typeof value.time !== "string") return null;
  const type = legacy && value.type === undefined ? "tool_call" : value.type;
  switch (type) {
    case "tool_call":
      return typeof value.toolCallId === "string" && Array.isArray(value.paths) ? ({ ...value, type } as ActivityEntry) : null;
    case "message":
      return typeof value.text === "string" ? (value as ActivityEntry) : null;
    case "usage":
      return (value.scope === "attempt" || value.scope === "message") && isUsageReport(value.usage) ? (value as ActivityEntry) : null;
    case "limit":
      return typeof value.tool === "string" && (value.kind === "plan_limit" || value.kind === "context_window") ? (value as ActivityEntry) : null;
    default:
      return null;
  }
}

/** The entries of an activity log's text, oldest first. A line a crash tore, or one that is not an entry, is left out. */
export function parseActivity(text: string, legacy = false): ActivityEntry[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const entry = activityEntryOf(JSON.parse(line), legacy);
      return entry === null ? [] : [entry];
    } catch {
      return [];
    }
  });
}
