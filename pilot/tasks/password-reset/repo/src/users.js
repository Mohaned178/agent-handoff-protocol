import { randomUUID } from "node:crypto";
import { hashPassword } from "./passwords.js";

/** An in-memory store of users: `{ id, email, passwordHash }`. */
export function createUserStore() {
  const users = new Map();
  return {
    create({ email, password }) {
      const user = { id: randomUUID(), email, passwordHash: hashPassword(password) };
      users.set(user.id, user);
      return user;
    },
    findByEmail(email) {
      for (const user of users.values()) {
        if (user.email === email) return user;
      }
      return null;
    },
    findById(id) {
      return users.get(id) ?? null;
    },
    setPassword(id, password) {
      const user = users.get(id);
      if (!user) throw new Error(`no such user: ${id}`);
      user.passwordHash = hashPassword(password);
    },
  };
}
