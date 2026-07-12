import crypto from "node:crypto";

import { hashPassword, verifyPassword } from "../src/authService.mjs";

const password = "compatibility-password";
const salt = "compatibility-salt";
const legacyHash = crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
const currentHash = hashPassword(password, salt);

const checks = [
  ["legacy hash verifies", verifyPassword(password, salt, legacyHash)],
  ["versioned hash verifies", verifyPassword(password, salt, currentHash)],
  ["wrong password fails", !verifyPassword("wrong-password", salt, currentHash)],
  ["malformed hash fails without throwing", !verifyPassword(password, salt, "pbkdf2_sha256$999999999$00")],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  throw new Error(`Auth password compatibility failed: ${failures.join(", ")}`);
}

console.log(`Auth password compatibility passed (${checks.length} checks).`);
