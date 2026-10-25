// Writes the protocol's JSON Schemas to `schemas/`. Run with `npm run schemas` after changing a protocol schema.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { protocolJsonSchemas } from "../src/protocol/index.ts";

const outDir = fileURLToPath(new URL("../schemas/", import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const [file, schema] of Object.entries(protocolJsonSchemas())) {
  writeFileSync(`${outDir}${file}`, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schemas/${file}`);
}
