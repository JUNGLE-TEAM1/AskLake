import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_IDENTITY_ADMIN_PORT || 18085);
const baseUrl = process.env.ASKLAKE_IDENTITY_ADMIN_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_IDENTITY_ADMIN_START_SERVER !== "false";
const env = {
  ...process.env,
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (serverProcess) serverProcess.kill("SIGTERM");
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
  if (shouldStartServer) serverProcess = startFastApiServer();

  await waitForHealth();

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo.user@asklake.local", password: "asklake-demo" }),
  });
  const loginPayload = await readPayload(loginResponse);
  assert(loginResponse.ok && loginPayload.user?.id === "demo-user", "Demo user should be able to log in.");
  const sessionCookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  assert(sessionCookie, "Login response should include a session cookie.");

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: sessionCookie },
  });
  await readPayload(logoutResponse);
  assert(logoutResponse.ok, "Demo user should be able to log out.");

  const failedLogin = await postExpectError("/api/auth/login", {
    email: "demo.user@asklake.local",
    password: "wrong-password",
  }, 401);
  assert(failedLogin.error?.code === "UNAUTHORIZED", "Invalid login should return UNAUTHORIZED.");

  const currentUser = await get("/api/users/me");
  assert(currentUser.id === "admin-user", "Current user should resolve the default Admin User actor.");
  assert(currentUser.profile?.avatarInitials === "AU", "Current user profile should include avatar initials.");
  assert(Array.isArray(currentUser.groups) && currentUser.groups.length === 0, "Admin current user should not include resource access groups.");
  assert(typeof currentUser.permissionsSummary?.canView === "number", "Current user should include permission summary.");

  const adminUsers = await get("/api/admin/users");
  assert(Array.isArray(adminUsers.users), "Admin users response should include users array.");
  assert(adminUsers.users.some((user) => user.role === "admin"), "Admin users should include an admin actor.");
  const adminUser = adminUsers.users.find((user) => user.id === "admin-user");
  assert(adminUser && adminUser.groups.length === 0, "Admin user should not belong to resource access groups.");

  const adminGroups = await get("/api/admin/groups");
  assert(Array.isArray(adminGroups.groups), "Admin groups response should include groups array.");
  assert(adminGroups.groups.some((group) => group.id === "data-platform"), "Admin groups should include data-platform.");

  const adminPermissions = await get("/api/admin/permissions");
  assert(Array.isArray(adminPermissions.resources), "Admin permissions response should include resources array.");
  assert(
    adminPermissions.resources.every((resource) => Array.isArray(resource.grants)),
    "Admin permission resources should include grant arrays.",
  );
  assert(
    adminPermissions.resources.some((resource) => resource.grants.some((grant) => grant.source === "admin_seed")),
    "Admin permissions should merge persisted permission_grants rows.",
  );
  const editableResource = adminPermissions.resources.find((resource) => resource.resourceType === "dataset")
    || adminPermissions.resources.find((resource) => resource.resourceType === "etl_job")
    || adminPermissions.resources[0];
  assert(editableResource, "Admin permissions should include at least one editable resource.");

  const createdPermissions = await post("/api/admin/permissions", {
    resourceType: editableResource.resourceType,
    resourceId: editableResource.resourceId,
    principalType: "user",
    principalId: "temporary.editor@asklake.local",
    actions: ["view"],
  });
  const createdGrant = findGrant(createdPermissions, editableResource, "temporary.editor@asklake.local");
  assert(createdGrant?.id, "Created permission grant should include id.");
  assert(createdGrant.source === "admin", "Created permission grant should use admin source.");

  const patchedPermissions = await patch(`/api/admin/permissions/${createdGrant.id}`, {
    actions: ["view", "query"],
  });
  const patchedGrant = findGrant(patchedPermissions, editableResource, "temporary.editor@asklake.local");
  assert(patchedGrant.actions.includes("query"), "Patched permission grant should include query action.");

  const deletedPermissions = await del(`/api/admin/permissions/${createdGrant.id}`);
  const deletedGrant = findGrant(deletedPermissions, editableResource, "temporary.editor@asklake.local");
  assert(!deletedGrant, "Deleted permission grant should be removed from admin permission response.");

  const forbiddenEdit = await postExpectError("/api/admin/permissions", {
    resourceType: editableResource.resourceType,
    resourceId: editableResource.resourceId,
    principalType: "user",
    principalId: "blocked.user@asklake.local",
    actions: ["view"],
  }, 403, { "X-AskLake-Role": "viewer" });
  assert(forbiddenEdit.error?.code === "FORBIDDEN", "Non-admin actor should not create permission grants.");

  const adminAuditLogs = await get("/api/admin/audit-logs");
  assert(Array.isArray(adminAuditLogs.logs), "Admin audit log response should include logs array.");
  assert(adminAuditLogs.logs.length >= 3, "Admin audit log response should include persisted permission grant events.");
  assert(
    adminAuditLogs.logs.some((log) => log.action === "admin.permission_grant.created" && log.targetId === editableResource.resourceId),
    "Admin audit logs should include the persisted permission grant creation event.",
  );
  assert(
    adminAuditLogs.logs.every((log) => log.requestId && log.createdAt && log.actorId) && haveCanonicalAuditTargetTypes(adminAuditLogs.logs),
    "Admin audit logs should include required identity fields and canonical target types.",
  );

  const filteredAuditLogs = await get(`/api/admin/audit-logs?resourceType=${encodeURIComponent(editableResource.resourceType)}&q=${encodeURIComponent("temporary.editor")}&limit=10`);
  assert(
    filteredAuditLogs.logs.length >= 1 && filteredAuditLogs.logs.every((log) => log.targetType === editableResource.resourceType),
    "Admin audit logs should support resourceType and text search filters.",
  );

  const authAuditLogs = await get(`/api/admin/audit-logs?resourceType=auth&q=${encodeURIComponent("demo.user")}&limit=20`);
  assert(
    authAuditLogs.logs.some((log) => log.action === "auth.login.succeeded" && log.result === "success"),
    "Auth audit logs should include successful login events.",
  );
  assert(
    authAuditLogs.logs.some((log) => log.action === "auth.logout.succeeded" && log.result === "success"),
    "Auth audit logs should include logout events.",
  );
  assert(
    authAuditLogs.logs.some((log) => log.action === "auth.login.failed" && log.result === "failed"),
    "Auth audit logs should include failed login events.",
  );

  const governanceControls = await get("/api/admin/governance-controls");
  assert(Array.isArray(governanceControls.principalControls), "Governance controls should include principal controls.");
  assert(Array.isArray(governanceControls.resourceLocks), "Governance controls should include resource locks.");

  await patch("/api/admin/governance/principals", {
    principalId: "demo-user",
    principalType: "user",
    reason: "Identity admin smoke user block",
    status: "blocked",
  });
  const blockedLogin = await postExpectError("/api/auth/login", {
    email: "demo.user@asklake.local",
    password: "asklake-demo",
  }, 403);
  assert(blockedLogin.error?.code === "FORBIDDEN", "Blocked user should not be able to log in.");

  await patch("/api/admin/governance/principals", {
    principalId: "demo-user",
    principalType: "user",
    reason: "Identity admin smoke user unblock",
    status: "active",
  });
  const unblockedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo.user@asklake.local", password: "asklake-demo" }),
  });
  await readPayload(unblockedLoginResponse);
  assert(unblockedLoginResponse.ok, "Unblocked user should be able to log in again.");

  const forbidden = await getExpectError("/api/admin/users", 403, { "X-AskLake-Role": "viewer" });
  assert(forbidden.error?.code === "FORBIDDEN", "Non-admin actor should receive FORBIDDEN.");

  console.log("verify-identity-admin: ok");
}

function ensureFastApiPythonDependencies() {
  const result = spawnSync(pythonBin, [
    "-c",
    "import fastapi, pydantic_settings, sqlalchemy, uvicorn",
  ], {
    cwd: backendDir,
    env,
    stdio: "pipe",
    text: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const lastOutputLine = output.split("\n").filter(Boolean).at(-1);
    throw new Error(
      [
        "FastAPI Python dependencies are not installed for this interpreter.",
        `python: ${pythonBin}`,
        "Run `cd backend && python3 -m pip install -r requirements.txt`, or set ASKLAKE_FASTAPI_PYTHON to a prepared interpreter.",
        lastOutputLine,
      ].filter(Boolean).join("\n"),
    );
  }
}

function startFastApiServer() {
  const child = spawn(pythonBin, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[fastapi] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[fastapi] ${chunk}`));
  return child;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok && health.database?.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`FastAPI health check did not pass at ${baseUrl}/api/health.`);
}

async function get(route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  return readResponse(response);
}

async function post(route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

async function patch(route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

async function del(route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method: "DELETE", headers });
  return readResponse(response);
}

async function getExpectError(route, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  const payload = await readPayload(response);
  assert(response.status === statusCode, `${route} expected ${statusCode}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postExpectError(route, body, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const payload = await readPayload(response);
  assert(response.status === statusCode, `${route} expected ${statusCode}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function findGrant(permissions, resource, principalId) {
  return permissions.resources
    .find((item) => item.resourceType === resource.resourceType && item.resourceId === resource.resourceId)
    ?.grants.find((grant) => grant.principalId === principalId);
}

function haveCanonicalAuditTargetTypes(logs) {
  const supported = new Set([
    "etl_job", "dataset", "dashboard", "query_run", "ai_module", "admin_module",
    "ui", "auth", "user", "group", "unknown",
  ]);
  return logs.every((log) => supported.has(log.targetType));
}

async function readResponse(response) {
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
