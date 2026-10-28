import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../src/auth.js";
import { createUserStore } from "../src/users.js";

const MINUTE = 60_000;

function setup() {
  let time = Date.UTC(2026, 0, 1);
  const users = createUserStore();
  const auth = createAuth({ users, now: () => time });
  const advance = (ms) => {
    time += ms;
  };
  users.create({ email: "Ada@Example.com", password: "correct horse" });
  users.create({ email: "grace@example.com", password: "battery staple" });
  return { auth, advance };
}

test("a known email gets a long token", () => {
  const { auth } = setup();
  const issued = auth.requestPasswordReset("grace@example.com");
  assert.equal(typeof issued.token, "string");
  assert.ok(issued.token.length >= 32);
});

test("tokens differ between users and between requests", () => {
  const { auth } = setup();
  const a = auth.requestPasswordReset("grace@example.com").token;
  const b = auth.requestPasswordReset("ada@example.com").token;
  const c = auth.requestPasswordReset("grace@example.com").token;
  assert.equal(new Set([a, b, c]).size, 3);
});

test("an unknown email gets null", () => {
  const { auth } = setup();
  assert.equal(auth.requestPasswordReset("nobody@example.com"), null);
});

test("an email is matched whatever its letter case", () => {
  const { auth } = setup();
  assert.equal(typeof auth.requestPasswordReset("ADA@EXAMPLE.COM").token, "string");
  assert.equal(typeof auth.requestPasswordReset("GRACE@Example.com").token, "string");
});

test("a reset sets the new password and retires the old one", () => {
  const { auth } = setup();
  const { token } = auth.requestPasswordReset("grace@example.com");
  assert.deepEqual(auth.resetPassword(token, "a brand new secret"), { ok: true });
  assert.equal(auth.login("grace@example.com", "battery staple").ok, false);
  assert.equal(auth.login("grace@example.com", "a brand new secret").ok, true);
});

test("a reset for a user found by another letter case changes that user's password", () => {
  const { auth } = setup();
  const { token } = auth.requestPasswordReset("ADA@example.com");
  assert.deepEqual(auth.resetPassword(token, "another secret"), { ok: true });
  assert.equal(auth.login("Ada@Example.com", "another secret").ok, true);
});

test("a token works once", () => {
  const { auth } = setup();
  const { token } = auth.requestPasswordReset("grace@example.com");
  assert.equal(auth.resetPassword(token, "first new secret").ok, true);
  assert.deepEqual(auth.resetPassword(token, "second new secret"), { ok: false, reason: "invalid" });
  assert.equal(auth.login("grace@example.com", "first new secret").ok, true);
});

test("asking again retires the earlier token", () => {
  const { auth } = setup();
  const first = auth.requestPasswordReset("grace@example.com").token;
  const second = auth.requestPasswordReset("grace@example.com").token;
  assert.deepEqual(auth.resetPassword(first, "from the first"), { ok: false, reason: "invalid" });
  assert.equal(auth.resetPassword(second, "from the second").ok, true);
});

test("a token is good until 30 minutes have passed, and not at 30 minutes", () => {
  const near = setup();
  const nearToken = near.auth.requestPasswordReset("grace@example.com").token;
  near.advance(30 * MINUTE - 1);
  assert.equal(near.auth.resetPassword(nearToken, "just in time").ok, true);

  const late = setup();
  const lateToken = late.auth.requestPasswordReset("grace@example.com").token;
  late.advance(30 * MINUTE);
  assert.deepEqual(late.auth.resetPassword(lateToken, "too late now"), { ok: false, reason: "expired" });
  assert.equal(late.auth.login("grace@example.com", "battery staple").ok, true);
});

test("a short password is weak and leaves the token usable", () => {
  const { auth } = setup();
  const { token } = auth.requestPasswordReset("grace@example.com");
  assert.deepEqual(auth.resetPassword(token, "short"), { ok: false, reason: "weak" });
  assert.equal(auth.login("grace@example.com", "battery staple").ok, true);
  assert.equal(auth.resetPassword(token, "long enough now").ok, true);
});

test("an unknown token, or no token, is invalid", () => {
  const { auth } = setup();
  assert.deepEqual(auth.resetPassword("0".repeat(64), "a brand new secret"), { ok: false, reason: "invalid" });
  assert.deepEqual(auth.resetPassword(undefined, "a brand new secret"), { ok: false, reason: "invalid" });
});

test("a used token that has also expired is invalid, not expired", () => {
  const { auth, advance } = setup();
  const { token } = auth.requestPasswordReset("grace@example.com");
  assert.equal(auth.resetPassword(token, "used up quickly").ok, true);
  advance(31 * MINUTE);
  assert.deepEqual(auth.resetPassword(token, "used up twice"), { ok: false, reason: "invalid" });
});

test("a reset leaves other users alone, and asking for one changes no password", () => {
  const { auth } = setup();
  const { token } = auth.requestPasswordReset("grace@example.com");
  assert.equal(auth.login("grace@example.com", "battery staple").ok, true);
  auth.resetPassword(token, "a brand new secret");
  assert.equal(auth.login("Ada@Example.com", "correct horse").ok, true);
});
