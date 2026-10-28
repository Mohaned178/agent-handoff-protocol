import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "../src/env.js";
import { isPlainObject } from "../src/types.js";

test("parseEnv reads the prefixed names and nests on a double underscore", () => {
  const env = { APP_PORT: "8080", APP_DB__HOST: "localhost", APP_DEBUG: "true", OTHER: "ignored" };
  const parsed = parseEnv(env);
  assert.deepEqual(Object.keys(parsed).sort(), ["db", "debug", "port"]);
  assert.equal(parsed.db.host, "localhost");
});

test("parseEnv takes another prefix", () => {
  assert.deepEqual(parseEnv({ SVC_NAME: "x", APP_NAME: "y" }, "SVC_"), { name: "x" });
});

test("isPlainObject", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ port: 80 }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("text"), false);
  assert.equal(isPlainObject(5), false);
});
