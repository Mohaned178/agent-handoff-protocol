import { verifyPassword } from "./passwords.js";

/**
 * Authentication over a user store. `now` is the clock in milliseconds, which a test replaces.
 */
export function createAuth({ users, now = Date.now }) {
  return {
    login(email, password) {
      const user = users.findByEmail(email);
      if (!user || !verifyPassword(password, user.passwordHash)) return { ok: false, reason: "invalid_credentials" };
      return { ok: true, userId: user.id };
    },
  };
}
