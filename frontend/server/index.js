import http from "node:http";
import { URL } from "node:url";
import {
  databaseUrl,
  createDashboard,
  createDraftDashboardPage,
  createDraftDashboardWidget,
  deleteDraftDashboardPage,
  deleteDraftDashboardWidget,
  deleteDashboard,
  ensureSchema,
  ensureDraftDashboardRuntime,
  getDashboard,
  getDataset,
  getPublishedDashboardRuntime,
  getJob,
  listDashboards,
  listDatasets,
  listJobs,
  nextJobId,
  pool,
  queryDashboards,
  publishDashboardRuntime,
  saveDashboard,
  saveDraftDashboardLayouts,
  saveDataset,
  saveJob,
  saveSqlRun,
  seedDatabase,
  updateDashboardTitle,
  updateDraftDashboardPageTitle,
  updateDraftDashboardWidget,
} from "./db.js";

const port = Number(process.env.PORT ?? 8080);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type, X-AskLake-User, X-AskLake-Role",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function getRequestActor(request) {
  return {
    name: String(request.headers["x-asklake-user"] ?? "Admin User"),
    role: String(request.headers["x-asklake-role"] ?? "admin").toLowerCase(),
  };
}

function canDeleteDashboard(actor, dashboard) {
  return actor.role === "admin" || actor.name === dashboard.owner;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function nowTimeLabel() {
  return new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function hasScheduledLabel(scheduleLabel) {
  const schedule = String(scheduleLabel || "").trim().toLowerCase();
  if (!schedule || schedule === "-") return false;
  return !["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token));
}

function scheduleNextRunLabel(scheduleLabel, fallback) {
  const schedule = String(scheduleLabel || "").trim();
  const fallbackLabel = String(fallback || "").trim();
  if (!schedule || !hasScheduledLabel(schedule)) return "-";
  if (schedule.includes("1회") || schedule.includes("예약")) {
    return fallbackLabel && fallbackLabel !== "-"
      ? fallbackLabel
      : schedule.replace(/\s*(예약\s*)?1회 실행\s*$/, "").trim();
  }
  return fallbackLabel && fallbackLabel !== "-" ? fallbackLabel : schedule;
}

function hasScheduledExecution(job) {
  return job.status !== "stopped" && hasScheduledLabel(job.schedule);
}

function buildDagSteps(job, command) {
  if (command === "pause") {
    return [
      { id: "step-1", title: "1. Source connect", meta: job.source, status: "success" },
      { id: "step-2", title: "2. Read files", meta: "72,410 rows scanned", status: "success" },
      { id: "step-3", title: "3. Schema mapping", meta: "Paused by user", note: "resume pending", status: "blocked" },
      { id: "step-4", title: "4. Transform rule", meta: "waiting", status: "blocked" },
      { id: "step-5", title: "5. Validation", meta: "waiting", status: "blocked" },
      { id: "step-6", title: "6. Load to lake", meta: job.target, status: "blocked" },
      { id: "step-7", title: "7. Schema check", meta: "row count / schema check", status: "blocked" },
      { id: "step-8", title: "8. Downstream sync", meta: "SQL / Dashboard / Catalog", status: "blocked" },
    ];
  }

  if (command === "cancelRun") {
    return [
      { id: "step-1", title: "1. Source connect", meta: job.source, status: "success" },
      { id: "step-2", title: "2. Read files", meta: "72,410 rows scanned", status: "success" },
      { id: "step-3", title: "3. Schema mapping", meta: "Canceled by user", note: "cancel requested", status: "blocked" },
      { id: "step-4", title: "4. Transform rule", meta: "stopped", status: "blocked" },
      { id: "step-5", title: "5. Validation", meta: "stopped", status: "blocked" },
      { id: "step-6", title: "6. Load to lake", meta: job.target, status: "blocked" },
      { id: "step-7", title: "7. Schema check", meta: "row count / schema check", status: "blocked" },
      { id: "step-8", title: "8. Downstream sync", meta: "SQL / Dashboard / Catalog", status: "blocked" },
    ];
  }

  return [
    { id: "step-1", title: "1. Source connect", meta: job.source, status: "running" },
    { id: "step-2", title: "2. Read files", meta: "waiting", status: "pending" },
    { id: "step-3", title: "3. Schema mapping", meta: "waiting", status: "pending" },
    { id: "step-4", title: "4. Transform rule", meta: "waiting", status: "pending" },
    { id: "step-5", title: "5. Validation", meta: "waiting", status: "pending" },
    { id: "step-6", title: "6. Load to lake", meta: job.target, status: "pending" },
    { id: "step-7", title: "7. Schema check", meta: "row count / schema check", status: "pending" },
    { id: "step-8", title: "8. Downstream sync", meta: "SQL / Dashboard / Catalog", status: "pending" },
  ];
}

function buildCommandResult(job, command) {
  const actionByCommand = {
    cancelRun: { action: "etl.run.cancel_requested", apiPath: `/api/etl/jobs/${job.id}/runs/current/cancel` },
    pause: { action: "etl.job.pause_requested", apiPath: `/api/etl/jobs/${job.id}` },
    retry: { action: "etl.run.retry_requested", apiPath: `/api/etl/jobs/${job.id}/runs` },
    run: { action: "etl.run.requested", apiPath: `/api/etl/jobs/${job.id}/runs` },
    stopSchedule: { action: "etl.schedule.stop_requested", apiPath: `/api/etl/jobs/${job.id}/schedule/stop` },
  };
  const audit = actionByCommand[command];
  const runId = `run_${Date.now()}`;

  if (command === "pause") {
    const updatedJob = {
      ...job,
      status: "paused",
      lastState: "paused by user",
      nextRun: "resume pending",
      progress: job.progress ?? { label: "paused", value: 50 },
    };
    return {
      ...audit,
      dagSteps: buildDagSteps(updatedJob, command),
      job: updatedJob,
      run: {
        duration: "paused",
        endedAt: "-",
        errorSummary: "-",
        failedStage: "-",
        inputRows: "72,410",
        outputRows: "0",
        runId,
        startedAt: nowTimeLabel(),
        status: "running",
      },
    };
  }

  if (command === "stopSchedule") {
    const updatedJob = {
      ...job,
      status: "stopped",
      lastState: "스케줄 중지됨",
      nextRun: "-",
      progress: undefined,
      schedule: "스케줄링 건너뛰기",
      schedulePolicy: {
        endDate: "",
        nextRunUtc: "",
        overlapPolicy: undefined,
        startDate: "",
        timezone: "",
        watermarkPolicy: {
          column: "updated_at",
          enabled: false,
          lookbackMinutes: 0,
          mode: "full_refresh",
        },
      },
      scheduleSummary: "스케줄링 건너뛰기 · 나중에 목록에서 직접 실행",
    };
    return {
      ...audit,
      job: updatedJob,
    };
  }

  if (command === "cancelRun") {
    const updatedJob = {
      ...job,
      status: "canceled",
      lastRun: "canceled now",
      lastState: "canceled",
      nextRun: scheduleNextRunLabel(job.schedule, job.nextRun),
      progress: undefined,
    };
    return {
      ...audit,
      dagSteps: buildDagSteps(updatedJob, command),
      job: updatedJob,
      run: {
        duration: "canceled",
        endedAt: nowTimeLabel(),
        errorSummary: "Canceled by user request",
        failedStage: "-",
        inputRows: "72,410",
        outputRows: "0",
        runId,
        startedAt: nowTimeLabel(),
        status: "canceled",
      },
    };
  }

  const updatedJob = {
    ...job,
    status: "running",
    lastRun: "running now",
    lastState: command === "retry" ? "retrying - Source connect" : "1/8 steps - Source connect",
    nextRun: "-",
    progress: {
      label: command === "retry" ? "retrying - Source connect" : "1/8 steps - Source connect",
      value: 12,
    },
  };

  return {
    ...audit,
    dagSteps: buildDagSteps(updatedJob, command),
    job: updatedJob,
    run: {
      duration: "running",
      endedAt: "-",
      errorSummary: "-",
      failedStage: "-",
      inputRows: "0",
      outputRows: "0",
      runId,
      startedAt: nowTimeLabel(),
      status: "running",
    },
  };
}

async function createPipeline(draft) {
  const jobId = await nextJobId();
  const job = {
    id: jobId,
    name: draft.jobName,
    owner: draft.owner,
    status: "scheduled",
    tag: "[review]",
    source: `${draft.sourceType} / ${draft.sourceLabel}`,
    target: draft.targetDataset,
    schedule: draft.scheduleLabel,
    schedulePolicy: {
      endDate: draft.endDate,
      nextRunUtc: draft.nextRunUtc,
      overlapPolicy: draft.overlapPolicy,
      startDate: draft.startDate,
      timezone: draft.timezone,
      watermarkPolicy: draft.watermarkPolicy,
    },
    scheduleSummary: draft.scheduleSummary,
    retryPolicy: draft.retryPolicy,
    retryPolicySummary: draft.retryPolicySummary,
    runLimitSummary: draft.runLimitSummary,
    lastRun: "created now",
    lastState: "waiting",
    nextRun: scheduleNextRunLabel(draft.scheduleLabel, draft.scheduleSummary),
  };
  const dataset = {
    id: `ds_${draft.targetDataset}`,
    name: draft.targetDataset,
    description: "Dataset created from the pipeline wizard.",
    owner: draft.owner,
    layer: draft.targetLayer,
    status: "available",
    freshness: "latest",
    source: draft.jobName,
    rows: "0 rows",
    size: "Pending",
    quality: "95% (Draft verified)",
    lastUpdated: new Date().toISOString(),
    nextRefresh: draft.scheduleLabel,
    rag: draft.rag,
    tags: ["#customer", "#RAG", "#review"],
    schema: [["review_id", "bigint"], ["product_id", "string"], ["rating", "int"], ["review_text", "string"], ["sentiment", "string"]],
    sampleRows: [["-", "-", "-", "-", "Pipeline queued"]],
    upstream: [draft.sourceLabel, draft.jobName],
    downstream: ["SQL Analysis", "Dashboard", draft.rag ? "AI Search" : "Catalog"],
  };

  await saveJob(job);
  await saveDataset(dataset);
  return { dataset, job };
}

async function executeQuery({ datasetId, query }) {
  if (!datasetId || !query) {
    return { error: { status: 400, code: "VALIDATION_ERROR", message: "datasetId and query are required" } };
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|merge)\b/i.test(query)) {
    return { error: { status: 403, code: "FORBIDDEN", message: "Only read-only SELECT queries are allowed" } };
  }
  const dataset = await getDataset(datasetId);
  if (!dataset) return { error: { status: 404, code: "NOT_FOUND", message: "Dataset not found" } };

  const columns = dataset.schema.slice(0, 6).map(([name]) => name);
  const rows = dataset.sampleRows.map((row) => row.slice(0, Math.max(columns.length, 1)));
  const resultDraft = {
    columns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    executedAt: new Date().toISOString(),
    query,
    rowCount: rows.length,
    rows,
    runId: `sql_${Date.now()}`,
  };
  await saveSqlRun(resultDraft);
  return resultDraft;
}

async function route(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type, X-AskLake-User, X-AskLake-Role",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/health") {
    const dbResult = await pool.query("SELECT 1 AS ok");
    sendJson(response, 200, { databaseUrl, ok: dbResult.rows[0].ok === 1 });
    return;
  }

  if (request.method === "GET" && path === "/api/etl/jobs") {
    sendJson(response, 200, { jobs: await listJobs(), page: { cursor: null, hasNext: false } });
    return;
  }

  if (request.method === "GET" && path === "/api/catalog/datasets") {
    sendJson(response, 200, { datasets: await listDatasets(), page: { cursor: null, hasNext: false } });
    return;
  }

  if (request.method === "GET" && path === "/api/dashboards") {
    sendJson(response, 200, await queryDashboards({ page: 1, pageSize: 10, sort: "updated-desc" }));
    return;
  }

  if (request.method === "POST" && path === "/api/dashboards/query") {
    sendJson(response, 200, await queryDashboards(await readJson(request)));
    return;
  }

  if (request.method === "POST" && path === "/api/dashboards") {
    const dashboard = await createDashboard(await readJson(request), getRequestActor(request));
    sendJson(response, 201, { dashboard });
    return;
  }

  const publishedDashboardMatch = path.match(/^\/api\/dashboards\/([^/]+)\/published$/);
  if (request.method === "GET" && publishedDashboardMatch) {
    const dashboardId = decodeURIComponent(publishedDashboardMatch[1]);
    const payload = await getPublishedDashboardRuntime(dashboardId);
    if (!payload) {
      sendError(response, 404, "NOT_FOUND", "Dashboard not found");
      return;
    }
    sendJson(response, 200, payload);
    return;
  }

  const draftEnsureMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/ensure$/);
  if (request.method === "POST" && draftEnsureMatch) {
    const dashboardId = decodeURIComponent(draftEnsureMatch[1]);
    const payload = await ensureDraftDashboardRuntime(dashboardId);
    if (!payload) {
      sendError(response, 404, "NOT_FOUND", "Dashboard not found");
      return;
    }
    sendJson(response, 200, payload);
    return;
  }

  const draftPagesMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/pages$/);
  if (request.method === "POST" && draftPagesMatch) {
    const dashboardId = decodeURIComponent(draftPagesMatch[1]);
    const page = await createDraftDashboardPage(dashboardId, await readJson(request));
    if (!page) {
      sendError(response, 404, "NOT_FOUND", "Dashboard draft not found");
      return;
    }
    sendJson(response, 201, page);
    return;
  }

  const draftPageTitleMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/pages\/([^/]+)$/);
  if (request.method === "PATCH" && draftPageTitleMatch) {
    const dashboardId = decodeURIComponent(draftPageTitleMatch[1]);
    const pageId = decodeURIComponent(draftPageTitleMatch[2]);
    const { title } = await readJson(request);
    const page = await updateDraftDashboardPageTitle(dashboardId, pageId, title);
    if (!page) {
      sendError(response, 404, "NOT_FOUND", "Dashboard draft page not found");
      return;
    }
    if (page.error) {
      sendError(response, page.error.status, page.error.code, page.error.message);
      return;
    }
    sendJson(response, 200, page);
    return;
  }

  const draftWidgetsMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/pages\/([^/]+)\/widgets$/);
  if (request.method === "POST" && draftWidgetsMatch) {
    const dashboardId = decodeURIComponent(draftWidgetsMatch[1]);
    const pageId = decodeURIComponent(draftWidgetsMatch[2]);
    const widget = await createDraftDashboardWidget(dashboardId, pageId, await readJson(request));
    if (!widget) {
      sendError(response, 404, "NOT_FOUND", "Dashboard draft page not found");
      return;
    }
    sendJson(response, 201, widget);
    return;
  }

  const draftWidgetDeleteMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/widgets\/([^/]+)$/);
  if (request.method === "PATCH" && draftWidgetDeleteMatch) {
    const dashboardId = decodeURIComponent(draftWidgetDeleteMatch[1]);
    const widgetId = decodeURIComponent(draftWidgetDeleteMatch[2]);
    const widget = await updateDraftDashboardWidget(dashboardId, widgetId, await readJson(request));
    if (!widget) {
      sendError(response, 404, "NOT_FOUND", "Dashboard draft widget not found");
      return;
    }
    sendJson(response, 200, widget);
    return;
  }

  if (request.method === "DELETE" && draftWidgetDeleteMatch) {
    const dashboardId = decodeURIComponent(draftWidgetDeleteMatch[1]);
    const widgetId = decodeURIComponent(draftWidgetDeleteMatch[2]);
    const result = await deleteDraftDashboardWidget(dashboardId, widgetId);
    if (!result) {
      sendError(response, 404, "NOT_FOUND", "Dashboard draft widget not found");
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  const draftPageDeleteMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/pages\/([^/]+)$/);
  if (request.method === "DELETE" && draftPageDeleteMatch) {
    const dashboardId = decodeURIComponent(draftPageDeleteMatch[1]);
    const pageId = decodeURIComponent(draftPageDeleteMatch[2]);
    const result = await deleteDraftDashboardPage(dashboardId, pageId);
    if (!result) {
      sendError(response, 404, "NOT_FOUND", "Dashboard draft page not found");
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  const draftLayoutsMatch = path.match(/^\/api\/dashboards\/([^/]+)\/draft\/layouts$/);
  if (request.method === "PATCH" && draftLayoutsMatch) {
    const dashboardId = decodeURIComponent(draftLayoutsMatch[1]);
    const result = await saveDraftDashboardLayouts(dashboardId, await readJson(request));
    if (!result) {
      sendError(response, 404, "NOT_FOUND", "Draft page or widgets not found");
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  const publishDashboardMatch = path.match(/^\/api\/dashboards\/([^/]+)\/publish$/);
  if (request.method === "POST" && publishDashboardMatch) {
    const dashboardId = decodeURIComponent(publishDashboardMatch[1]);
    const result = await publishDashboardRuntime(dashboardId);
    if (!result) {
      sendError(response, 404, "NOT_FOUND", "Dashboard not found");
      return;
    }
    if (result.error) {
      sendError(response, result.error.status, result.error.code, result.error.message);
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && path === "/api/etl/jobs") {
    const payload = await createPipeline(await readJson(request));
    sendJson(response, 201, payload);
    return;
  }

  const commandMatch = path.match(/^\/api\/etl\/jobs\/([^/]+)\/commands$/);
  if (request.method === "POST" && commandMatch) {
    const jobId = decodeURIComponent(commandMatch[1]);
    const job = await getJob(jobId);
    if (!job) {
      sendError(response, 404, "NOT_FOUND", "Job not found");
      return;
    }
    const { command } = await readJson(request);
    if (!["run", "retry", "pause", "cancelRun", "stopSchedule"].includes(command)) {
      sendError(response, 400, "VALIDATION_ERROR", "Unsupported command");
      return;
    }
    if (command === "run" && job.status === "running") {
      sendError(response, 409, "CONFLICT", "Job is already running");
      return;
    }
    if (command === "pause" && job.status !== "running") {
      sendError(response, 422, "INVALID_JOB_STATE", "Job cannot be paused from this status");
      return;
    }
    if (command === "cancelRun" && job.status !== "running") {
      sendError(response, 422, "INVALID_JOB_STATE", "Current run cannot be canceled from this status");
      return;
    }
    if (command === "stopSchedule" && !hasScheduledExecution(job)) {
      sendError(response, 422, "INVALID_JOB_STATE", "Job has no schedule to stop");
      return;
    }
    const result = buildCommandResult(job, command);
    await saveJob(result.job);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && path === "/api/query/runs") {
    const result = await executeQuery(await readJson(request));
    if (result.error) {
      sendError(response, result.error.status, result.error.code, result.error.message);
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  const dashboardMatch = path.match(/^\/api\/dashboards\/([^/]+)$/);
  if (request.method === "PUT" && dashboardMatch) {
    const dashboardId = decodeURIComponent(dashboardMatch[1]);
    const dashboard = { ...(await readJson(request)), id: dashboardId };
    await saveDashboard(dashboard);
    sendJson(response, 200, { dashboard });
    return;
  }

  if (request.method === "PATCH" && dashboardMatch) {
    const dashboardId = decodeURIComponent(dashboardMatch[1]);
    const body = await readJson(request);
    const title = body.title ?? body.name;
    const dashboard = await updateDashboardTitle(dashboardId, title);
    if (!dashboard) {
      sendError(response, 404, "NOT_FOUND", "Dashboard not found");
      return;
    }
    if (dashboard.error) {
      sendError(response, dashboard.error.status, dashboard.error.code, dashboard.error.message);
      return;
    }
    sendJson(response, 200, { dashboard });
    return;
  }

  if (request.method === "DELETE" && dashboardMatch) {
    const dashboardId = decodeURIComponent(dashboardMatch[1]);
    const dashboard = await getDashboard(dashboardId);
    if (!dashboard) {
      sendError(response, 404, "NOT_FOUND", "Dashboard not found");
      return;
    }

    const actor = getRequestActor(request);
    if (!canDeleteDashboard(actor, dashboard)) {
      sendError(response, 403, "FORBIDDEN", "Only the dashboard owner or an admin can delete this dashboard");
      return;
    }

    await deleteDashboard(dashboardId);
    sendJson(response, 200, { deletedDashboardId: dashboardId });
    return;
  }

  sendError(response, 404, "NOT_FOUND", "Route not found");
}

async function start() {
  await seedDatabase();
  await ensureSchema();

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      console.error(error);
      sendError(response, 500, "INTERNAL_ERROR", error.message);
    });
  });

  server.listen(port, () => {
    console.log(`AskLake API listening on http://localhost:${port}`);
    console.log(`Postgres: ${databaseUrl}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
