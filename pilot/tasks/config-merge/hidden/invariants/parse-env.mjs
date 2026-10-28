import assert from "node:assert/strict";
import { parseEnv } from "../src/env.js";

assert.deepEqual(parseEnv({ APP_PORT: "8080", APP_DB__HOST: "localhost", APP_DEBUG: "true", APP_RATIO: "-1", APP_OFF: "false", OTHER: "7" }), {
  port: "8080",
  db: { host: "localhost" },
  debug: "true",
  ratio: "-1",
  off: "false",
});
assert.deepEqual(parseEnv({ SVC_COUNT: "3", APP_COUNT: "4" }, "SVC_"), { count: "3" });
console.log("parseEnv still returns every value as a string");
