import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_IDS, readResults, recordResult, SUITE_VERSION } from "../src/conformance/index.ts";

const script = fileURLToPath(new URL("../scripts/conformance.ts", import.meta.url));
const run = promisify(execFile);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ahp-conformance-script-"));
  dirs.push(dir);
  return dir;
};

/** The script's exit code and output; it exits non-zero by design. */
async function conformance(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

describe("npm run conformance", () => {
  it("runs the mock's suite and records a result labelled as the mock's, which the matrix does not count", async () => {
    const dir = tempDir();

    const ran = await conformance("run", "mock", "--out", dir);

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("mock (mock: not evidence)");
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readResults(dir)[0]).toMatchObject({ adapter: "mock", mock: true, toolVersion: "n/a (mock)" });
    const matrix = await conformance("matrix", "--dir", dir, "--adapters", "mock");
    expect(matrix.stdout).toContain("| mock | untested | untested | untested | untested |");
  });

  it("exits 3 when a check was not run, and records nothing for a partial run", async () => {
    const dir = tempDir();

    const ran = await conformance("run", "mock", "--out", dir, "--only", "declaration:complete");

    expect(ran.code).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("renders a recorded real adapter's cell", async () => {
    const dir = tempDir();
    recordResult(
      {
        suiteVersion: SUITE_VERSION,
        adapter: "claude-code",
        mock: false,
        platform: "linux",
        osLabel: "Linux (WSL2)",
        toolVersion: "2.1.0",
        ranAt: "2026-10-27T12:00:00.000Z",
        checks: CHECK_IDS.map((id) => ({ id, status: "passed" as const, detail: "ok" })),
      },
      dir,
    );
    writeFileSync(join(dir, "notes.txt"), "not a result file");

    const matrix = await conformance("matrix", "--dir", dir);

    expect(matrix.stdout).toContain("| claude-code | untested | passed (2.1.0, 2026-10-27) | untested | untested |");
  });

  it("refuses an adapter it does not know", async () => {
    const unknown = await conformance("run", "nonesuch");

    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('no adapter "nonesuch"');
  });
});
