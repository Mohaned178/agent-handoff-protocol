import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_CI_SYSTEMS, RELEASE_ADAPTERS, SUITE_VERSION, readResults, renderSupportMatrixDoc, type ConformanceResult } from "../src/conformance/index.ts";

const root = new URL("../", import.meta.url);
const published = readFileSync(new URL("docs/support-matrix.md", root), "utf8");

describe("the published support matrix", () => {
  it("is the page rendered from the recorded results (run `npm run conformance -- matrix --write`)", () => {
    expect(published).toBe(renderSupportMatrixDoc(readResults(fileURLToPath(new URL("conformance/results", root)))));
  });

  it("lists core CI systems apart from the adapter cells, and every release adapter", () => {
    expect(published.indexOf("## Core, by operating system")).toBeLessThan(published.indexOf("## Adapters, by operating system"));
    for (const adapter of RELEASE_ADAPTERS) expect(published).toContain(`| ${adapter} |`);
  });

  it("names the CI runners the workflow really uses", () => {
    const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
    for (const { runner } of CORE_CI_SYSTEMS) expect(ci).toContain(runner);
  });

  it("marks macOS untested for every adapter, and an adapter without a result untested everywhere", () => {
    const rows = published.split("\n").filter((line) => RELEASE_ADAPTERS.some((a) => line.startsWith(`| ${a} |`)));
    for (const row of rows) expect(row.split(" | ").at(-1)).toMatch(/^untested \|?$/);
  });

  it("does not render a recorded result as passed unless the suite says so", () => {
    const fake: ConformanceResult = { suiteVersion: SUITE_VERSION, adapter: "codex", mock: false, platform: "win32", osLabel: "Windows", toolVersion: "9.9.9", ranAt: "2026-01-02T00:00:00.000Z", checks: [] };
    const page = renderSupportMatrixDoc([fake]);
    expect(page).toContain("untested (9.9.9, 2026-01-02)");
    expect(page).not.toContain("passed (9.9.9");
  });
});

describe("the limits page", () => {
  const limits = readFileSync(new URL("docs/limits.md", root), "utf8");
  it("states the four limits", () => {
    expect(limits).toMatch(/worktree is not a security boundary/i);
    expect(limits).toMatch(/Verification runs agent-written code on your machine/i);
    expect(limits).toMatch(/vendor's terms/i);
    expect(limits).toMatch(/stores no credentials/i);
  });
});
