import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/** Hashes a password as `v2$<salt hex>$<scrypt key hex>`. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH);
  return `v2$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Whether `password` is the one `stored` was made from. */
export function verifyPassword(password, stored) {
  const [version, saltHex, keyHex] = String(stored).split("$");
  if (version !== "v2" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}
