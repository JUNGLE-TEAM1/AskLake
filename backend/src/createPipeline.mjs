import { normalizeColumnName, sourceId } from "./profile.mjs";

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
  const jobId = request.id ? `JOB-${sourceId("job", `${request.id}:${Date.now()}`).slice(-8).toUpperCase()}` : `JOB-${String(jobs.length + 1).padStart(3, "0")}`;
  const datasetId = `ds_${normalizeColumnName(request.targetDataset)}`;

  const job = {
    id: jobId,
    lastRun: "방금 생성됨",
    lastState: "대기 중",
    name: request.jobName,
    nextRun: request.scheduleLabel === "manual" ? "-" : request.scheduleLabel,
    owner: request.owner,
    schedule: request.scheduleLabel,
    source: `${request.sourceType} / ${request.sourceLabel}`,
    status: "스케줄됨",
    tag: "[생성]",
    target: request.targetDataset,
  };

  const dataset = {
    description: `${request.sourceType} 소스 ${request.sourceLabel}에서 생성된 데이터셋`,
    downstream: request.rag ? ["SQL 분석", "RAG 인덱싱"] : ["SQL 분석"],
    freshness: "생성됨",
    id: datasetId,
    lastUpdated: new Date().toISOString(),
    layer: request.targetLayer,
    name: request.targetDataset,
    nextRefresh: request.scheduleLabel,
    owner: request.owner,
    quality: request.ruleSummary || "확인 대기",
    rag: Boolean(request.rag),
    rows: "0 rows",
    sampleRows: datasetSampleRows,
    schema: datasetSchema,
    size: "확인 대기",
    source: request.jobName,
    status: "사용 가능",
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

  const nextJob = applyJobCommand(job, command);
  Object.assign(job, nextJob);
  return {
    action: actionByCommand[command],
    apiPath: `/api/etl/jobs/${jobId}/commands`,
    job,
    run: {
      command,
      jobId,
      runId: sourceId("run", `${jobId}:${command}:${Date.now()}`),
      status: job.status,
      submittedAt: new Date().toISOString(),
    },
    dagSteps: [
      { id: "source", label: "Source 연결", status: command === "cancel" ? "cancelled" : "done" },
      { id: "schema", label: "Schema 확인", status: command === "cancel" ? "cancelled" : "done" },
      { id: "transform", label: "Transform 실행", status: command === "pause" ? "paused" : command === "cancel" ? "cancelled" : "running" },
    ],
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
    return {
      ...job,
      lastRun: "현재 실행 중",
      lastState: command === "retry" ? "재실행 중 · Source 연결" : "1/3 단계 · Source 연결",
      nextRun: "-",
      progress: { label: command === "retry" ? "재실행 중 · Source 연결" : "1/3 단계 · Source 연결", value: 33 },
      status: "실행 중",
    };
  }

  if (command === "pause") {
    return {
      ...job,
      lastState: "사용자 일시정지",
      nextRun: "재개 대기",
      progress: job.progress ?? { label: "일시정지됨", value: 50 },
      status: "일시정지",
    };
  }

  return {
    ...job,
    lastRun: "방금 취소",
    lastState: "취소됨",
    nextRun: job.schedule === "수동 실행" || job.schedule === "manual" ? "-" : job.schedule,
    progress: undefined,
    status: "스케줄됨",
  };
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
