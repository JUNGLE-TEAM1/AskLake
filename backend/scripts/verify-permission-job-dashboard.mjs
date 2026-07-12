import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_PERMISSION_JOB_DASHBOARD_PORT || 18088);
const baseUrl = process.env.ASKLAKE_PERMISSION_JOB_DASHBOARD_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_PERMISSION_JOB_DASHBOARD_START_SERVER !== "false";
const viewerHeaders = {
  "X-AskLake-Role": "viewer",
  "X-AskLake-User": "Blocked Job Dashboard Viewer",
};
const env = {
  ...process.env,
  ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "none",
  ASKLAKE_SPARK_OUTPUT_MODE: process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local",
  LOCAL_LAKE_STORAGE_DIR: process.env.LOCAL_LAKE_STORAGE_DIR || path.join(backendDir, "tmp", "permission-job-dashboard-lake"),
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;
let createdDashboardId = null;
let createdJobId = null;
const createdGrantIds = new Set();

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    await cleanupCreatedState();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (serverProcess) serverProcess.kill("SIGTERM");
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
  if (shouldStartServer) serverProcess = startFastApiServer();

  await waitForHealth();
  await cleanupPrincipalGrants(viewerHeaders["X-AskLake-User"]);

  const suffix = Date.now().toString(36);
  const jobPayload = buildSmokeJobPayload(suffix);
  const job = await createSmokeJob(jobPayload);
  createdJobId = job.id;
  await verifyJobPermissions(job.id, jobPayload);

  const dashboard = await post("/api/dashboards", {
    owner: "admin",
    source: "manual",
    title: `Permission Dashboard Smoke ${suffix}`,
  });
  createdDashboardId = dashboard.dashboard?.id;
  assert(createdDashboardId, "Dashboard create response should include dashboard.id.");
  await verifyDashboardPermissions(createdDashboardId);

  console.log("verify-permission-job-dashboard: ok");
}

async function verifyJobPermissions(jobId, jobPayload) {
  const blockedCommand = await postExpectError(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "pause" }, 403, viewerHeaders);
  assert(blockedCommand.error?.code === "FORBIDDEN", "Viewer without manage grant should be denied from job command.");

  const adminPermissions = await get("/api/admin/permissions");
  const jobResource = adminPermissions.resources.find((resource) => resource.resourceType === "etl_job" && resource.resourceId === jobId);
  assert(jobResource, `Admin permissions should include etl_job ${jobId}.`);

  const manageGrant = await createGrant({
    actions: ["manage"],
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    resourceId: jobId,
    resourceType: "etl_job",
  }, jobResource);
  assert(manageGrant?.id, "Job manage grant should be persisted.");

  const jobs = (await get("/api/etl/jobs", viewerHeaders)).jobs;
  const viewerJob = jobs.find((item) => item.id === jobId);
  assert(viewerJob?.permissions?.canManage === true, "Job list response should merge persisted manage grant into permissions.");

  const allowedCommand = await postExpectError(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "pause" }, 422, viewerHeaders);
  assert(allowedCommand.error?.code === "INVALID_JOB_STATE", "Viewer with manage grant should pass permission check and reach job state validation.");

  await patch("/api/admin/governance/resource-locks", {
    locked: true,
    reason: "Permission job smoke lock",
    resourceId: jobId,
    resourceType: "etl_job",
  });
  const lockedJobs = (await get("/api/etl/jobs", viewerHeaders)).jobs;
  const lockedJob = lockedJobs.find((item) => item.id === jobId);
  assert(lockedJob?.permissions?.canRun === false, "Locked job should report canRun=false.");
  assert(lockedJob?.permissions?.canManage === false, "Locked job should report canManage=false.");
  const lockedUpdate = await patchExpectError(`/api/etl/jobs/${encodeURIComponent(jobId)}`, {
    ...buildSmokeJobUpdatePayload(jobPayload),
    jobName: `${jobPayload.jobName} Locked Update`,
  }, 403, viewerHeaders);
  assert(lockedUpdate.error?.details?.resourceType === "etl_job", "Locked job update should return a governance 403.");

  await patch("/api/admin/governance/resource-locks", {
    locked: false,
    reason: "Permission job smoke unlock",
    resourceId: jobId,
    resourceType: "etl_job",
  });
  const unlockedJobs = (await get("/api/etl/jobs", viewerHeaders)).jobs;
  const unlockedJob = unlockedJobs.find((item) => item.id === jobId);
  assert(unlockedJob?.permissions?.canManage === true, "Unlocked job should restore manage permission.");

  await patch("/api/admin/governance/principals", {
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    reason: "Permission job smoke user block",
    status: "blocked",
  });
  const blockedJobs = (await get("/api/etl/jobs", viewerHeaders)).jobs;
  assert(!blockedJobs.some((item) => item.id === jobId), "Blocked actor should not see granted job in list.");
  await patch("/api/admin/governance/principals", {
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    reason: "Permission job smoke user unblock",
    status: "active",
  });

  const forbiddenJobAudits = await get(`/api/admin/audit-logs?resourceType=etl_job&result=forbidden&q=${encodeURIComponent(jobId)}&limit=20`);
  assert(
    forbiddenJobAudits.logs.some((log) => log.targetId === jobId && log.action === "etl_job.command.forbidden"),
    "Job command 403 should be recorded in admin audit logs.",
  );
}

async function verifyDashboardPermissions(dashboardId) {
  const blockedList = await get("/api/dashboards", viewerHeaders);
  assert(!blockedList.items.some((item) => item.id === dashboardId), "Viewer without view grant should not see dashboard in list.");

  const blockedPublished = await getExpectError(`/api/dashboards/${encodeURIComponent(dashboardId)}/published`, 403, viewerHeaders);
  assert(blockedPublished.error?.code === "FORBIDDEN", "Viewer without view grant should be denied from published runtime.");

  const blockedTitle = await patchExpectError(`/api/dashboards/${encodeURIComponent(dashboardId)}`, { title: "Blocked title" }, 403, viewerHeaders);
  assert(blockedTitle.error?.code === "FORBIDDEN", "Viewer without manage grant should not update dashboard title.");

  const blockedDraft = await postExpectError(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure`, {}, 403, viewerHeaders);
  assert(blockedDraft.error?.code === "FORBIDDEN", "Viewer without manage grant should not ensure draft runtime.");

  const adminPermissions = await get("/api/admin/permissions");
  const dashboardResource = adminPermissions.resources.find((resource) => resource.resourceType === "dashboard" && resource.resourceId === dashboardId);
  assert(dashboardResource, `Admin permissions should include dashboard ${dashboardId}.`);

  const grant = await createGrant({
    actions: ["view"],
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    resourceId: dashboardId,
    resourceType: "dashboard",
  }, dashboardResource);
  assert(grant?.id, "Dashboard view grant should be persisted.");

  const visibleList = await get("/api/dashboards", viewerHeaders);
  const visibleDashboard = visibleList.items.find((item) => item.id === dashboardId);
  assert(visibleDashboard?.permissions?.canView === true, "Dashboard list should include visible dashboard after view grant.");

  const publishedRuntime = await get(`/api/dashboards/${encodeURIComponent(dashboardId)}/published`, viewerHeaders);
  assert(publishedRuntime.dashboard?.id === dashboardId, "Viewer with view grant should hydrate published runtime.");
  assert(publishedRuntime.dashboard?.permissions?.canView === true, "Published runtime should include actor-specific view permission.");

  await patch(`/api/admin/permissions/${grant.id}`, { actions: ["view", "manage"] });

  const updated = await patch(`/api/dashboards/${encodeURIComponent(dashboardId)}`, { title: "Permission Dashboard Smoke Updated" }, viewerHeaders);
  assert(updated.dashboard?.name === "Permission Dashboard Smoke Updated", "Viewer with manage grant should update dashboard title.");

  const draft = await post(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure`, {}, viewerHeaders);
  assert(draft.dashboard?.permissions?.canManage === true, "Viewer with manage grant should ensure draft runtime.");

  await patch("/api/admin/governance/resource-locks", {
    locked: true,
    reason: "Permission dashboard smoke lock",
    resourceId: dashboardId,
    resourceType: "dashboard",
  });
  const lockedList = await get("/api/dashboards", viewerHeaders);
  const lockedDashboard = lockedList.items.find((item) => item.id === dashboardId);
  assert(lockedDashboard?.permissions?.canView === true, "Locked dashboard should remain visible to actors with view grant.");
  assert(lockedDashboard?.permissions?.canManage === false, "Locked dashboard should report canManage=false.");
  assert(lockedDashboard?.permissions?.canDelete === false, "Locked dashboard should report canDelete=false.");
  await patch("/api/admin/governance/resource-locks", {
    locked: false,
    reason: "Permission dashboard smoke unlock",
    resourceId: dashboardId,
    resourceType: "dashboard",
  });

  await patch("/api/admin/governance/principals", {
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    reason: "Permission dashboard smoke user block",
    status: "blocked",
  });
  const blockedGrantedList = await get("/api/dashboards", viewerHeaders);
  assert(!blockedGrantedList.items.some((item) => item.id === dashboardId), "Blocked actor should not see granted dashboard in list.");
  await patch("/api/admin/governance/principals", {
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    reason: "Permission dashboard smoke user unblock",
    status: "active",
  });

  const blockedDelete = await delExpectError(`/api/dashboards/${encodeURIComponent(dashboardId)}`, 403, viewerHeaders);
  assert(blockedDelete.error?.code === "FORBIDDEN", "Viewer without delete grant should not delete dashboard.");

  await patch(`/api/admin/permissions/${grant.id}`, { actions: ["view", "manage", "delete"] });

  const deleted = await del(`/api/dashboards/${encodeURIComponent(dashboardId)}`, viewerHeaders);
  assert(deleted.deletedDashboardId === dashboardId, "Viewer with delete grant should delete dashboard.");
  createdDashboardId = null;

  const forbiddenDashboardAudits = await get(`/api/admin/audit-logs?resourceType=dashboard&result=forbidden&q=${encodeURIComponent(dashboardId)}&limit=20`);
  assert(
    forbiddenDashboardAudits.logs.some((log) => log.targetId === dashboardId && log.action === "dashboard.access.forbidden"),
    "Dashboard runtime 403 should be recorded in admin audit logs.",
  );
  assert(
    forbiddenDashboardAudits.logs.some((log) => log.targetId === dashboardId && log.action === "dashboard.update.forbidden"),
    "Dashboard update 403 should be recorded in admin audit logs.",
  );
  assert(
    forbiddenDashboardAudits.logs.some((log) => log.targetId === dashboardId && log.action === "dashboard.delete.forbidden"),
    "Dashboard delete 403 should be recorded in admin audit logs.",
  );
}

function buildSmokeJobPayload(suffix) {
  const targetDataset = `permission_job_dashboard_smoke_${suffix}`;
  return {
    id: `permission-job-dashboard-${suffix}`,
    jobName: `Permission Job Dashboard Smoke ${suffix}`,
    owner: "admin",
    permissionRoles: [],
    permissionSummary: "admin only",
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "Permission job dashboard smoke",
    transformOutputColumns: [["customer_id", "string"], ["amount", "double"]],
    transformSteps: [],
    qualityInvalidRows: [],
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: [
      { included: true, nullable: false, sourceName: "customer_id", targetName: "customer_id", type: "String" },
      { included: true, nullable: false, sourceName: "amount", targetName: "amount", type: "Float" },
    ],
    schemaSampleRows: [["C-001", "42.5"], ["C-002", "17.25"]],
    schemaSummary: "Permission job dashboard smoke schema",
    sourceConfig: [["Endpoint", "sample://inline"], ["__Sample Row Limit", "2"]],
    sourceLabel: "inline sample rows",
    sourceType: "REST API",
    targetDataset,
    compression: "Snappy",
    partition: "none",
    storagePath: "",
    storageType: "Local",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  };
}

function buildSmokeJobUpdatePayload(payload) {
  const { id, sourceConfig, sourceLabel, sourceType, ...updatePayload } = payload;
  return updatePayload;
}

async function createSmokeJob(payload) {
  const create = await post("/api/etl/jobs", payload);
  assert(create.job?.id, "ETL job create response should include job.id.");
  return create.job;
}

async function createGrant(body, resource) {
  const permissions = await post("/api/admin/permissions", body);
  const grant = findGrant(permissions, resource, body.principalId);
  if (grant?.id) createdGrantIds.add(grant.id);
  return grant;
}

async function cleanupCreatedState() {
  for (const grantId of createdGrantIds) {
    try {
      await del(`/api/admin/permissions/${grantId}`);
    } catch {
      // The dashboard delete path may already remove related grants in future implementations.
    }
  }
  if (createdDashboardId) {
    try {
      await del(`/api/dashboards/${encodeURIComponent(createdDashboardId)}`);
    } catch {
      // Best-effort cleanup only; failed smoke output above remains the source of truth.
    }
  }
  if (createdJobId) {
    try {
      const deletedJobId = createdJobId;
      const deleted = await del(`/api/etl/jobs/${encodeURIComponent(deletedJobId)}`);
      assert(deleted.deletedJobId === deletedJobId, "Job delete response should identify the deleted job.");
      const deletionAudits = await get(`/api/admin/audit-logs?resourceType=etl_job&result=success&q=${encodeURIComponent(deletedJobId)}&limit=20`);
      assert(
        deletionAudits.logs.some((log) => log.targetId === deletedJobId && log.action === "etl_job.deleted"),
        "Successful job deletion should be recorded in admin audit logs.",
      );
      createdJobId = null;
    } catch {
      // Best-effort cleanup only; failed smoke output above remains the source of truth.
    }
  }
}

async function cleanupPrincipalGrants(principalId) {
  const permissions = await get("/api/admin/permissions");
  const grantIds = permissions.resources
    .flatMap((resource) => resource.grants)
    .filter((grant) => grant.principalId === principalId && grant.id)
    .map((grant) => grant.id);
  for (const grantId of grantIds) {
    await del(`/api/admin/permissions/${grantId}`);
  }
}

function ensureFastApiPythonDependencies() {
  const result = spawnSync(pythonBin, [
    "-c",
    "import duckdb, fastapi, psycopg, pydantic_settings, sqlalchemy, uvicorn",
  ], {
    cwd: backendDir,
    env,
    stdio: "pipe",
    text: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const lastOutputLine = output.split("\n").filter(Boolean).at(-1);
    throw new Error([
      "FastAPI Python dependencies are not installed for this interpreter.",
      `python: ${pythonBin}`,
      "Run `cd backend && python3 -m pip install -r requirements.txt`, or set ASKLAKE_FASTAPI_PYTHON to a prepared interpreter.",
      lastOutputLine,
    ].filter(Boolean).join("\n"));
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
  return readErrorResponse(response, route, statusCode);
}

async function postExpectError(route, body, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readErrorResponse(response, route, statusCode);
}

async function patchExpectError(route, body, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readErrorResponse(response, route, statusCode);
}

async function delExpectError(route, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method: "DELETE", headers });
  return readErrorResponse(response, route, statusCode);
}

async function readErrorResponse(response, route, statusCode) {
  const payload = await readPayload(response);
  assert(response.status === statusCode, `${route} expected ${statusCode}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function findGrant(permissions, resource, principalId) {
  return permissions.resources
    .find((item) => item.resourceType === resource?.resourceType && item.resourceId === resource?.resourceId)
    ?.grants.find((grant) => grant.principalId === principalId);
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
