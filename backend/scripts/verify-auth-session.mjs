import { spawn, spawnSync } from "node:child_process";

const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_AUTH_SMOKE_PORT || 18086);
const baseUrl = process.env.ASKLAKE_AUTH_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_AUTH_SMOKE_START_SERVER !== "false";

async function main() {
  assertPythonDeps();
  const server = shouldStartServer ? startServer() : null;
  try {
    await waitForHealth();

    const anonymousSession = await getJson("/api/auth/session");
    assert(anonymousSession.authenticated === false, "Anonymous session should not be authenticated.");

    const adminLogin = await postJson("/api/auth/login", {
      email: "admin.user@asklake.local",
      password: "asklake-admin",
    });
    assert(adminLogin.status === 200, "Admin login should succeed.");
    assert(adminLogin.cookie.includes("asklake_session="), "Admin login should set session cookie.");
    assert(adminLogin.body.user.role === "admin", "Admin login should return admin role.");

    const adminSession = await getJson("/api/auth/session", adminLogin.cookie);
    assert(adminSession.authenticated === true, "Admin session should be authenticated.");
    assert(adminSession.user.role === "admin", "Admin session should return admin user.");

    const viewerLogin = await postJson("/api/auth/login", {
      email: "demo.user@asklake.local",
      password: "asklake-demo",
    });
    assert(viewerLogin.status === 200, "Viewer login should succeed.");
    assert(viewerLogin.body.user.role === "viewer", "Viewer login should return viewer role.");

    const viewerMe = await getJson("/api/users/me", viewerLogin.cookie);
    assert(viewerMe.role === "viewer", "Viewer cookie should drive /users/me actor.");

    const viewerAdmin = await getRaw("/api/admin/users", viewerLogin.cookie);
    assert(viewerAdmin.status === 403, "Viewer cookie should be denied from admin APIs.");

    const logout = await postJson("/api/auth/logout", {}, viewerLogin.cookie);
    assert(logout.status === 200, "Logout should succeed.");

    console.log("Auth session smoke passed.");
  } finally {
    if (server) server.kill("SIGTERM");
  }
}

function assertPythonDeps() {
  const result = spawnSync(pythonBin, ["-c", "import fastapi, pydantic_settings, sqlalchemy, uvicorn"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error("FastAPI Python dependencies are not installed for this interpreter.");
  }
}

function startServer() {
  const child = spawn(pythonBin, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: new URL("../", import.meta.url),
    env: process.env,
    stdio: "ignore",
  });
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`FastAPI health check did not pass at ${baseUrl}/api/health.`);
}

async function getRaw(path, cookie = "") {
  return fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function getJson(path, cookie = "") {
  const response = await getRaw(path, cookie);
  return response.json();
}

async function postJson(path, payload, cookie = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method: "POST",
  });
  return {
    body: await response.json(),
    cookie: response.headers.get("set-cookie") || cookie,
    status: response.status,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
