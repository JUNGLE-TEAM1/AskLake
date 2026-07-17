import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";


assert.equal(
  process.env.ASKLAKE_E2E_ISOLATED_ENV,
  "true",
  "Browser smoke requires ASKLAKE_E2E_ISOLATED_ENV=true.",
);
const baseUrl = new URL(process.env.ASKLAKE_E2E_FRONTEND_URL || "http://127.0.0.1:5174");
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname),
  `Browser smoke target must be loopback, received ${baseUrl.hostname}.`,
);
const executable = browserExecutable();
const profileDir = mkdtempSync(path.join(os.tmpdir(), "asklake-browser-e2e-"));

try {
  const result = spawnSync(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-sandbox",
    `--user-data-dir=${profileDir}`,
    "--virtual-time-budget=5000",
    "--dump-dom",
    new URL("/login", baseUrl).toString(),
  ], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /data-testid="auth-login-form"/);
  console.log(JSON.stringify({
    code: "asklake_browser_shell_verified",
    selector: "auth-login-form",
    target: new URL("/login", baseUrl).toString(),
  }));
} finally {
  rmSync(profileDir, { recursive: true, force: true });
}

function browserExecutable() {
  const configured = process.env.ASKLAKE_E2E_BROWSER_EXECUTABLE;
  if (configured) {
    assert(existsSync(configured), `Configured browser does not exist: ${configured}`);
    return configured;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const lookup = spawnSync("which", [name], { encoding: "utf8" });
    if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim();
  }
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert(existsSync(macChrome), "Set ASKLAKE_E2E_BROWSER_EXECUTABLE to a Chromium browser.");
  return macChrome;
}
