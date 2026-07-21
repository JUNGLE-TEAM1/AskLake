import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { authModeFromPath, authPath } from "../src/pages/auth/authRoute.ts";

const frontendDir = path.resolve(import.meta.dirname, "..");

function source(relativePath: string): string {
  return readFileSync(path.join(frontendDir, relativePath), "utf8");
}

test("login and signup have stable direct routes", () => {
  assert.equal(authModeFromPath("/login"), "login");
  assert.equal(authModeFromPath("/login/"), "login");
  assert.equal(authModeFromPath("/signup"), "signup");
  assert.equal(authModeFromPath("/signup/"), "signup");
  assert.equal(authModeFromPath("/signup/invite"), null);
  assert.equal(authModeFromPath("/jobs"), null);
  assert.equal(authPath("login"), "/login");
  assert.equal(authPath("signup"), "/signup");
});

test("signup visibility follows the backend session capability", () => {
  const app = source("src/App.tsx");
  const authPage = source("src/pages/auth/AuthPage.tsx");
  const authApi = source("src/services/authApi.ts");

  assert.match(app, /setPublicSignupEnabled\(session\.publicSignupEnabled\)/);
  assert.match(app, /initialMode=\{routeState\.authMode \?\? "login"\}/);
  assert.match(app, /publicSignupEnabled=\{publicSignupEnabled\}/);
  assert.match(authPage, /data-testid="auth-signup-tab"/);
  assert.match(authPage, /nextMode === "signup" && !publicSignupEnabled/);
  assert.doesNotMatch(authPage, /VITE_AUTH_PUBLIC_SIGNUP/);
  assert.match(authApi, /post<AuthUserResponse>\("\/api\/auth\/signup", payload\)/);
});
