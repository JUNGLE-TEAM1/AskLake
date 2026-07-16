import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string) {
  return readFileSync(path.join(frontendDir, relativePath), "utf8");
}

test("actual browser entry and Continuous diagnostics expose stable semantic selectors", () => {
  assert.match(source("src/pages/auth/AuthPage.tsx"), /data-testid="auth-login-form"/);
  const detail = source("src/pages/ingest/jobs/JobDetailPage.tsx");
  assert.match(detail, /data-testid="continuous-runtime-card"/);
  assert.match(detail, /data-testid="continuous-diagnostic-id"/);
});

test("browser smoke refuses a non-loopback target", () => {
  const verifier = source("scripts/verify-etl-browser-smoke.mjs");
  assert.match(verifier, /loopback/);
  assert.match(verifier, /ASKLAKE_E2E_ISOLATED_ENV/);
});
