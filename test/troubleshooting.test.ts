import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const doc = readFileSync(join(root, "docs", "troubleshooting.md"), "utf8");

interface SourceFile {
  file: string;
  text: string;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

const sources: SourceFile[] = sourceFiles(join(root, "src")).map((file) => ({ file, text: readFileSync(file, "utf8") }));

interface Fragment {
  heading: string;
  fragment: string;
}

const fragments: Fragment[] = doc.split(/\r?\n/).flatMap((line) => {
  if (!line.startsWith("### ")) return [];
  const heading = line.slice(4).trim();
  return [...heading.matchAll(/"([^"]*)"/g)].flatMap((match) =>
    match[1]!
      .split("...")
      .map((part) => part.trim())
      .filter((part) => part.length >= 8)
      .map((fragment) => ({ heading, fragment })),
  );
});

describe("the troubleshooting page names messages the source really prints", () => {
  it("has quoted messages to check", () => {
    expect(fragments.length).toBeGreaterThan(0);
  });

  for (const { heading, fragment } of fragments) {
    it(`"${heading}": "${fragment}"`, () => {
      const found = sources.some((source) => source.text.includes(fragment));
      expect(found, `"${fragment}" from heading "${heading}" is not in any .ts file under src/`).toBe(true);
    });
  }
});
