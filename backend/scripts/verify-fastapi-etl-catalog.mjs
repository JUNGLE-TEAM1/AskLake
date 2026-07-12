import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_FASTAPI_ETL_SMOKE_PORT || 18085);
const baseUrl = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_START_SERVER !== "false";
const airflowPort = Number(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_MOCK_PORT || 18086);
const airflowBaseUrl = process.env.AIRFLOW_API_BASE_URL || `http://127.0.0.1:${airflowPort}`;
const airflowDagId = process.env.AIRFLOW_DAG_ID || "asklake_etl_job";
const airflowInternalToken = process.env.AIRFLOW_INTERNAL_TOKEN || "asklake-etl-smoke-token";
const shouldStartAirflowMock = !process.env.AIRFLOW_API_BASE_URL && process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_MOCK !== "false";
const airflowSyncPollIntervalMs = positiveNumber(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_POLL_INTERVAL_MS, 1000);
const airflowSyncTimeoutMs = positiveNumber(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_TIMEOUT_MS, 600000);
const configuredSparkOutputMode = process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local";
const expectSparkFailure = process.env.ASKLAKE_FASTAPI_ETL_EXPECT_SPARK_FAILURE === "true";
const smokeProfile = process.env.ASKLAKE_FASTAPI_ETL_PROFILE || "default";
const env = {
  ...process.env,
  AIRFLOW_API_BASE_URL: airflowBaseUrl,
  AIRFLOW_DAG_ID: airflowDagId,
  AIRFLOW_EXECUTION_API_TOKEN: process.env.AIRFLOW_EXECUTION_API_TOKEN || "asklake-local-airflow-execution",
  AIRFLOW_INTERNAL_TOKEN: airflowInternalToken,
  AIRFLOW_REQUEST_TIMEOUT_SECONDS: process.env.AIRFLOW_REQUEST_TIMEOUT_SECONDS || "5",
  AIRFLOW_UI_BASE_URL: process.env.AIRFLOW_UI_BASE_URL || airflowBaseUrl,
  ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE
    || (
      configuredSparkOutputMode.toLowerCase() === "s3a" || smokeProfile === "synthetic-commerce"
        ? "org.apache.hadoop:hadoop-aws:3.4.1"
        : "none"
    ),
  ASKLAKE_SPARK_OUTPUT_MODE: configuredSparkOutputMode,
  ASKLAKE_SPARK_RUN_ROW_LIMIT: process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT
    || (smokeProfile === "synthetic-commerce" ? "0" : "2"),
  LOCAL_LAKE_STORAGE_DIR: process.env.LOCAL_LAKE_STORAGE_DIR || path.join(backendDir, "tmp", "smoke-lake"),
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;
let airflowServer = null;
let smokeJobId = "";
let smokeDatasetId = "";
let smokeRunId = "";
let smokeOutputPath = "";
let smokeSqlRunId = "";
const mockAirflowRuns = new Map();

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await cleanupSmokeResources();
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (airflowServer) await closeServer(airflowServer);
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
  if (shouldStartAirflowMock) airflowServer = await startMockAirflowServer();
  if (shouldStartServer) serverProcess = startFastApiServer();

  await waitForHealth();
  await assertInternalExecutionAuth();

  if (smokeProfile === "synthetic-commerce") {
    await runSyntheticCommerceSmoke();
    return;
  }

  const suffix = Date.now().toString(36);
  const targetDataset = `fastapi_etl_catalog_smoke_${suffix}`;
  const sparkOutputMode = String(env.ASKLAKE_SPARK_OUTPUT_MODE || "local").toLowerCase();
  const targetStoragePath = sparkOutputMode === "s3a"
    ? `s3a://${process.env.ASKLAKE_FASTAPI_ETL_OUTPUT_BUCKET || "asklake-output"}/phase2/${targetDataset}`
    : "";
  const create = await post("/api/etl/jobs", {
    id: `fastapi-etl-catalog-${suffix}`,
    jobName: `FastAPI ETL Catalog Smoke ${suffix}`,
    owner: "admin",
    permissionRoles: [{ access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" }],
    permissionSummary: "admin",
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "FastAPI ETL catalog payload smoke",
    transformOutputColumns: [["customer_id", "string"], ["amount", "double"]],
    transformSteps: [],
    qualityInvalidRows: [],
    qualityRules: expectSparkFailure ? [{
      enabled: true,
      failureAction: "Fail Run",
      id: "phase2-negative-amount",
      kind: "range",
      params: "",
      severity: "Error",
      targetColumn: "amount",
      validationType: "Range Check",
    }] : [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: [
      { included: true, nullable: false, sourceName: "customer_id", targetName: "customer_id", type: "String" },
      { included: true, nullable: false, sourceName: "amount", targetName: "amount", type: "Float" },
    ],
    schemaSampleRows: [["C-001", expectSparkFailure ? "-42.5" : "42.5"], ["C-002", "17.25"]],
    schemaSummary: "FastAPI ETL catalog payload smoke schema",
    sourceConfig: [["Endpoint", "sample://inline"], ["__Sample Row Limit", "2"]],
    sourceLabel: "inline sample rows",
    sourceType: "REST API",
    targetDataset,
    compression: "Snappy",
    partition: "customer_id/amount",
    storagePath: targetStoragePath,
    storageType: sparkOutputMode === "s3a" ? "S3" : "Local",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });

  assert(create.job?.id, "ETL job create response should include job.id.");
  assert(create.job?.partition === "customer_id/amount", "ETL job should preserve multi-column partition metadata.");
  assert(create.catalogTarget?.id, "ETL job create response should include catalogTarget.id.");
  smokeJobId = create.job.id;
  smokeDatasetId = create.catalogTarget.id;

  const command = await post(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, { command: "run" });
  assert(command.action === "etl.run.requested", "ETL run command should return the run requested action.");
  assert(command.run?.status === "queued", `Airflow submit should create a queued run: ${command.run?.errorSummary}`);
  assert(command.run?.airflowDagId === airflowDagId, "Run summary should include the configured Airflow DAG id.");
  assert(command.run?.airflowDagRunId, "Run summary should include the Airflow DAG Run id.");
  assert(command.run?.airflowState === "queued", "Initial Airflow state should be queued.");
  assert(command.run?.airflowRunUrl?.includes(command.run.airflowDagRunId), "Run summary should include an Airflow UI URL.");
  smokeRunId = command.run.runId;
  assert(!command.dataset, "Airflow submit is asynchronous and should not create a catalog dataset in the command response.");
  assert(command.dagSteps?.some((step) => step.id === "airflow-submit"), "Command response should include an Airflow submit DAG step.");
  if (shouldStartAirflowMock) {
    await assertCatalogNotReady(create.job.id, command.run.airflowDagRunId);
  }

  if (shouldStartAirflowMock) {
    const execution = await postExecution(
      `/api/internal/airflow/spark-runs/${encodeURIComponent(command.run.runId)}/execute`,
      { command: "run", jobId: create.job.id },
    );
    if (expectSparkFailure) {
      assert(execution.status === "failed", "Expected quality failure should persist a failed Spark manifest.");
      const mockRun = mockAirflowRuns.get(command.run.airflowDagRunId);
      if (mockRun) mockRun.state = "failed";
    } else {
      assert(execution.status === "success", `Airflow worker should execute the real Spark path: ${execution.error}`);
      assert(Number(execution.outputRows) === 2, `Spark execution should persist the two inline rows: ${execution.outputRows}`);
      smokeOutputPath = execution.outputPath;
      const catalogResult = await postExecution(
        `/api/internal/airflow/spark-runs/${encodeURIComponent(command.run.runId)}/catalog`,
        { jobId: create.job.id },
      );
      assert(catalogResult.dataset?.id === create.catalogTarget.id, "Catalog reconciliation should persist the target dataset.");
    }
  }

  const syncedJob = await waitForTerminalJob(create.job.id);
  const latestRun = syncedJob.runHistory?.[0];
  if (expectSparkFailure) {
    assert(latestRun?.status === "failed", `Spark quality failure should fail the AskLake Run: ${latestRun?.status}`);
    assert(latestRun?.airflowState === "failed", "Spark quality failure should fail the Airflow DAG Run.");
    assert(latestRun?.taskStates?.spark_process_write?.airflowState === "failed", "Spark task should expose failed state.");
    assert(latestRun?.taskStates?.sparkResult?.status === "failed", "Failed Spark manifest should be preserved.");
    assert(latestRun?.taskStates?.sparkResult?.failedStage === "Quality", "Spark manifest should identify the Quality stage.");
    assert(syncedJob.status === "failed", "Job should expose failed status after Spark quality failure.");
    if (!shouldStartAirflowMock) {
      const catalogList = await get("/api/catalog/datasets");
      assert(
        !catalogList.datasets?.some((dataset) => dataset.id === create.catalogTarget.id),
        "Spark failure must not publish the target Catalog dataset.",
      );
    }
    console.log("verify-fastapi-etl-catalog: expected Spark failure ok");
    return;
  }
  assert(latestRun?.status === "success", `Airflow sync should update the run to success: ${latestRun?.syncError}`);
  assert(latestRun?.airflowState === "success", "Synced run should keep the Airflow success state.");
  assert(latestRun?.taskStates?.publish_run_result?.airflowState === "success", "Synced run should include task instance states.");
  if (!shouldStartAirflowMock) {
    assert(latestRun?.taskStates?.sparkResult?.status === "success", "Synced run should preserve the Spark result manifest.");
    assert(Number(latestRun?.taskStates?.sparkResult?.outputRows) === 2, "Spark should write the two input rows.");
    await assertPhysicalParquet(latestRun?.outputPath);
    assert(latestRun?.taskStates?.catalogResult?.status === "success", "Catalog publication should persist a successful catalogResult.");
    assert(latestRun?.taskStates?.catalogResult?.runId === latestRun.runId, "Catalog result should preserve the AskLake Run id.");

    const catalogDataset = await get(`/api/catalog/datasets/${encodeURIComponent(create.catalogTarget.id)}`);
    assert(catalogDataset.sourceRunId === latestRun.runId, "Catalog dataset should point to the successful Run id.");
    assert(catalogDataset.storageLocation === latestRun.outputPath, "Catalog storageLocation should match the Spark outputPath.");
    assert(catalogDataset.storageFormat === "parquet", "Catalog storage format should be Parquet.");
    assert(Number(catalogDataset.storageSizeBytes) > 0, "Catalog dataset should persist positive physical bytes.");
    assert(
      catalogDataset.materializationRuns?.filter((run) => run.runId === latestRun.runId).length === 1,
      "Catalog dataset should contain one materialization for the successful Run.",
    );
    assert(catalogDataset.lineageGraph?.datasets?.length === 3, "Catalog lineage should contain source, Spark Job, and target nodes.");
  }
  smokeOutputPath = latestRun?.outputPath || smokeOutputPath;
  assert(syncedJob.status === "scheduled", "Job should return to scheduled after a successful Airflow sync.");
  assert(syncedJob.dagSteps?.some((step) => step.id === "publish_run_result" && step.status === "success"), "Synced job should expose Airflow task DAG steps.");

  const catalog = await get("/api/catalog/datasets");
  const materialized = catalog.datasets?.find((dataset) => dataset.id === create.catalogTarget.id);
  assert(materialized, "Successful Airflow/Spark execution should be visible in Catalog hydrate.");
  assert(materialized.sourceRunId === command.run.runId, "Catalog dataset should point to the successful Airflow run.");
  assert(materialized.materializationRuns?.length === 1, "Idempotent Airflow execution should create one materialization run.");
  const sourceLineageNode = materialized.lineageGraph?.datasets?.find((dataset) => dataset.layer === "SOURCE");
  const processLineageNode = materialized.lineageGraph?.datasets?.find((dataset) => dataset.layer === "PROCESS");
  const targetLineageNode = materialized.lineageGraph?.datasets?.find((dataset) => dataset.id === create.catalogTarget.id);
  assert(
    JSON.stringify(sourceLineageNode?.columns?.map((column) => column.name)) === JSON.stringify(["customer_id", "amount"]),
    "ETL lineage source node should contain source columns without Spark-generated metadata.",
  );
  assert(sourceLineageNode?.engine === "REST API", "ETL lineage source engine should match the source connector or file format.");
  assert(
    !materialized.lineageGraph?.edges?.some((edge) => edge.fromDatasetId === sourceLineageNode?.id && edge.toColumnId.includes("asklake")),
    "Spark-generated metadata columns should not have source lineage edges.",
  );
  assert(processLineageNode?.engine === "SPARK", "ETL lineage should represent the Spark job as a PROCESS node.");
  assert(targetLineageNode?.engine === "PARQUET", "ETL lineage target engine should match the persisted Spark output format.");

  await del(`/api/catalog/datasets/${encodeURIComponent(materialized.id)}/materialization-runs/${encodeURIComponent(command.run.runId)}`);
  const jobAfterMaterializationDelete = await get(`/api/etl/jobs/${encodeURIComponent(create.job.id)}`);
  assert(
    jobAfterMaterializationDelete.runHistory?.find((run) => run.runId === command.run.runId)?.status === "success",
    "Deleting an append result should not rewrite the historical Spark run as failed.",
  );

  console.log("verify-fastapi-etl-catalog: ok");
}

async function runSyntheticCommerceSmoke() {
  assert(shouldStartAirflowMock, "Synthetic commerce smoke requires the built-in Airflow mock.");
  const manifestPath = process.env.ASKLAKE_SYNTHETIC_COMMERCE_MANIFEST
    || path.join(backendDir, "tmp", "synthetic-commerce-256mib", "manifest.json");
  assert(existsSync(manifestPath), `Synthetic commerce manifest does not exist: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedRows = Number(manifest.counts?.event_count || 0);
  const expectedSessionCounts = manifest.counts?.event_type_session_counts || {};
  assert(expectedRows > 0, "Synthetic commerce manifest should include a positive event_count.");
  assert(
    Number(manifest.files?.["commerce_events.jsonl"]?.bytes) <= 256 * 1024 * 1024,
    "Synthetic commerce event file should not exceed 256 MiB.",
  );

  const sourceBucket = process.env.ASKLAKE_SYNTHETIC_COMMERCE_BUCKET || "m3-raw";
  const sourceKey = process.env.ASKLAKE_SYNTHETIC_COMMERCE_KEY
    || "synthetic-commerce/issue-623/commerce_events-256mib.jsonl";
  const sourceConfig = [
    ["Storage Provider", "MinIO"],
    ["Endpoint URL", process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000"],
    ["Region", process.env.MINIO_REGION || "us-east-1"],
    ["Bucket / Stage Name", sourceBucket],
    ["Path / Prefix", sourceKey],
    ["File Type", "JSONL"],
    ["__Selected Object", sourceKey],
    ["__Sample Object", sourceKey],
    ["Access Key", process.env.MINIO_ACCESS_KEY || "m3admin"],
    ["Secret Key", process.env.MINIO_SECRET_KEY || "wishuponastar"],
    ["Use Path Style", "true"],
    ["__Schema Sample Scope", "full"],
    ["__Source Unit Count", "1"],
  ];
  const sourceTest = await post("/api/etl/sources/test", {
    sourceConfig,
    sourceType: "File / S3",
  });
  assert(sourceTest.status === "success", "Synthetic commerce MinIO source test should succeed.");
  const inferredColumns = sourceTest.draftPatch?.schema?.columns || [];
  const requiredNames = [
    "event_id",
    "schema_version",
    "event_source",
    "user_id",
    "session_id",
    "event_time",
    "event_type",
    "product_id",
    "device_type",
    "referrer",
  ];
  const inferredByName = new Map(
    inferredColumns.map((column) => [column.sourceName || column.targetName, column]),
  );
  const schemaColumns = requiredNames.map((name) => {
    const column = inferredByName.get(name);
    assert(column, `Source schema inference should include ${name}.`);
    return { ...column, included: true, nullable: false, sourceName: name, targetName: name };
  });
  const sourceColumnIndexes = schemaColumns.map((column) => (
    inferredColumns.findIndex((candidate) => (
      (candidate.sourceName || candidate.targetName) === column.sourceName
    ))
  ));
  const schemaSampleRows = (sourceTest.draftPatch?.schema?.sampleRows || []).map((row) => (
    sourceColumnIndexes.map((index) => row[index])
  ));

  const suffix = Date.now().toString(36);
  const targetDataset = `synthetic_commerce_256mib_${suffix}`;
  const create = await post("/api/etl/jobs", {
    id: `synthetic-commerce-256mib-${suffix}`,
    jobName: `Synthetic Commerce 256MiB ${suffix}`,
    owner: "admin",
    permissionRoles: [{ access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" }],
    permissionSummary: "admin",
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "256MiB single-object full Spark validation",
    transformOutputColumns: schemaColumns.map((column) => [column.targetName, column.type]),
    transformSteps: [],
    qualityInvalidRows: [],
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns,
    schemaSampleRows,
    schemaSummary: sourceTest.draftPatch?.schema?.summary || "Synthetic commerce JSONL schema",
    sourceConfig,
    sourceLabel: `${sourceBucket}/${sourceKey}`,
    sourceType: "File / S3",
    targetDataset,
    compression: "Snappy",
    partition: "event_type",
    partitionColumns: ["event_type"],
    storagePath: "",
    storageType: "Local",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });
  assert(create.job?.id, "Synthetic commerce ETL create response should include job.id.");
  smokeJobId = create.job.id;
  smokeDatasetId = create.catalogTarget.id;

  const command = await post(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, {
    command: "run",
  });
  smokeRunId = command.run?.runId || "";
  assert(command.run?.status === "queued", "Synthetic commerce run should be queued.");
  const execution = await postExecution(
    `/api/internal/airflow/spark-runs/${encodeURIComponent(smokeRunId)}/execute`,
    { command: "run", jobId: create.job.id },
  );
  assert(execution.status === "success", `Synthetic commerce Spark execution failed: ${execution.error}`);
  assert(Number(execution.inputRows) === expectedRows, `Spark input rows should equal manifest: ${execution.inputRows} != ${expectedRows}`);
  assert(Number(execution.outputRows) === expectedRows, `Spark output rows should equal manifest: ${execution.outputRows} != ${expectedRows}`);
  smokeOutputPath = execution.outputPath;
  const catalogResult = await postExecution(
    `/api/internal/airflow/spark-runs/${encodeURIComponent(smokeRunId)}/catalog`,
    { jobId: create.job.id },
  );
  assert(catalogResult.dataset?.id === create.catalogTarget.id, "Catalog should publish the Spark result.");

  const syncedJob = await waitForTerminalJob(create.job.id);
  const latestRun = syncedJob.runHistory?.find((run) => run.runId === smokeRunId);
  assert(latestRun?.status === "success", `Synthetic commerce run should finish successfully: ${latestRun?.status}`);
  assert(
    Number(latestRun?.taskStates?.sparkResult?.inputRows) === expectedRows,
    "Persisted Spark result inputRows should equal the manifest.",
  );
  await assertPhysicalParquet(latestRun?.outputPath);
  const catalogDataset = await get(`/api/catalog/datasets/${encodeURIComponent(create.catalogTarget.id)}`);
  assert(catalogDataset.storageFormat === "parquet", "Catalog should expose Parquet storage format.");
  assert(Number(catalogDataset.storageSizeBytes) > 0, "Catalog should expose positive Parquet bytes.");

  const quotedTable = `"${targetDataset.replaceAll('"', '""')}"`;
  const query = `SELECT COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'product_impression') AS impression_sessions, COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'purchase_click') AS purchase_click_sessions, COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'order_completed') AS order_completed_sessions, ROUND(100.0 * COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'order_completed') / COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'product_impression'), 3) AS session_order_conversion_pct FROM ${quotedTable}`;
  const preview = await post("/api/query/runs", {
    baseDatasetId: catalogDataset.id,
    datasetId: catalogDataset.id,
    limit: 10,
    mode: "preview",
    query,
    referenceDatasetIds: [],
    validationKey: `${catalogDataset.id}:${query}`,
  });
  smokeSqlRunId = preview.runId;
  assert(preview.rowCount === 1, "Synthetic commerce SQL preview should return one insight row.");
  const [impressionSessions, purchaseClickSessions, orderCompletedSessions, conversionPct] = (
    preview.rows[0].map(Number)
  );
  assert(impressionSessions === Number(expectedSessionCounts.product_impression), "SQL impression sessions should equal the manifest.");
  assert(purchaseClickSessions === Number(expectedSessionCounts.purchase_click), "SQL purchase-click sessions should equal the manifest.");
  assert(orderCompletedSessions === Number(expectedSessionCounts.order_completed), "SQL order sessions should equal the manifest.");
  assert(Math.abs(conversionPct - Number(manifest.counts.order_completed_session_conversion_pct)) < 0.001, "SQL conversion should equal the generator analysis.");

  console.log(JSON.stringify({
    catalogDatasetId: catalogDataset.id,
    inputRows: Number(execution.inputRows),
    outputRows: Number(execution.outputRows),
    parquetBytes: Number(catalogDataset.storageSizeBytes),
    sourceColumns: inferredColumns.map((column) => column.sourceName || column.targetName),
    sqlInsight: {
      impressionSessions,
      purchaseClickSessions,
      orderCompletedSessions,
      sessionOrderConversionPct: conversionPct,
    },
  }, null, 2));
  console.log("verify-fastapi-etl-catalog: synthetic-commerce ok");
}

async function assertInternalExecutionAuth() {
  for (const endpoint of ["execute", "catalog"]) {
    const response = await fetch(`${baseUrl}/api/internal/airflow/spark-runs/not-a-run/${endpoint}`, {
      body: JSON.stringify(endpoint === "execute" ? { command: "run", jobId: "not-a-job" } : { jobId: "not-a-job" }),
      headers: {
        Authorization: "Bearer invalid-phase2-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const payload = await readPayload(response);
    assert(response.status === 401, `Internal ${endpoint} endpoint should reject an invalid token: ${response.status}`);
    assert(payload?.error?.code === "AIRFLOW_EXECUTION_UNAUTHORIZED", `Internal ${endpoint} auth should return the expected error code.`);
  }

  const legacyResponse = await fetch(`${baseUrl}/api/etl/internal/airflow/jobs/not-a-job/runs/not-a-run/execute`, {
    body: JSON.stringify({ command: "run" }),
    headers: {
      "Content-Type": "application/json",
      "X-AskLake-Airflow-Token": "invalid-phase2-token",
    },
    method: "POST",
  });
  assert(legacyResponse.status === 403, "Legacy internal Airflow endpoint should reject an invalid token.");
}

async function assertCatalogNotReady(jobId, runId) {
  const response = await fetch(`${baseUrl}/api/internal/airflow/spark-runs/${encodeURIComponent(runId)}/catalog`, {
    body: JSON.stringify({ jobId }),
    headers: {
      Authorization: `Bearer ${env.AIRFLOW_EXECUTION_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = await readPayload(response);
  assert(response.status === 409, `Catalog endpoint should wait for persisted Spark success: ${response.status}`);
  assert(payload?.error?.code === "SPARK_RESULT_NOT_READY", "Catalog endpoint should expose SPARK_RESULT_NOT_READY.");
}

async function assertPhysicalParquet(outputPath) {
  assert(outputPath, "Spark success should persist an output path.");
  const match = String(outputPath).match(/^s3a?:\/\/([^/]+)\/(.+)$/i);
  if (match) {
    const client = new S3Client({
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || "m3admin",
        secretAccessKey: process.env.MINIO_SECRET_KEY || "wishuponastar",
      },
      endpoint: process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000",
      forcePathStyle: true,
      region: process.env.MINIO_REGION || "us-east-1",
    });
    const listed = await client.send(new ListObjectsV2Command({ Bucket: match[1], Prefix: match[2] }));
    assert(
      listed.Contents?.some((entry) => entry.Key?.endsWith(".parquet")),
      `MinIO output prefix has no Parquet object: ${outputPath}`,
    );
    return;
  }
  assert(existsSync(outputPath), `Spark output path does not exist: ${outputPath}`);
  assert(hasParquetFile(outputPath), `Spark output path has no Parquet file: ${outputPath}`);
}

function hasParquetFile(dir) {
  return readdirSync(dir, { withFileTypes: true }).some((entry) => (
    entry.isDirectory()
      ? hasParquetFile(path.join(dir, entry.name))
      : entry.name.endsWith(".parquet")
  ));
}

async function cleanupSmokeResources() {
  if (smokeJobId) {
    const client = new pg.Client({
      connectionString: env.DATABASE_URL || "postgresql://asklake:asklake_dev@127.0.0.1:54328/asklake",
    });
    try {
      await client.connect();
      await client.query("BEGIN");
      if (smokeSqlRunId) await client.query("DELETE FROM sql_runs WHERE id = $1", [smokeSqlRunId]);
      if (smokeDatasetId) await client.query("DELETE FROM catalog_datasets WHERE id = $1", [smokeDatasetId]);
      await client.query("DELETE FROM etl_runs WHERE job_id = $1", [smokeJobId]);
      await client.query("DELETE FROM etl_jobs WHERE id = $1", [smokeJobId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`Smoke cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (smokeOutputPath && !smokeOutputPath.startsWith("s3")) {
    rmSync(smokeOutputPath, { force: true, recursive: true });
  }
  if (smokeRunId) {
    const reportDir = process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs");
    for (const suffix of [".json", ".manifest.json", "-source.jsonl"]) {
      rmSync(path.join(reportDir, `${smokeRunId}${suffix}`), { force: true });
    }
  }
}
function startMockAirflowServer() {
  const server = http.createServer(async (request, response) => {
    try {
      await handleMockAirflowRequest(request, response);
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(airflowPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function handleMockAirflowRequest(request, response) {
  const url = new URL(request.url || "/", airflowBaseUrl);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "POST" && url.pathname === "/auth/token") {
    writeJson(response, 200, { access_token: "mock-airflow-token" });
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "v2" || parts[2] !== "dags" || parts[3] !== airflowDagId || parts[4] !== "dagRuns") {
    writeJson(response, 404, { detail: `Unhandled mock Airflow route: ${request.method} ${url.pathname}` });
    return;
  }

  if (request.method === "POST" && parts.length === 5) {
    const payload = await readRequestJson(request);
    const dagRunId = String(payload.dag_run_id || `mock_run_${Date.now()}`);
    const run = {
      conf: payload.conf || {},
      dag_id: airflowDagId,
      dag_run_id: dagRunId,
      state: "queued",
    };
    mockAirflowRuns.set(dagRunId, run);
    writeJson(response, 200, run);
    return;
  }

  const dagRunId = parts[5];
  const run = mockAirflowRuns.get(dagRunId);
  if (!run) {
    writeJson(response, 404, { detail: `DAG Run not found: ${dagRunId}` });
    return;
  }

  if (request.method === "GET" && parts.length === 6) {
    writeJson(response, 200, { ...run, state: run.state === "queued" ? "success" : run.state });
    return;
  }

  if (request.method === "GET" && parts.length === 7 && parts[6] === "taskInstances") {
    const sparkFailed = run.state === "failed";
    writeJson(response, 200, {
      task_instances: [
        mockTask("receive_asklake_run", dagRunId),
        mockTask("validate_spark_request", dagRunId),
        mockTask("spark_process_write", dagRunId, sparkFailed ? "failed" : "success"),
        mockTask("publish_run_result", dagRunId, sparkFailed ? "upstream_failed" : "success"),
      ],
    });
    return;
  }

  writeJson(response, 404, { detail: `Unhandled mock Airflow route: ${request.method} ${url.pathname}` });
}

function mockTask(taskId, dagRunId, state = "success") {
  return {
    dag_id: airflowDagId,
    dag_run_id: dagRunId,
    state,
    task_id: taskId,
  };
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
    } catch {}
    await sleep(250);
  }
  throw new Error(`FastAPI health check did not pass at ${baseUrl}/api/health.`);
}

async function waitForTerminalJob(jobId) {
  const deadline = Date.now() + airflowSyncTimeoutMs;
  let latestJob = null;
  let latestRun = null;
  while (Date.now() < deadline) {
    latestJob = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
    latestRun = latestJob.runHistory?.[0];
    if (["success", "failed", "canceled"].includes(latestRun?.status)) return latestJob;
    await sleep(airflowSyncPollIntervalMs);
  }
  throw new Error(
    `AskLake did not sync the Airflow run within ${airflowSyncTimeoutMs}ms: ` +
    `${latestRun?.airflowDagRunId || "unknown run"} (${latestRun?.airflowState || latestRun?.status || "unknown"})` +
    `${latestRun?.syncError ? `, syncError=${latestRun.syncError}` : ""}`,
  );
}

async function get(route) {
  const response = await fetch(`${baseUrl}${route}`);
  return readResponse(response);
}

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse(response);
}

async function postExecution(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.AIRFLOW_EXECUTION_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  return readResponse(response);
}

async function del(route) {
  const response = await fetch(`${baseUrl}${route}`, { method: "DELETE" });
  return readResponse(response);
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

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
