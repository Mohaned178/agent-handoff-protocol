// Recording conformance results as files, one per adapter × operating-system label, and rendering the support matrix
// from them. The matrix says a cell passed only for a real adapter's latest result under the current suite, with the
// tool version and date it was recorded with; everything else is untested, and a failure is shown as one.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_IDS } from "./run.ts";
import { ConformanceResultSchema, OS_LABELS, SUITE_VERSION, outcomeOf, type ConformanceResult, type OsLabel } from "./result.ts";

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The file a result is recorded in: one per adapter and label, so a later run on the same system replaces it. */
export const resultFileName = (result: Pick<ConformanceResult, "adapter" | "osLabel">): string => `${slug(result.adapter)}--${slug(result.osLabel)}.json`;

/** Writes `result` to `dir` (created if missing) and returns the file's path. */
export function recordResult(result: ConformanceResult, dir: string): string {
  ConformanceResultSchema.parse(result);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, resultFileName(result));
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

/** Every result recorded in `dir`; none when it does not exist. A file that is not a result is an error, never skipped. */
export function readResults(dir: string): ConformanceResult[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.map((name) => {
    const parsed = ConformanceResultSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    if (!parsed.success) throw new Error(`${join(dir, name)} is not a conformance result: ${parsed.error.message}`);
    return parsed.data;
  });
}

export type CellStatus = "passed" | "failed" | "untested";

export interface MatrixCell {
  adapter: string;
  osLabel: OsLabel;
  status: CellStatus;
  /** Present when a result stands behind the cell. */
  toolVersion: string | null;
  /** The date (YYYY-MM-DD) of that result. */
  date: string | null;
  /** Why the cell is untested or failed, when there is more to say. */
  note: string | null;
}

/**
 * The cell of each of `adapters` on each system label. A cell takes the latest result of a real adapter (mock results
 * are never evidence and are ignored); it is `passed` only when that result is a pass under the current suite version
 * and holds every check of the current suite.
 */
export function matrixOf(results: readonly ConformanceResult[], adapters: readonly string[]): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const adapter of adapters) {
    for (const osLabel of OS_LABELS) {
      const latest = results
        .filter((result) => !result.mock && result.adapter === adapter && result.osLabel === osLabel)
        .sort((a, b) => a.ranAt.localeCompare(b.ranAt))
        .at(-1);
      if (!latest) {
        cells.push({ adapter, osLabel, status: "untested", toolVersion: null, date: null, note: null });
        continue;
      }
      const base = { adapter, osLabel, toolVersion: latest.toolVersion, date: latest.ranAt.slice(0, 10) };
      if (latest.suiteVersion !== SUITE_VERSION) {
        cells.push({ ...base, status: "untested", note: `recorded under conformance suite v${latest.suiteVersion}; the suite is now v${SUITE_VERSION}` });
        continue;
      }
      const missing = CHECK_IDS.filter((id) => !latest.checks.some((check) => check.id === id));
      if (missing.length > 0) {
        cells.push({ ...base, status: "untested", note: `the result lacks checks of the current suite: ${missing.join(", ")}` });
        continue;
      }
      const outcome = outcomeOf(latest);
      const failing = latest.checks.filter((check) => check.status === "failed").map((check) => check.id);
      const skippedChecks = latest.checks.filter((check) => check.status === "skipped").map((check) => check.id);
      const note = outcome === "failed" ? `failed: ${failing.join(", ")}` : outcome === "untested" ? `not checked: ${skippedChecks.join(", ") || "no checks ran"}` : null;
      cells.push({ ...base, status: outcome, note });
    }
  }
  return cells;
}

/** The matrix as a Markdown table, one row per adapter and one column per system label. */
export function renderMatrix(cells: readonly MatrixCell[]): string {
  const adapters = [...new Set(cells.map((cell) => cell.adapter))];
  const text = (cell: MatrixCell | undefined): string => {
    if (!cell || cell.date === null) return "untested";
    const stamp = `${cell.toolVersion}, ${cell.date}`;
    return cell.status === "passed" ? `passed (${stamp})` : `${cell.status} (${stamp}): ${cell.note}`;
  };
  const lines = [`| Adapter | ${OS_LABELS.join(" | ")} |`, `| --- | ${OS_LABELS.map(() => "---").join(" | ")} |`];
  for (const adapter of adapters) {
    const row = OS_LABELS.map((label) => text(cells.find((cell) => cell.adapter === adapter && cell.osLabel === label)));
    lines.push(`| ${adapter} | ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}
