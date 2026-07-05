import { fieldValue, formatBytes, normalizeColumnName, sourceId } from "./profile.mjs";
import { runSparkPipeline } from "./sparkRunner.mjs";

const jobs = [];
const datasets = [];

export function listJobs() {
  return jobs;
}

export function listDatasets() {
  return datasets;
}

export function createPipeline(request) {
  validateCreatePipelineRequest(request);
  const datasetSchema = datasetSchemaFromRequest(request);
  const datasetSampleRows = datasetSampleRowsFromRequest(request, datasetSchema);
  const sourceMetrics = sourceMetricsFromRequest(request, datasetSchema, datasetSampleRows);
  const jobId = request.id ? `JOB-${sourceId("job", `${request.id}:${Date.now()}`).slice(-8).toUpperCase()}` : `JOB-${String(jobs.length + 1).padStart(3, "0")}`;
  const datasetId = `ds_${normalizeColumnName(request.targetDataset)}`;

  const job = {
    dagSteps: initialDagSteps(request, sourceMetrics),
    id: jobId,
    lastRun: "생성 후 미실행",
    lastState: `${sourceMetrics.schemaColumns}개 컬럼 추론 완료`,
    name: request.jobName,
    nextRun: request.scheduleLabel === "manual" ? "-" : request.scheduleLabel,
    owner: request.owner,
    runHistory: [],
    schedule: request.scheduleLabel,
    source: `${request.sourceType} / ${request.sourceLabel}`,
    sourceConfig: request.sourceConfig,
    sourceLabel: request.sourceLabel,
    sourceType: request.sourceType,
    stats: initialJobStats(sourceMetrics),
    status: "scheduled",
    tag: "[생성]",
    target: request.targetDataset,
    targetFormat: request.targetFormat,
    targetLayer: request.targetLayer,
  };

  const dataset = {
    description: `${request.sourceType} 소스 ${request.sourceLabel}에서 생성된 데이터셋`,
    downstream: request.rag ? ["SQL 분석", "RAG 인덱싱"] : ["SQL 분석"],
    freshness: "latest",
    id: datasetId,
    lastUpdated: new Date().toISOString(),
    layer: request.targetLayer,
    name: request.targetDataset,
    nextRefresh: request.scheduleLabel,
    owner: request.owner,
    quality: request.ruleSummary || "확인 대기",
    rag: Boolean(request.rag),
    rows: sourceMetrics.datasetRows,
    sampleRows: datasetSampleRows,
    schema: datasetSchema,
    size: sourceMetrics.datasetSize,
    source: request.jobName,
    status: "available",
    tags: ["#생성", `#${String(request.targetLayer).toLowerCase()}`],
    upstream: [request.sourceLabel, request.jobName],
  };

  jobs.unshift(job);
  datasets.unshift(dataset);

  return { dataset, job };
}

export function commandJob(jobId, command) {
  const job = jobs.find((item) => item.id === jobId);
  if (!job) throw notFoundError(`작업을 찾지 못했습니다: ${jobId}`);

  const actionByCommand = {
    cancel: "etl.run.cancel_requested",
    pause: "etl.job.pause_requested",
    retry: "etl.run.retry_requested",
    run: "etl.run.requested",
  };
  if (!actionByCommand[command]) throw validationError(`지원하지 않는 작업 명령입니다: ${command}`);

  const startedJob = applyJobCommand(job, command);
  Object.assign(job, startedJob);
  const run = runFromCommand(job, command);
  if (run && (command === "run" || command === "retry")) {
    let sparkResult;
    try {
      sparkResult = runSparkPipeline(job, command, run.runId);
    } catch (error) {
      sparkResult = {
        endedAt: new Date().toISOString(),
        error: error.message || "Spark job failed.",
        inputRows: 0,
        outputPath: "-",
        outputRows: 0,
        runId: run.runId,
        sourcePath: job.source,
        startedAt: run.startedAt,
        status: "failed",
      };
    }
    Object.assign(run, runFromSparkResult(run, sparkResult));
    Object.assign(job, finalizeJobFromSparkResult(job, command, sparkResult));
    updateDatasetFromSparkResult(job, sparkResult);
  }
  if (run) {
    job.runHistory = [run, ...(job.runHistory ?? [])];
    job.stats = statsFromRuns(job, job.runHistory);
    job.dagSteps = dagStepsFromCommand(job, command, run);
  }
  return {
    action: actionByCommand[command],
    apiPath: `/api/etl/jobs/${jobId}/commands`,
    job,
    run,
    dagSteps: job.dagSteps ?? [],
  };
}

export function executeQuery(request) {
  const datasetId = request?.datasetId;
  const dataset = datasets.find((item) => item.id === datasetId);
  if (!dataset) throw notFoundError(`데이터셋을 찾지 못했습니다: ${datasetId}`);

  const columns = dataset.schema.slice(0, 6).map(([name]) => name);
  const rows = dataset.sampleRows.map((row) => row.slice(0, Math.max(columns.length, 1)));
  return {
    columns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    executedAt: new Date().toISOString(),
    query: request.query,
    rowCount: rows.length,
    rows,
    runId: sourceId("sql", `${dataset.id}:${Date.now()}`),
  };
}

function validateCreatePipelineRequest(request) {
  const missing = [];
  if (!request || typeof request !== "object") throw validationError("Request body must be a JSON object.");
  if (!request.jobName) missing.push("jobName");
  if (!request.sourceType) missing.push("sourceType");
  if (!request.sourceLabel) missing.push("sourceLabel");
  if (!request.targetDataset) missing.push("targetDataset");
  if (!request.targetLayer) missing.push("targetLayer");
  if (!request.owner) missing.push("owner");
  if (!Array.isArray(request.schemaColumns) || request.schemaColumns.length === 0) missing.push("schemaColumns");
  if (missing.length > 0) throw validationError(`Missing required fields: ${missing.join(", ")}`);
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "CREATE_PIPELINE_INVALID";
  return error;
}

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  error.code = "NOT_FOUND";
  return error;
}

function applyJobCommand(job, command) {
  if (command === "run" || command === "retry") {
    const now = new Date().toISOString();
    return {
      ...job,
      lastRun: now,
      lastState: command === "retry" ? "Spark 재실행 중" : "Spark 실행 중",
      nextRun: "-",
      progress: { label: "Spark ETL 실행 중", value: 66 },
      status: "running",
    };
  }

  if (command === "pause") {
    return {
      ...job,
      lastState: "사용자 일시정지",
      nextRun: "재개 대기",
      progress: job.progress ?? { label: "일시정지됨", value: 50 },
      status: "paused",
    };
  }

  return {
    ...job,
    lastRun: "방금 취소",
    lastState: "취소됨",
    nextRun: job.schedule === "수동 실행" || job.schedule === "manual" ? "-" : job.schedule,
    progress: undefined,
    status: "canceled",
  };
}

function sourceMetricsFromRequest(request, schema, sampleRows) {
  const sourceConfig = Array.isArray(request.sourceConfig) ? request.sourceConfig : [];
  const sampleRowsCount = Array.isArray(sampleRows) ? sampleRows.length : 0;
  const schemaColumns = Array.isArray(schema) ? schema.length : 0;
  const rowLimit = parsePositiveInteger(fieldValue(sourceConfig, "__Sample Row Limit"));
  const requestedBytes = parsePositiveInteger(fieldValue(sourceConfig, "__Sample Requested Bytes"));
  const sourceUnits = parsePositiveInteger(fieldValue(sourceConfig, "__Source Unit Count"));
  const sampleScope = fieldValue(sourceConfig, "__Schema Sample Scope Label") || "현재 샘플";
  const unitLabel = sourceUnitLabel(request.sourceType);
  const rowLabel = request.sourceType === "MongoDB" ? "문서" : "행";
  const datasetRows = sampleRowsCount > 0
    ? `샘플 ${sampleRowsCount.toLocaleString()}${rowLabel}`
    : sourceUnits > 0
      ? `${sourceUnits.toLocaleString()}개 ${unitLabel} 감지`
      : "샘플 없음";
  const datasetSize = requestedBytes > 0
    ? formatBytes(requestedBytes)
    : rowLimit > 0
      ? `최대 ${rowLimit.toLocaleString()}${rowLabel} 샘플`
      : sourceUnits > 0
        ? `${sourceUnits.toLocaleString()}개 ${unitLabel}`
        : "확인 대기";

  return {
    datasetRows,
    datasetSize,
    rowLabel,
    sampleRows: sampleRowsCount,
    sampleScope,
    schemaColumns,
    sourceUnits,
    unitLabel,
  };
}

function initialJobStats(metrics) {
  return {
    averageDuration: "-",
    currentStage: "생성 완료 · 실행 전",
    inputRows: metrics.sampleRows > 0 ? `${metrics.sampleRows.toLocaleString()} 샘플 ${metrics.rowLabel}` : "-",
    lastSuccess: "-",
    outputRows: "0",
    sampleScope: metrics.sampleScope,
    schemaColumns: `${metrics.schemaColumns.toLocaleString()}개`,
    sourceUnits: metrics.sourceUnits > 0 ? `${metrics.sourceUnits.toLocaleString()}개 ${metrics.unitLabel}` : "-",
    successRate: "-",
    totalRuns: "0회",
  };
}

function initialDagSteps(request, metrics) {
  return [
    { id: "source", meta: `${request.sourceType} / ${request.sourceLabel}`, status: "success", title: "1. Source 연결" },
    { id: "schema", meta: `${metrics.schemaColumns.toLocaleString()}개 컬럼 · ${metrics.sampleScope}`, status: metrics.schemaColumns > 0 ? "success" : "pending", title: "2. Schema 추론" },
    { id: "create", meta: request.targetDataset, status: "success", title: "3. Job 생성" },
    { id: "run", meta: "아직 실행되지 않음", status: "pending", title: "4. 실행 대기" },
  ];
}

function runFromCommand(job, command) {
  if (command === "pause") return undefined;
  const now = new Date();
  const runId = sourceId("run", `${job.id}:${command}:${now.toISOString()}`);
  const inputRows = job.stats?.inputRows && job.stats.inputRows !== "-" ? job.stats.inputRows : "0";
  if (command === "cancel") {
    return {
      duration: "-",
      endedAt: now.toISOString(),
      errorSummary: "사용자 취소",
      failedStage: "실행 취소",
      inputRows,
      outputRows: "0",
      runId,
      startedAt: now.toISOString(),
      status: "canceled",
    };
  }
  return {
    duration: "실행 중",
    endedAt: "-",
    errorSummary: "-",
    failedStage: "-",
    inputRows,
    outputPath: "-",
    outputRows: "0",
    runId,
    startedAt: now.toISOString(),
    status: "running",
  };
}

function runFromSparkResult(run, result) {
  const success = result.status === "success";
  return {
    ...run,
    duration: formatDuration(result.durationMs),
    endedAt: result.endedAt ?? new Date().toISOString(),
    errorSummary: success ? "-" : result.error ?? "Spark job failed.",
    failedStage: success ? "-" : "Spark ETL",
    inputRows: formatRows(result.inputRows),
    outputPath: result.outputPath ?? "-",
    outputRows: formatRows(result.outputRows),
    startedAt: result.startedAt ?? run.startedAt,
    status: success ? "success" : "failed",
  };
}

function finalizeJobFromSparkResult(job, command, result) {
  const success = result.status === "success";
  return {
    ...job,
    lastRun: result.endedAt ?? new Date().toISOString(),
    lastState: success
      ? `${command === "retry" ? "재실행" : "실행"} 완료 · Spark Parquet 적재`
      : `Spark 실행 실패 · ${result.error ?? "원인 확인 필요"}`,
    nextRun: job.schedule === "수동 실행" || job.schedule === "manual" ? "-" : job.schedule,
    progress: undefined,
    status: success ? "scheduled" : "failed",
    targetPath: result.outputPath ?? job.targetPath,
  };
}

function updateDatasetFromSparkResult(job, result) {
  const dataset = datasets.find((item) => item.name === job.target || item.id === `ds_${normalizeColumnName(job.target)}`);
  if (!dataset || result.status !== "success") return;
  dataset.lastUpdated = result.endedAt ?? new Date().toISOString();
  dataset.rows = formatRows(result.outputRows);
  dataset.size = result.outputPath ?? dataset.size;
  dataset.source = job.name;
  dataset.status = "available";
  dataset.upstream = Array.from(new Set([...(dataset.upstream ?? []), result.sourcePath ?? job.source]));
}

function statsFromRuns(job, runs) {
  const totalRuns = runs.length;
  const successRuns = runs.filter((run) => run.status === "success").length;
  const lastSuccess = runs.find((run) => run.status === "success")?.endedAt ?? "-";
  const latestRun = runs[0];
  return {
    ...(job.stats ?? {}),
    averageDuration: latestRun?.duration ?? "-",
    currentStage: job.lastState,
    lastSuccess,
    outputPath: latestRun?.outputPath ?? job.stats?.outputPath ?? "-",
    outputRows: latestRun?.outputRows ?? job.stats?.outputRows ?? "0",
    successRate: totalRuns > 0 ? `${Math.round((successRuns / totalRuns) * 100)}%` : "-",
    totalRuns: `${totalRuns.toLocaleString()}회`,
  };
}

function dagStepsFromCommand(job, command, run) {
  const canceled = command === "cancel";
  if (!canceled) {
    const failed = run.status === "failed";
    return [
      { id: "source", meta: job.source, status: failed ? "blocked" : "success", title: "1. Source 연결" },
      { id: "schema", meta: job.stats?.schemaColumns ?? "-", status: failed ? "blocked" : "success", title: "2. Schema 확인" },
      { id: "read", meta: run.inputRows, status: failed ? "failed" : "success", title: "3. Spark Source 읽기" },
      { id: "write", meta: run.outputPath ?? "-", status: failed ? "blocked" : "success", title: "4. Parquet 적재" },
      { id: "catalog", meta: job.target, status: failed ? "blocked" : "success", title: "5. Catalog Dataset 갱신" },
    ];
  }
  return [
    { id: "source", meta: job.source, status: canceled ? "blocked" : "success", title: "1. Source 연결" },
    { id: "schema", meta: job.stats?.schemaColumns ?? "-", status: canceled ? "blocked" : "success", title: "2. Schema 확인" },
    { id: "read", meta: run.inputRows, status: canceled ? "blocked" : "running", title: "3. Source 읽기" },
    { id: "transform", meta: "Pair A 2 처리 단계", status: canceled ? "blocked" : "pending", title: "4. Transform" },
    { id: "quality", meta: "Pair A 2 품질 단계", status: "pending", title: "5. Quality" },
    { id: "target", meta: job.target, status: "pending", title: "6. Lake 적재" },
  ];
}

function sourceUnitLabel(sourceType) {
  if (sourceType === "MongoDB") return "컬렉션";
  if (sourceType === "PostgreSQL") return "테이블";
  if (sourceType === "Stream / Kafka") return "파티션";
  return "오브젝트";
}

function formatRows(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value ?? "0");
  return `${Math.trunc(parsed).toLocaleString()}행`;
}

function formatDuration(durationMs) {
  const parsed = Number(durationMs);
  if (!Number.isFinite(parsed) || parsed < 0) return "-";
  if (parsed < 1000) return `${Math.trunc(parsed)}ms`;
  if (parsed < 60 * 1000) return `${(parsed / 1000).toFixed(1)}s`;
  return `${(parsed / 60000).toFixed(1)}m`;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

function validRequestSchemaColumns(request) {
  return request.schemaColumns
    .map((column, sourceIndex) => ({ column, sourceIndex }))
    .filter(({ column }) => String(column?.targetName ?? "").trim());
}

function datasetSchemaFromRequest(request) {
  return validRequestSchemaColumns(request).map(({ column }) => [
    column.targetName,
    String(column.type ?? "string").toLowerCase(),
  ]);
}

function datasetSampleRowsFromRequest(request, schema) {
  if (!Array.isArray(request.schemaSampleRows) || request.schemaSampleRows.length === 0) {
    return [];
  }

  const columns = validRequestSchemaColumns(request);
  if (columns.length === 0) {
    return request.schemaSampleRows.map((row) => schema.map((_, index) => row[index] ?? "-"));
  }

  return request.schemaSampleRows.map((row) => columns.map(({ sourceIndex }) => row[sourceIndex] ?? "-"));
}
