import assert from "node:assert/strict";
import test from "node:test";
import * as config from "../src/config.js";

const deepFreeze = (value) => {
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

test("defaults, then the file, then the environment", () => {
  const result = config.resolveConfig({
    defaults: { port: 80, db: { host: "a", pool: 5 } },
    file: { db: { host: "b" } },
    env: { APP_DB__POOL: "10", APP_PORT: "8080", OTHER: "ignored" },
  });
  assert.deepEqual(result, { port: 8080, db: { host: "b", pool: 10 } });
});

test("every layer is optional", () => {
  assert.deepEqual(config.resolveConfig({}), {});
  assert.deepEqual(config.resolveConfig({ file: undefined, env: { OTHER: "1" } }), {});
  assert.deepEqual(config.resolveConfig({ defaults: { a: 1 } }), { a: 1 });
});

test("environment values are coerced, and only those", () => {
  const env = { APP_A: "true", APP_B: "false", APP_C: "-12", APP_D: "42", APP_E: "4.5", APP_F: "yes", APP_G: "", APP_H: "TRUE", APP_I__J: "7" };
  assert.deepEqual(config.resolveConfig({ env }), { a: true, b: false, c: -12, d: 42, e: "4.5", f: "yes", g: "", h: "TRUE", i: { j: 7 } });
  assert.deepEqual(config.resolveConfig({ defaults: { a: "true", b: "42" }, file: { c: "false" } }), { a: "true", b: "42", c: "false" });
});

test("an array in a later layer replaces the earlier one, whole", () => {
  const result = config.resolveConfig({ defaults: { tags: ["a", "b", "c"], hosts: [{ name: "x" }, { name: "y" }] }, file: { tags: ["z"], hosts: [{ port: 1 }] } });
  assert.deepEqual(result, { tags: ["z"], hosts: [{ port: 1 }] });
});

test("null overrides and undefined does not", () => {
  assert.deepEqual(config.resolveConfig({ defaults: { a: 1, b: 2, c: { d: 3 } }, file: { a: null, b: undefined, c: undefined } }), { a: null, b: 2, c: { d: 3 } });
});

test("a plain object and any other value replace each other", () => {
  assert.deepEqual(config.resolveConfig({ defaults: { a: { x: 1 } }, file: { a: 5 } }), { a: 5 });
  assert.deepEqual(config.resolveConfig({ defaults: { a: 5 }, file: { a: { x: 1 } } }), { a: { x: 1 } });
  assert.deepEqual(config.resolveConfig({ defaults: { a: [1, 2] }, file: { a: { x: 1 } } }), { a: { x: 1 } });
});

test("a Date is a value, not something to merge into", () => {
  const first = new Date(Date.UTC(2026, 0, 1));
  const second = new Date(Date.UTC(2027, 5, 6));
  const result = config.resolveConfig({ defaults: { when: first, nested: { when: first } }, file: { nested: { when: second } } });
  assert.ok(result.when instanceof Date);
  assert.equal(result.when.getTime(), first.getTime());
  assert.notEqual(result.when, first);
  assert.equal(result.nested.when.getTime(), second.getTime());
});

test("a function is kept as it is", () => {
  const onError = () => "handled";
  const result = config.resolveConfig({ defaults: { hooks: { onError } } });
  assert.equal(result.hooks.onError, onError);
});

test("the result shares nothing with the layers, and the layers are left as they were", () => {
  const defaults = deepFreeze({ db: { host: "a", replicas: [{ host: "r1" }] }, tags: ["x"] });
  const file = deepFreeze({ db: { pool: 3 } });
  const result = config.resolveConfig({ defaults, file });
  assert.notEqual(result.db, defaults.db);
  assert.notEqual(result.tags, defaults.tags);
  assert.notEqual(result.db.replicas, defaults.db.replicas);
  assert.notEqual(result.db.replicas[0], defaults.db.replicas[0]);
  result.db.host = "changed";
  result.db.replicas[0].host = "changed";
  result.tags.push("y");
  assert.equal(defaults.db.host, "a");
  assert.equal(defaults.db.replicas[0].host, "r1");
  assert.deepEqual(defaults.tags, ["x"]);
});

test("__proto__, constructor and prototype are ignored in every layer", () => {
  const polluting = JSON.parse('{ "__proto__": { "polluted": true }, "constructor": { "prototype": { "polluted2": true } }, "ok": 1, "db": { "__proto__": { "polluted3": true }, "host": "h" } }');
  try {
    const result = config.resolveConfig({ defaults: polluting, file: polluting, env: { APP_CONSTRUCTOR__PROTOTYPE__POLLUTED4: "1", APP_PROTOTYPE__POLLUTED5: "1", APP_OK: "2" } });
    assert.equal(({}).polluted, undefined);
    assert.equal(({}).polluted2, undefined);
    assert.equal(({}).polluted3, undefined);
    assert.equal(({}).polluted4, undefined);
    assert.equal(({}).polluted5, undefined);
    assert.equal(Object.hasOwn(result, "__proto__"), false);
    assert.equal(Object.hasOwn(result, "constructor"), false);
    assert.equal(Object.hasOwn(result, "prototype"), false);
    assert.deepEqual(result, { ok: 2, db: { host: "h" } });
  } finally {
    for (const name of ["polluted", "polluted2", "polluted3", "polluted4", "polluted5"]) delete Object.prototype[name];
  }
});
