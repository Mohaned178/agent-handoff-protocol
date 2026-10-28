// What `ahp run` says while an agent works, between the ledger's events: each tool call an ACP adapter logged as it
// finished, and a line every minute that the attempt is still running and when its tool last printed anything. Read from
// the files the runtime owns (the tool-call log and the stdout transcript), so no adapter is asked for anything.

import { open, stat } from "node:fs/promises";
import type { ToolCallLogEntry } from "../protocol/index.ts";

export interface ProgressFiles {
  /** The attempt's stdout transcript. */
  output: string;
  /** The attempt's tool-call log; an adapter that keeps none leaves it empty or absent. */
  toolCalls: string;
}

export interface ProgressOptions {
  heartbeatMs?: number;
  pollMs?: number;
  /** For tests: the time now. */
  now?: () => number;
}

/** Starts saying what an attempt is doing, line by line through `say`, prefixed by `label`; `stop` ends it. */
export function watchProgress(files: ProgressFiles, label: string, say: (line: string) => void, options: ProgressOptions = {}): { stop: () => void } {
  const { heartbeatMs = 60_000, pollMs = 2_000, now = Date.now } = options;
  const started = now();
  let lastOutput = started;
  let outputSize = -1;
  let offset = 0;
  let partial = "";
  let nextBeat = started + heartbeatMs;
  let busy = false;
  let stopped = false;
  const said = new Set<string>();

  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const size = await stat(files.output).then((s) => s.size, () => 0);
      if (size !== outputSize) {
        outputSize = size;
        lastOutput = now();
      }
      for (const entry of await readNewEntries()) {
        const line = describeToolCall(entry);
        const key = `${entry.toolCallId} ${entry.status} ${entry.permission}`;
        if (line && !said.has(key) && !stopped) {
          said.add(key);
          say(`${label}: ${line}`);
        }
      }
      const time = now();
      if (time >= nextBeat && !stopped) {
        nextBeat = time + heartbeatMs;
        say(`${label}: still running (${span(time - started)}; its tool last printed ${span(time - lastOutput)} ago)`);
      }
    } finally {
      busy = false;
    }
  };

  const readNewEntries = async (): Promise<ToolCallLogEntry[]> => {
    let text = "";
    try {
      const handle = await open(files.toolCalls, "r");
      try {
        const { size } = await handle.stat();
        if (size <= offset) return [];
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        offset = size;
        text = buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as ToolCallLogEntry];
      } catch {
        return [];
      }
    });
  };

  const timer = setInterval(() => void poll().catch(() => undefined), pollMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** One line for a tool call that has finished or was refused; null for one still under way. */
export function describeToolCall(entry: ToolCallLogEntry): string | null {
  const what = `${entry.kind ?? "tool"} ${entry.title ?? entry.paths.join(", ")}`.trim();
  if (entry.permission === "rejected") return `${what} (refused by AHP)`;
  if (entry.status === "completed") return what;
  if (entry.status === "failed") return `${what} (failed)`;
  return null;
}

/** A duration as `1h 2m`, `3m 4s` or `5s`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
