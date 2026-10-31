import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ahp } from "./helpers/cli.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown> & { version: string; files: string[] };

describe("the published package", () => {
  it("is public, named and described for npm", () => {
    expect(pkg.name).toBe("@mohaned178/ahp");
    expect(pkg.private).toBeUndefined();
    for (const field of ["repository", "homepage", "bugs", "keywords", "license", "engines", "bin"]) expect(pkg[field], field).toBeDefined();
  });

  it("holds bin, dist, schemas, the README and the licence, and nothing else", () => {
    // --ignore-scripts: npm pack would otherwise run `prepare`, a whole build, inside the test.
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
    expect(packed.status, packed.stderr).toBe(0);
    const files = (JSON.parse(packed.stdout) as { files: { path: string }[] }[])[0]!.files.map((file) => file.path);
    const allowed = ["bin/", "dist/", "schemas/"];
    const strays = files.filter((path) => !allowed.some((dir) => path.startsWith(dir)) && !["README.md", "LICENSE", "package.json"].includes(path));
    expect(strays).toEqual([]);
    expect(files).toContain("bin/ahp.mjs");
    expect(files).toContain("LICENSE");
  });

  it("checks everything before a publish", () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.prepublishOnly).toBe("npm run typecheck && npm test && npm run build");
  });

  it("prints its version and that it is alpha", () => {
    expect(ahp(["--version"], root).stdout.trim()).toBe(`${pkg.version} (alpha)`);
  });

  it("doctor gives what a bug report needs: AHP's version, and where bugs go", () => {
    const text = ahp(["doctor"], root).stdout;
    expect(text.split("\n")[0]).toBe(`ahp ${pkg.version} (alpha)`);
    expect(text).toContain("To report a bug: https://github.com/Mohaned178/agent-handoff-protocol/issues/new/choose");
    expect(JSON.parse(ahp(["doctor", "--json"], root).stdout).ahp).toBe(`${pkg.version} (alpha)`);
  });

  it("has a changelog entry for its version, and a release workflow that refuses a tag naming another", () => {
    expect(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")).toContain(`## ${pkg.version}`);
    const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(release).toContain("npm publish --provenance --access public");
    expect(release).toContain("GITHUB_REF_NAME");
  });
});
