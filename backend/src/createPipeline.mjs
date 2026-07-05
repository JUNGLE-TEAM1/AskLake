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
  const transformSteps = normalizeTransformSteps(request.transformSteps);
  const transformOutputColumns = normalizeTransformOutputColumns(request.transformOutputColumns);
  const qualityRules = normalizeQualityRules(request.qualityRules);
  const qualityInvalidRows = Array.isArray(request.qualityInvalidRows) ? request.qualityInvalidRows : [];
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
    rag: Boolean(request.rag),
    runHistory: [],
    schedule: request.scheduleLabel,
    source: `${request.sourceType} / ${request.sourceLabel}`,
    sourceConfig: request.sourceConfig,
    sourceLabel: request.sourceLabel,
    sourceType: request.sourceType,
    schemaColumns: request.schemaColumns,
    schemaSampleRows: request.schemaSampleRows,
    stats: initialJobStats(sourceMetrics),
    status: "scheduled",
    tag: "[생성]",
    target: request.targetDataset,
    targetFormat: request.targetFormat,
    targetLayer: request.targetLayer,
    transformOutputColumns,
    transformSteps,
    qualityInvalidRows,
    qualityRules,
    qualityScore: request.qualityScore,
    qualityStatus: request.qualityStatus,
  };

  jobs.unshift(job);

  return {
    catalogTarget: {
      id: datasetId,
      layer: request.targetLayer,
      name: request.targetDataset,
      status: "pending_run",
    },
    job,
  };
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
  let dataset;
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
    dataset = updateDatasetFromSparkResult(job, sparkResult);
  }
  if (run) {
    job.runHistory = [run, ...(job.runHistory ?? [])];
    job.stats = statsFromRuns(job, job.runHistory);
    job.dagSteps = dagStepsFromCommand(job, command, run);
  }
  return {
    action: actionByCommand[command],
    apiPath: `/api/etl/jobs/${jobId}/commands`,
    dataset,
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

function normalizeTransformSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step) => step && typeof step === "object")
    .map((step, index) => ({
      enabled: step.enabled !== false,
      id: String(step.id || index + 1),
      input: String(step.input || ""),
      kind: String(step.kind || "derive"),
      label: String(step.label || `${step.operation || "Transform"}: ${step.input || ""} -> ${step.output || ""}`),
      onError: String(step.onError || "Warn"),
      operation: String(step.operation || ""),
      output: String(step.output || step.input || `column_${index + 1}`),
      params: String(step.params || ""),
    }))
    .filter((step) => step.input && step.output);
}

function normalizeQualityRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule) => rule && typeof rule === "object")
    .map((rule, index) => ({
      enabled: rule.enabled !== false,
      failureAction: String(rule.failureAction || "Warn"),
      id: String(rule.id || `qr-${index + 1}`),
      kind: String(rule.kind || "notNull"),
      severity: String(rule.severity || "Warning"),
      targetColumn: String(rule.targetColumn || ""),
      validationType: String(rule.validationType || "Not Null"),
    }))
    .filter((rule) => rule.targetColumn);
}

function normalizeTransformOutputColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .filter((column) => Array.isArray(column) && String(column[0] ?? "").trim())
    .map(([name, type]) => [String(name), String(type || "string")]);
}

function qualitySummaryFromRequest(request) {
  if (Number.isFinite(Number(request.qualityScore))) {
    return `품질 점수 ${Number(request.qualityScore).toFixed(1)}% · 상태 ${qualityStatusLabel(request.qualityStatus)}`;
  }
  if (request.ruleSummary) return request.ruleSummary;
  return "확인 대기";
}

function qualityStatusLabel(status) {
  const normalizedStatus = String(status || "checked").toLowerCase();
  if (normalizedStatus === "pass") return "통과";
  if (normalizedStatus === "warn") return "주의";
  if (normalizedStatus === "fail") return "실패";
  return "확인됨";
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
  const transformCount = Array.isArray(request.transformSteps) ? request.transformSteps.length : 0;
  const qualityCount = Array.isArray(request.qualityRules) ? request.qualityRules.length : 0;
  return [
    { id: "source", meta: `${request.sourceType} / ${request.sourceLabel}`, status: "success", title: "1. 소스 연결" },
    { id: "schema", meta: `${metrics.schemaColumns.toLocaleString()}개 컬럼 · ${metrics.sampleScope}`, status: metrics.schemaColumns > 0 ? "success" : "pending", title: "2. 스키마 추론" },
    { id: "create", meta: request.targetDataset, status: "success", title: "3. Job 생성" },
    { id: "transform", meta: `${transformCount}개 규칙`, status: "pending", title: "4. 처리 규칙 대기" },
    { id: "quality", meta: `${qualityCount}개 검사`, status: "pending", title: "5. 품질 검증 대기" },
    { id: "run", meta: "아직 실행되지 않음", status: "pending", title: "6. 실행 대기" },
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
    failedStage: success ? "-" : result.failedStage ?? "Spark ETL",
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
  if (result.status !== "success") return undefined;
  let dataset = datasets.find((item) => item.name === job.target || item.id === `ds_${normalizeColumnName(job.target)}`);
  if (!dataset) {
    dataset = datasetFromSuccessfulRun(job, result);
    datasets.unshift(dataset);
    return dataset;
  }
  dataset.lastUpdated = result.endedAt ?? new Date().toISOString();
  if (Array.isArray(result.schema) && result.schema.length > 0) {
    dataset.schema = result.schema.map((field) => [field.name, field.type]);
  }
  if (result.quality) {
    dataset.quality = result.quality.summary || `품질 점수 ${result.quality.score ?? "-"}% · 상태 ${qualityStatusLabel(result.quality.status)}`;
  }
  dataset.rows = formatRows(result.outputRows);
  dataset.size = result.outputPath ?? dataset.size;
  dataset.source = job.name;
  dataset.status = "available";
  dataset.upstream = Array.from(new Set([...(dataset.upstream ?? []), result.sourcePath ?? job.source]));
  return dataset;
}

function datasetFromSuccessfulRun(job, result) {
  const layer = job.targetLayer ?? "GOLD";
  const schema = Array.isArray(result.schema) && result.schema.length > 0
    ? result.schema.map((field) => [field.name, field.type])
    : schemaFromJob(job);
  return {
    description: `${job.sourceType ?? "소스"} 소스 ${job.sourceLabel ?? job.source} 실행 결과 데이터셋`,
    downstream: job.rag ? ["SQL 분석", "RAG 인덱싱"] : ["SQL 분석"],
    freshness: "latest",
    id: `ds_${normalizeColumnName(job.target)}`,
    lastUpdated: result.endedAt ?? new Date().toISOString(),
    layer,
    name: job.target,
    nextRefresh: job.schedule,
    owner: job.owner,
    quality: result.quality?.summary || `품질 점수 ${result.quality?.score ?? job.qualityScore ?? "-"}% · 상태 ${qualityStatusLabel(result.quality?.status ?? job.qualityStatus)}`,
    rag: Boolean(job.rag),
    rows: formatRows(result.outputRows),
    sampleRows: Array.isArray(job.schemaSampleRows) ? job.schemaSampleRows : [],
    schema,
    size: result.outputPath ?? "-",
    source: job.name,
    status: "available",
    tags: ["#실행완료", `#${String(layer).toLowerCase()}`],
    upstream: Array.from(new Set([job.sourceLabel, job.name, result.sourcePath ?? job.source].filter(Boolean))),
  };
}

function schemaFromJob(job) {
  if (Array.isArray(job.transformOutputColumns) && job.transformOutputColumns.length > 0) {
    return job.transformOutputColumns;
  }
  if (Array.isArray(job.schemaColumns) && job.schemaColumns.length > 0) {
    return job.schemaColumns.map((column) => [column.targetName ?? column.sourceName, column.type ?? "string"]);
  }
  return [];
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
  const transformMeta = `${(job.transformSteps ?? []).length}개 규칙`;
  const qualityMeta = `${(job.qualityRules ?? []).length}개 검사`;
  if (!canceled) {
    const failed = run.status === "failed";
    const failedStage = String(run.failedStage ?? "").toLowerCase();
    const readFailed = failed && (!failedStage || failedStage.includes("source") || failedStage.includes("read") || failedStage.includes("spark etl"));
    const transformFailed = failed && failedStage.includes("transform");
    const qualityFailed = failed && failedStage.includes("quality");
    return [
      { id: "source", meta: job.source, status: "success", title: "1. 소스 연결" },
      { id: "schema", meta: job.stats?.schemaColumns ?? "-", status: "success", title: "2. 스키마 확인" },
      { id: "read", meta: run.inputRows, status: readFailed ? "failed" : "success", title: "3. Spark 소스 읽기" },
      { id: "transform", meta: transformMeta, status: transformFailed ? "failed" : readFailed ? "blocked" : "success", title: "4. 처리 규칙 적용" },
      { id: "quality", meta: qualityMeta, status: qualityFailed ? "failed" : readFailed || transformFailed ? "blocked" : "success", title: "5. 품질 검증" },
      { id: "write", meta: run.outputPath ?? "-", status: failed ? "blocked" : "success", title: "6. Parquet 적재" },
      { id: "catalog", meta: job.target, status: failed ? "blocked" : "success", title: "7. 카탈로그 데이터셋 갱신" },
    ];
  }
  return [
    { id: "source", meta: job.source, status: canceled ? "blocked" : "success", title: "1. 소스 연결" },
    { id: "schema", meta: job.stats?.schemaColumns ?? "-", status: canceled ? "blocked" : "success", title: "2. 스키마 확인" },
    { id: "read", meta: run.inputRows, status: canceled ? "blocked" : "running", title: "3. 소스 읽기" },
    { id: "transform", meta: transformMeta, status: canceled ? "blocked" : "pending", title: "4. 처리 규칙" },
    { id: "quality", meta: qualityMeta, status: "pending", title: "5. 품질 검증" },
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
  const transformOutputColumns = normalizeTransformOutputColumns(request.transformOutputColumns);
  if (transformOutputColumns.length > 0) return transformOutputColumns;
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
  const sourceIndexByOutputName = new Map(
    columns.flatMap(({ column, sourceIndex }) => [
      [String(column.targetName), sourceIndex],
      [String(column.sourceName), sourceIndex],
    ]),
  );
  if (columns.length === 0) {
    return request.schemaSampleRows.map((row) => schema.map((_, index) => row[index] ?? "-"));
  }

  return request.schemaSampleRows.map((row) => schema.map(([name]) => {
    const sourceIndex = sourceIndexByOutputName.get(String(name));
    return sourceIndex === undefined ? "" : row[sourceIndex] ?? "";
  }));
}
