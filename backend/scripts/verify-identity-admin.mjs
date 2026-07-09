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

  const currentUser = await get("/api/users/me");
  assert(currentUser.id === "admin-user", "Current user should resolve the default Admin User actor.");
  assert(currentUser.profile?.avatarInitials === "AU", "Current user profile should include avatar initials.");
  assert(Array.isArray(currentUser.groups) && currentUser.groups.length > 0, "Current user should include groups.");
  assert(typeof currentUser.permissionsSummary?.canView === "number", "Current user should include permission summary.");

  const adminUsers = await get("/api/admin/users");
  assert(Array.isArray(adminUsers.users), "Admin users response should include users array.");
  assert(adminUsers.users.some((user) => user.role === "admin"), "Admin users should include an admin actor.");

  const adminGroups = await get("/api/admin/groups");
  assert(Array.isArray(adminGroups.groups), "Admin groups response should include groups array.");
  assert(adminGroups.groups.some((group) => group.id === "data-platform"), "Admin groups should include data-platform.");

  const adminPermissions = await get("/api/admin/permissions");
  assert(Array.isArray(adminPermissions.resources), "Admin permissions response should include resources array.");
  assert(
    adminPermissions.resources.every((resource) => Array.isArray(resource.grants)),
    "Admin permission resources should include grant arrays.",
  );

  const adminAuditLogs = await get("/api/admin/audit-logs");
  assert(Array.isArray(adminAuditLogs.logs), "Admin audit log response should include logs array.");
  assert(adminAuditLogs.logs.length >= 1, "Admin audit log response should include demo logs.");

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

async function getExpectError(route, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  const payload = await readPayload(response);
  assert(response.status === statusCode, `${route} expected ${statusCode}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
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
