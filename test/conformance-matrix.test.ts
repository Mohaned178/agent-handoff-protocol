import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  ConformanceResultSchema,
  SUITE_VERSION,
  matrixOf,
  osLabelOf,
  outcomeOf,
  readResults,
  recordResult,
  renderMatrix,
  type CheckResult,
  type ConformanceResult,
} from "../src/conformance/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ahp-matrix-"));
  dirs.push(dir);
  return dir;
};

/** Every check of the current suite, passed. */
const ok: CheckResult[] = CHECK_IDS.map((id) => ({ id, status: "passed", detail: "ok" }));
const without = (id: string, replacement: CheckResult): CheckResult[] => ok.map((check) => (check.id === id ? replacement : check));

const resultOf = (changes: Partial<ConformanceResult> = {}): ConformanceResult => ({
  suiteVersion: SUITE_VERSION,
  adapter: "claude-code",
  mock: false,
  platform: "win32",
  osLabel: "Windows",
  toolVersion: "2.1.0",
  ranAt: "2026-10-27T12:00:00.000Z",
  checks: ok,
  ...changes,
});

describe("the support matrix", () => {
  it("marks a cell passed with the tool version and date of a real adapter's passing result, and every other cell untested", () => {
    const cells = matrixOf([resultOf()], ["claude-code", "codex"]);

    expect(cells.filter((cell) => cell.status !== "untested")).toEqual([
      { adapter: "claude-code", osLabel: "Windows", status: "passed", toolVersion: "2.1.0", date: "2026-10-27", note: null },
    ]);
    expect(cells).toHaveLength(8);
    expect(renderMatrix(cells)).toBe(
      [
        "| Adapter | Windows | Linux (WSL2) | Linux | macOS |",
        "| --- | --- | --- | --- | --- |",
        "| claude-code | passed (2.1.0, 2026-10-27) | untested | untested | untested |",
        "| codex | untested | untested | untested | untested |",
      ].join("\n"),
    );
  });

  it("never takes a mock result as evidence, even for an adapter of the same name", () => {
    const cells = matrixOf([resultOf({ mock: true, toolVersion: "n/a (mock)", adapter: "mock" })], ["mock"]);

    expect(cells.every((cell) => cell.status === "untested" && cell.toolVersion === null)).toBe(true);
  });

  it("shows a failure as one, and a run with a skipped check as untested, saying what was not checked", () => {
    const failed = resultOf({ checks: without("cancel:forced_tree", { id: "cancel:forced_tree", status: "failed", detail: "survivors" }) });
    const partial = resultOf({ osLabel: "Linux (WSL2)", checks: without("usage:reported", { id: "usage:reported", status: "skipped", detail: "cannot provoke" }) });

    const cells = matrixOf([failed, partial], ["claude-code"]);

    expect(cells.find((c) => c.osLabel === "Windows")).toMatchObject({ status: "failed", note: "failed: cancel:forced_tree" });
    expect(cells.find((c) => c.osLabel === "Linux (WSL2)")).toMatchObject({ status: "untested", date: "2026-10-27", note: "not checked: usage:reported" });
    expect(outcomeOf(resultOf({ checks: [] }))).toBe("untested");
  });

  it("takes the latest result of a cell, and reads a pass of an older suite as untested", () => {
    const older = resultOf({ ranAt: "2026-09-01T00:00:00.000Z", toolVersion: "2.0.0", checks: without("spawn_and_exit", { id: "spawn_and_exit", status: "failed", detail: "" }) });
    const stale = resultOf({ ranAt: "2026-10-01T00:00:00.000Z", suiteVersion: SUITE_VERSION + 1 });

    expect(matrixOf([older, resultOf()], ["claude-code"])[0]).toMatchObject({ status: "passed", toolVersion: "2.1.0" });
    expect(matrixOf([resultOf({ suiteVersion: SUITE_VERSION - 1 })], ["claude-code"])[0]).toMatchObject({ status: "untested", note: expect.stringContaining("suite") });
    expect(stale.suiteVersion).toBe(SUITE_VERSION + 1);
  });

  it("reads a result that lacks a check of the current suite as untested, however it passed", () => {
    const edited = resultOf({ checks: [{ id: "spawn_and_exit", status: "passed", detail: "ok" }] });

    expect(matrixOf([edited], ["claude-code"])[0]).toMatchObject({ status: "untested", note: expect.stringContaining("lacks checks") });
  });

  it("pins the checks of the suite: changing the list needs a new suite version", () => {
    // A check added, removed or made stricter bumps SUITE_VERSION, which is what makes older passes read as untested.
    expect(SUITE_VERSION).toBe(1);
    expect(CHECK_IDS).toEqual([
      "declaration:complete",
      "spawn_and_exit",
      "failure:agent_error",
      "failure:config_auth",
      "failure:transient",
      "model:reported",
      "model:not_reported",
      "usage:reported",
      "usage:not_reported",
      "cancel:stops_agent",
      "cancel:forced_tree",
      "capability:read_only",
      "capability:write_scope",
      "capability:no_external_actions",
      "network:deny",
      "network:package_registries",
      "declaration:refuses_above_declared",
    ]);
  });
});

describe("recording results", () => {
  it("writes one file per adapter and system label, and a later run on the same system replaces it", () => {
    const dir = tempDir();

    recordResult(resultOf(), dir);
    recordResult(resultOf({ toolVersion: "2.2.0", ranAt: "2026-11-01T00:00:00.000Z" }), dir);
    recordResult(resultOf({ osLabel: "Linux (WSL2)", platform: "linux" }), dir);

    expect(readdirSync(dir).sort()).toEqual(["claude-code--linux-wsl2.json", "claude-code--windows.json"]);
    expect(readResults(dir).find((r) => r.osLabel === "Windows")).toMatchObject({ toolVersion: "2.2.0" });
  });

  it("reads nothing from a directory that does not exist, and refuses a file that is not a result", () => {
    const dir = tempDir();

    expect(readResults(join(dir, "missing"))).toEqual([]);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ adapter: "x" }));
    expect(() => readResults(dir)).toThrow(/not a conformance result/);
  });

  it("refuses to record something that is not a result", () => {
    expect(() => recordResult({ ...resultOf(), toolVersion: "" }, tempDir())).toThrow();
    expect(ConformanceResultSchema.safeParse(resultOf({ ranAt: "yesterday" })).success).toBe(false);
  });
});

describe("the system label", () => {
  it("names Windows and macOS, and tells WSL2 from Linux by its environment or its kernel", () => {
    expect(osLabelOf("win32")).toBe("Windows");
    expect(osLabelOf("darwin")).toBe("macOS");
    expect(osLabelOf("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => "")).toBe("Linux (WSL2)");
    expect(osLabelOf("linux", {}, () => "Linux version 5.15.90.1-microsoft-standard-WSL2")).toBe("Linux (WSL2)");
    expect(osLabelOf("linux", {}, () => "Linux version 6.8.0-azure")).toBe("Linux");
    expect(() => osLabelOf("freebsd")).toThrow(/freebsd/);
  });
});
