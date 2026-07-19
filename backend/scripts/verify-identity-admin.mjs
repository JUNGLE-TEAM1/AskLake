import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_IDENTITY_ADMIN_PORT || 18085);
const baseUrl = process.env.ASKLAKE_IDENTITY_ADMIN_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_IDENTITY_ADMIN_START_SERVER !== "false";
const healthTimeoutMs = Number(process.env.ASKLAKE_IDENTITY_ADMIN_HEALTH_TIMEOUT_MS || 20_000);
const isolateDatabase = shouldStartServer && process.env.ASKLAKE_IDENTITY_ADMIN_ISOLATE_DATABASE !== "false";
const baseDatabaseUrl = process.env.ASKLAKE_IDENTITY_ADMIN_DATABASE_URL
  || process.env.DATABASE_URL
  || "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake";
const env = {
  ...process.env,
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;
let isolatedSchema = "";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  try {
    await runSmoke();
  } finally {
    await stopFastApiServer();
    if (isolatedSchema) dropIsolatedDatabaseSchema();
  }
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
  if (shouldStartServer) {
    if (isolateDatabase) prepareIsolatedDatabaseSchema();
    serverProcess = startFastApiServer();
  }

  await waitForHealth();
  if (isolatedSchema) seedSmokeResource();

  const context = {
    adminCookie: "",
    createdGrantId: "",
    demoBlocked: false,
    viewerCookie: "",
    smokePrincipalId: `identity-admin-smoke-${process.pid}-${Date.now()}@asklake.local`,
  };

  try {
    await verifyAuthentication(context);
    await verifyAdminDirectory(context);
    const editableResource = await verifyPermissionAdministration(context);
    await verifyAuditAdministration(context, editableResource);
    await verifyGovernanceAdministration(context);
    console.log("verify-identity-admin: ok");
  } finally {
    await cleanupSmokeState(context);
  }
}

async function verifyAuthentication(context) {
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

  const adminLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.user@asklake.local", password: "asklake-admin" }),
  });
  const adminLoginPayload = await readPayload(adminLoginResponse);
  assert(adminLoginResponse.ok && adminLoginPayload.user?.role === "admin", "Admin user should be able to log in.");
  context.adminCookie = adminLoginResponse.headers.get("set-cookie")?.split(";")[0] || "";
  assert(context.adminCookie, "Admin login response should include a session cookie.");
}

async function verifyAdminDirectory(context) {
  const headers = cookieHeaders(context.adminCookie);
  const currentUser = await get("/api/users/me", headers);
  assert(currentUser.id === "admin-user", "Current user should resolve the default Admin User actor.");
  assert(currentUser.profile?.avatarInitials === "AU", "Current user profile should include avatar initials.");
  assert(Array.isArray(currentUser.groups) && currentUser.groups.length === 0, "Admin current user should not include resource access groups.");
  assert(typeof currentUser.permissionsSummary?.canView === "number", "Current user should include permission summary.");

  const adminUsers = await get("/api/admin/users", headers);
  assert(Array.isArray(adminUsers.users), "Admin users response should include users array.");
  assert(adminUsers.users.some((user) => user.role === "admin"), "Admin users should include an admin actor.");
  const adminUser = adminUsers.users.find((user) => user.id === "admin-user");
  assert(adminUser && adminUser.groups.length === 0, "Admin user should not belong to resource access groups.");

  const adminGroups = await get("/api/admin/groups", headers);
  assert(Array.isArray(adminGroups.groups), "Admin groups response should include groups array.");
  assert(adminGroups.groups.some((group) => group.id === "analytics"), "Admin groups should include the viewer's analytics group.");
}

async function verifyPermissionAdministration(context) {
  const adminHeaders = cookieHeaders(context.adminCookie);
  const adminPermissions = await get("/api/admin/permissions", adminHeaders);
  assert(Array.isArray(adminPermissions.resources), "Admin permissions response should include resources array.");
  assert(
    adminPermissions.resources.every((resource) => Array.isArray(resource.grants)),
    "Admin permission resources should include grant arrays.",
  );
  const editableResource = adminPermissions.resources.find((resource) => resource.resourceType === "dataset")
    || adminPermissions.resources.find((resource) => resource.resourceType === "etl_job")
    || adminPermissions.resources[0];
  assert(editableResource, "Admin permissions should include at least one editable resource.");

  const createdPermissions = await post("/api/admin/permissions", {
    resourceType: editableResource.resourceType,
    resourceId: editableResource.resourceId,
    principalType: "user",
    principalId: context.smokePrincipalId,
    actions: ["view"],
  }, adminHeaders);
  const createdGrant = findGrant(createdPermissions, editableResource, context.smokePrincipalId);
  assert(createdGrant?.id, "Created permission grant should include id.");
  context.createdGrantId = createdGrant.id;
  assert(createdGrant.source === "admin", "Created permission grant should use admin source.");

  const patchedPermissions = await patch(`/api/admin/permissions/${createdGrant.id}`, {
    actions: ["view", "query"],
  }, adminHeaders);
  const patchedGrant = findGrant(patchedPermissions, editableResource, context.smokePrincipalId);
  assert(patchedGrant.actions.includes("query"), "Patched permission grant should include query action.");

  const deletedPermissions = await del(`/api/admin/permissions/${createdGrant.id}`, adminHeaders);
  context.createdGrantId = "";
  const deletedGrant = findGrant(deletedPermissions, editableResource, context.smokePrincipalId);
  assert(!deletedGrant, "Deleted permission grant should be removed from admin permission response.");

  const viewerLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo.user@asklake.local", password: "asklake-demo" }),
  });
  await readPayload(viewerLoginResponse);
  context.viewerCookie = viewerLoginResponse.headers.get("set-cookie")?.split(";")[0] || "";
  assert(viewerLoginResponse.ok && context.viewerCookie, "Viewer login should create a session for authorization checks.");

  const forbiddenEdit = await postExpectError("/api/admin/permissions", {
    resourceType: editableResource.resourceType,
    resourceId: editableResource.resourceId,
    principalType: "user",
    principalId: "blocked.user@asklake.local",
    actions: ["view"],
  }, 403, cookieHeaders(context.viewerCookie));
  assert(forbiddenEdit.error?.code === "FORBIDDEN", "Non-admin actor should not create permission grants.");
  return editableResource;
}

async function verifyAuditAdministration(context, editableResource) {
  const adminHeaders = cookieHeaders(context.adminCookie);
  const adminAuditLogs = await get("/api/admin/audit-logs", adminHeaders);
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

  const filteredAuditLogs = await get(`/api/admin/audit-logs?resourceType=${encodeURIComponent(editableResource.resourceType)}&q=${encodeURIComponent(context.smokePrincipalId)}&limit=10`, adminHeaders);
  assert(
    filteredAuditLogs.logs.length >= 1 && filteredAuditLogs.logs.every((log) => log.targetType === editableResource.resourceType),
    "Admin audit logs should support resourceType and text search filters.",
  );

  const authAuditLogs = await get(`/api/admin/audit-logs?resourceType=auth&q=${encodeURIComponent("demo.user")}&limit=20`, adminHeaders);
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

  const queryRunAuditLogs = await get("/api/admin/audit-logs?resourceType=query_run&limit=10", adminHeaders);
  assert(Array.isArray(queryRunAuditLogs.logs), "Query Run audit filter should return a logs array.");
  const unknownAuditLogs = await get("/api/admin/audit-logs?resourceType=unknown&limit=10", adminHeaders);
  assert(Array.isArray(unknownAuditLogs.logs), "Unknown audit filter should return a logs array.");
}

async function verifyGovernanceAdministration(context) {
  const adminHeaders = cookieHeaders(context.adminCookie);
  const governanceControls = await get("/api/admin/governance-controls", adminHeaders);
  assert(Array.isArray(governanceControls.principalControls), "Governance controls should include principal controls.");
  assert(Array.isArray(governanceControls.resourceLocks), "Governance controls should include resource locks.");

  await patch("/api/admin/governance/principals", {
    principalId: "demo-user",
    principalType: "user",
    reason: "Identity admin smoke user block",
    status: "blocked",
  }, adminHeaders);
  context.demoBlocked = true;
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
  }, adminHeaders);
  context.demoBlocked = false;
  const unblockedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo.user@asklake.local", password: "asklake-demo" }),
  });
  await readPayload(unblockedLoginResponse);
  assert(unblockedLoginResponse.ok, "Unblocked user should be able to log in again.");
  const unblockedCookie = unblockedLoginResponse.headers.get("set-cookie")?.split(";")[0] || "";
  if (unblockedCookie) await cleanupRequest("/api/auth/logout", "POST", unblockedCookie, {});

  const forbidden = await getExpectError("/api/admin/users", 403, cookieHeaders(context.viewerCookie));
  assert(forbidden.error?.code === "FORBIDDEN", "Non-admin actor should receive FORBIDDEN.");
}

async function cleanupSmokeState(context) {
  if (context.createdGrantId && context.adminCookie) {
    await cleanupRequest(`/api/admin/permissions/${context.createdGrantId}`, "DELETE", context.adminCookie);
  }
  if (context.demoBlocked && context.adminCookie) {
    await cleanupRequest("/api/admin/governance/principals", "PATCH", context.adminCookie, {
      principalId: "demo-user",
      principalType: "user",
      reason: "Identity admin smoke cleanup",
      status: "active",
    });
  }
  if (context.viewerCookie) await cleanupRequest("/api/auth/logout", "POST", context.viewerCookie, {});
  if (context.adminCookie) await cleanupRequest("/api/auth/logout", "POST", context.adminCookie, {});
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
    env: {
      ...env,
      AUTH_LEGACY_DEMO_USERS_ENABLED: "true",
      CONTINUOUS_CONTROL_PLANE: "disabled",
      DATABASE_URL: env.DATABASE_URL || baseDatabaseUrl,
      REALTIME_EVENTS_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[fastapi] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[fastapi] ${chunk}`));
  return child;
}

async function stopFastApiServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = new Promise((resolve) => serverProcess.once("exit", resolve));
  serverProcess.kill("SIGTERM");
  await Promise.race([exited, sleep(5_000)]);
}

function prepareIsolatedDatabaseSchema() {
  isolatedSchema = `identity_admin_smoke_${process.pid}_${Date.now()}`;
  runDatabaseCommand(
    "from sqlalchemy import create_engine, text\n"
      + "import os\n"
      + "engine = create_engine(os.environ['ASKLAKE_SMOKE_BASE_DATABASE_URL'])\n"
      + "schema = os.environ['ASKLAKE_SMOKE_SCHEMA']\n"
      + "with engine.begin() as connection:\n"
      + "    connection.execute(text(f'CREATE SCHEMA \\\"{schema}\\\"'))\n",
    baseDatabaseUrl,
  );
  const separator = baseDatabaseUrl.includes("?") ? "&" : "?";
  env.DATABASE_URL = `${baseDatabaseUrl}${separator}options=${encodeURIComponent(`-csearch_path=${isolatedSchema}`)}`;
}

function seedSmokeResource() {
  runDatabaseCommand(
    "from app.core.database import SessionLocal\n"
      + "from app.models.etl import ETLJobModel\n"
      + "with SessionLocal() as db:\n"
      + "    db.add(ETLJobModel(id='identity-admin-smoke-job', name='identity_admin_smoke', owner='admin-user', status='scheduled', tag='[smoke]', source='smoke', target='identity_admin_smoke', schedule='manual', source_config=[], source_label='Smoke fixture', source_type='SQL Result', schema_columns=[], schema_sample_rows=[], target_format='parquet', target_layer='SILVER', transform_output_columns=[], transform_steps=[], quality_invalid_rows=[], quality_rules=[], last_run='never', last_state='ready', next_run='-', stats={}, dag_steps=[]))\n"
      + "    db.commit()\n",
    env.DATABASE_URL,
  );
}

function dropIsolatedDatabaseSchema() {
  runDatabaseCommand(
    "from sqlalchemy import create_engine, text\n"
      + "import os\n"
      + "engine = create_engine(os.environ['ASKLAKE_SMOKE_BASE_DATABASE_URL'])\n"
      + "schema = os.environ['ASKLAKE_SMOKE_SCHEMA']\n"
      + "with engine.begin() as connection:\n"
      + "    connection.execute(text(f'DROP SCHEMA IF EXISTS \\\"{schema}\\\" CASCADE'))\n",
    baseDatabaseUrl,
  );
  isolatedSchema = "";
}

function runDatabaseCommand(source, databaseUrl) {
  const result = spawnSync(pythonBin, ["-c", source], {
    cwd: backendDir,
    env: {
      ...env,
      ASKLAKE_SMOKE_BASE_DATABASE_URL: databaseUrl,
      ASKLAKE_SMOKE_SCHEMA: isolatedSchema,
      DATABASE_URL: databaseUrl,
    },
    stdio: "pipe",
    text: true,
  });
  if (result.status !== 0) {
    throw new Error(["Identity admin smoke database setup failed.", result.stderr].filter(Boolean).join("\n"));
  }
}

async function waitForHealth() {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
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

function cookieHeaders(cookie) {
  return { Cookie: cookie };
}

async function cleanupRequest(route, method, cookie, body) {
  try {
    await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // Preserve the original smoke failure while best-effort cleanup runs.
  }
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
