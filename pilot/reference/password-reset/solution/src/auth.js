import { createHash, randomBytes } from "node:crypto";
import { verifyPassword } from "./passwords.js";

const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const MINIMUM_PASSWORD_LENGTH = 8;

const digestOf = (token) => createHash("sha256").update(token).digest("hex");

/**
 * Authentication over a user store. `now` is the clock in milliseconds, which a test replaces.
 */
export function createAuth({ users, now = Date.now }) {
  const tokens = new Map();
  const latestByUser = new Map();
  return {
    login(email, password) {
      const user = users.findByEmail(email);
      if (!user || !verifyPassword(password, user.passwordHash)) return { ok: false, reason: "invalid_credentials" };
      return { ok: true, userId: user.id };
    },
    requestPasswordReset(email) {
      const user = users.findByEmail(email);
      if (!user) return null;
      const earlier = latestByUser.get(user.id);
      if (earlier) tokens.delete(earlier);
      const token = randomBytes(32).toString("hex");
      const digest = digestOf(token);
      tokens.set(digest, { userId: user.id, expiresAt: now() + TOKEN_LIFETIME_MS });
      latestByUser.set(user.id, digest);
      return { token };
    },
    resetPassword(token, newPassword) {
      if (typeof token !== "string") return { ok: false, reason: "invalid" };
      const digest = digestOf(token);
      const entry = tokens.get(digest);
      if (!entry) return { ok: false, reason: "invalid" };
      if (now() >= entry.expiresAt) return { ok: false, reason: "expired" };
      if (typeof newPassword !== "string" || newPassword.length < MINIMUM_PASSWORD_LENGTH) return { ok: false, reason: "weak" };
      users.setPassword(entry.userId, newPassword);
      tokens.delete(digest);
      latestByUser.delete(entry.userId);
      return { ok: true };
    },
  };
}
