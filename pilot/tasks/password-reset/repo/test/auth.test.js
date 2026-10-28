import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../src/auth.js";
import { createUserStore } from "../src/users.js";

function setup() {
  const users = createUserStore();
  users.create({ email: "ada@example.com", password: "correct horse" });
  return createAuth({ users });
}

test("a user logs in with the right password", () => {
  const result = setup().login("ada@example.com", "correct horse");
  assert.equal(result.ok, true);
  assert.equal(typeof result.userId, "string");
});

test("a wrong password and an unknown email fail the same way", () => {
  const auth = setup();
  assert.deepEqual(auth.login("ada@example.com", "wrong"), { ok: false, reason: "invalid_credentials" });
  assert.deepEqual(auth.login("nobody@example.com", "wrong"), { ok: false, reason: "invalid_credentials" });
});
