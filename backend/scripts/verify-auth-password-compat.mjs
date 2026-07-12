import crypto from "node:crypto";

import {
  authRuntimePolicy,
  bootstrapAdminConfig,
  hashPassword,
  verifyPassword,
} from "../src/authService.mjs";

const password = "compatibility-password";
const salt = "compatibility-salt";
const legacyHash = crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
const currentHash = hashPassword(password, salt);

const checks = [
  ["legacy hash verifies", verifyPassword(password, salt, legacyHash)],
  ["versioned hash verifies", verifyPassword(password, salt, currentHash)],
  ["wrong password fails", !verifyPassword("wrong-password", salt, currentHash)],
  ["malformed hash fails without throwing", !verifyPassword(password, salt, "pbkdf2_sha256$999999999$00")],
  ["production disables demo users", !authRuntimePolicy({ APP_ENV: "production" }).allowsDemoUsers],
  ["production disables memory fallback", !authRuntimePolicy({ APP_ENV: "production" }).allowsMemoryFallback],
  ["local development keeps explicit demo auth", authRuntimePolicy({ APP_ENV: "local" }).allowsDemoUsers],
  ["production cookies are secure", authRuntimePolicy({ APP_ENV: "production" }).secureCookies],
  ["valid bootstrap admin is accepted", bootstrapAdminConfig({
    BOOTSTRAP_ADMIN_EMAIL: "owner@example.com",
    BOOTSTRAP_ADMIN_PASSWORD: "a-strong-bootstrap-password",
  }).email === "owner@example.com"],
];

let demoBootstrapRejected = false;
try {
  bootstrapAdminConfig({
    BOOTSTRAP_ADMIN_EMAIL: "admin.user@asklake.local",
    BOOTSTRAP_ADMIN_PASSWORD: "asklake-admin",
  });
} catch {
  demoBootstrapRejected = true;
}
checks.push(["demo bootstrap credentials are rejected", demoBootstrapRejected]);

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  throw new Error(`Auth password compatibility failed: ${failures.join(", ")}`);
}

console.log(`Auth password compatibility passed (${checks.length} checks).`);
