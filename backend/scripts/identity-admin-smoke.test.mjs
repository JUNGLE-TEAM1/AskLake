import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";


const smokeScript = new URL("./verify-identity-admin.mjs", import.meta.url);
const source = readFileSync(smokeScript, "utf8");


test("identity admin smoke uses authenticated sessions without actor header fallback", () => {
  assert.doesNotMatch(source, /X-AskLake-(?:User|Role|Groups)/);
  assert.match(source, /adminCookie/);
  assert.match(source, /cookieHeaders\(context\.adminCookie\)/);
  assert.match(source, /resourceType=query_run/);
  assert.match(source, /resourceType=unknown/);
});


test("identity admin smoke exits non-zero when its target is unavailable", () => {
  const result = spawnSync(process.execPath, [smokeScript.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      ASKLAKE_IDENTITY_ADMIN_BASE_URL: "http://127.0.0.1:1",
      ASKLAKE_IDENTITY_ADMIN_HEALTH_TIMEOUT_MS: "100",
      ASKLAKE_IDENTITY_ADMIN_START_SERVER: "false",
    },
    timeout: 5_000,
  });

  assert.notEqual(result.status, 0, `unexpected success:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /health check did not pass/);
});
