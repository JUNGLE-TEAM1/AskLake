import { randomUUID } from "node:crypto";

const baseUrl = (process.env.AIRFLOW_API_BASE_URL || "http://127.0.0.1:8081").replace(/\/$/, "");
const dagId = process.env.AIRFLOW_DAG_ID || "asklake_etl_job";
const username = process.env.AIRFLOW_USERNAME || "airflow";
const password = process.env.AIRFLOW_PASSWORD || "airflow";
const configuredToken = process.env.AIRFLOW_API_TOKEN || "";
const pollIntervalMs = positiveNumber(process.env.ASKLAKE_AIRFLOW_SMOKE_POLL_INTERVAL_MS, 1000);
const timeoutMs = positiveNumber(process.env.ASKLAKE_AIRFLOW_SMOKE_TIMEOUT_MS, 120000);
const terminalStates = new Set(["success", "failed", "canceled"]);
const expectedTaskIds = [
  "receive_asklake_run",
  "validate_spark_request",
  "spark_process_write",
  "publish_run_result",
];

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runSmoke() {
  await assertRuntimeHealth();
  const token = configuredToken || await createAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const dag = await requestJson(`/api/v2/dags/${encodeURIComponent(dagId)}`, { headers });
  assert(dag.dag_id === dagId, `Airflow did not return the expected DAG: ${dagId}`);
  assert(dag.is_paused === false, `Airflow DAG must be unpaused for smoke execution: ${dagId}`);

  const importErrors = await requestJson("/api/v2/importErrors?limit=100", { headers });
  assert(
    Number(importErrors.total_entries || 0) === 0,
    `Airflow reported DAG import errors: ${JSON.stringify(importErrors.import_errors || [])}`,
  );

  const successRun = await triggerRun(headers, "success", false);
  const completedSuccessRun = await waitForTerminalRun(headers, successRun.dag_run_id);
  assert(
    completedSuccessRun.state === "success",
    `Expected successful DAG Run, received ${completedSuccessRun.state}: ${successRun.dag_run_id}`,
  );
  const successTasks = await listTaskInstances(headers, successRun.dag_run_id);
  for (const taskId of expectedTaskIds) {
    assert(
      successTasks.get(taskId)?.state === "success",
      `Expected ${taskId}=success, received ${successTasks.get(taskId)?.state || "missing"}.`,
    );
  }
  assert(
    Number(successTasks.get("publish_run_result")?.max_tries) === 2,
    `Expected publish_run_result max_tries=2, received ${successTasks.get("publish_run_result")?.max_tries ?? "missing"}.`,
  );

  const failedRun = await triggerRun(headers, "failure", true);
  const completedFailedRun = await waitForTerminalRun(headers, failedRun.dag_run_id);
  assert(
    completedFailedRun.state === "failed",
    `Expected failed DAG Run, received ${completedFailedRun.state}: ${failedRun.dag_run_id}`,
  );
  const failedTasks = await listTaskInstances(headers, failedRun.dag_run_id);
  assert(
    failedTasks.get("spark_process_write")?.state === "failed",
    `Expected spark_process_write=failed, received ${failedTasks.get("spark_process_write")?.state || "missing"}.`,
  );

  console.log(`verify-airflow-smoke: success run ${successRun.dag_run_id} -> success`);
  console.log(`verify-airflow-smoke: failure run ${failedRun.dag_run_id} -> failed`);
  console.log("verify-airflow-smoke: ok");
}

async function assertRuntimeHealth() {
  const health = await requestJson("/api/v2/monitor/health");
  assert(health.metadatabase?.status === "healthy", "Airflow metadata database is not healthy.");
  assert(health.scheduler?.status === "healthy", "Airflow scheduler is not healthy.");
  assert(health.dag_processor?.status === "healthy", "Airflow DAG processor is not healthy.");
}

async function createAccessToken() {
  const response = await requestJson("/auth/token", {
    body: JSON.stringify({ username, password }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert(response.access_token, "Airflow auth response did not include access_token.");
  return response.access_token;
}

async function triggerRun(headers, label, forceFail) {
  const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const dagRunId = `asklake_smoke_${label}_${suffix}`;
  const response = await requestJson(
    `/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns`,
    {
      body: JSON.stringify({
        conf: {
          executionMode: "smoke",
          forceFail,
          job: { schemaSampleRows: [["C-001", "42.5"], ["C-002", "17.25"]] },
          jobId: `airflow-smoke-${label}`,
          runId: dagRunId,
          smokeCatalogSeconds: 0,
          smokeProcessSeconds: 0,
          smokeReadSeconds: 0,
          smokeReceiveSeconds: 0,
        },
        dag_run_id: dagRunId,
        logical_date: null,
      }),
      headers: { ...headers, "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert(response.dag_run_id === dagRunId, "Airflow trigger response did not preserve dag_run_id.");
  return response;
}

async function waitForTerminalRun(headers, dagRunId) {
  const deadline = Date.now() + timeoutMs;
  let latestState = "unknown";
  while (Date.now() < deadline) {
    const run = await requestJson(
      `/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}`,
      { headers },
    );
    latestState = run.state || "unknown";
    if (terminalStates.has(latestState)) return run;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Airflow DAG Run did not finish within ${timeoutMs}ms: ${dagRunId} (${latestState})`);
}

async function listTaskInstances(headers, dagRunId) {
  const payload = await requestJson(
    `/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}/taskInstances?limit=100`,
    { headers },
  );
  assert(Array.isArray(payload.task_instances), "Airflow task response did not include task_instances.");
  return new Map(payload.task_instances.map((task) => [task.task_id, task]));
}

async function requestJson(route, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      ...options,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`Airflow API request failed: ${route}\n${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Airflow API ${response.status}: ${route}\n${JSON.stringify(payload)}`);
  }
  return payload;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
