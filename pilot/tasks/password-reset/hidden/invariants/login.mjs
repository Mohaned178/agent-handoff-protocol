import assert from "node:assert/strict";
import { createAuth } from "../src/auth.js";
import { verifyPassword } from "../src/passwords.js";
import { createUserStore } from "../src/users.js";

// A hash the original hashPassword wrote for "correct horse": a stored password has to keep verifying.
const STORED = "42d9b3d7d6e2ebf2c0d6484bd442599d:6d83b4af5b10b2658a038419b830646aecd867b14c468dd629e051ebfddbb1cf";
assert.equal(verifyPassword("correct horse", STORED), true);
assert.equal(verifyPassword("wrong horse", STORED), false);

const users = createUserStore();
users.create({ email: "ada@example.com", password: "correct horse" });
const auth = createAuth({ users });

const ok = auth.login("ada@example.com", "correct horse");
assert.equal(ok.ok, true);
assert.deepEqual(Object.keys(ok).sort(), ["ok", "userId"]);
assert.deepEqual(auth.login("ada@example.com", "wrong horse"), { ok: false, reason: "invalid_credentials" });
assert.deepEqual(auth.login("nobody@example.com", "correct horse"), { ok: false, reason: "invalid_credentials" });
console.log("login behaviour is unchanged");
