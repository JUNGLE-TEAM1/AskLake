import { fieldValue, formatBytes, normalizeColumnName, sourceId } from "./profile.mjs";
import { runSparkPipeline } from "./sparkRunner.mjs";
import {
  countJobs,
  findDatasetForJob,
  getDataset,
  getJob,
  listDatasets as listStoredDatasets,
  listJobs as listStoredJobs,
  saveDataset,
  saveJob,
  saveSqlRun,
} from "./metadataStore.mjs";

export function listJobs() {
  return listStoredJobs();
}

export async function getPipelineJob(jobId) {
  const job = await getJob(jobId);
  if (!job) throw notFoundError(`작업을 찾지 못했습니다: ${jobId}`);
  return job;
}

export function listDatasets() {
  return listStoredDatasets();
}

export async function createPipeline(request) {
  validateCreatePipelineRequest(request);
  const jobCount = await countJobs();
  const transformSteps = normalizeTransformSteps(request.transformSteps);
  const transformOutputColumns = normalizeTransformOutputColumns(request.transformOutputColumns);
  const qualityRules = normalizeQualityRules(request.qualityRules);
  const qualityInvalidRows = Array.isArray(request.qualityInvalidRows) ? request.qualityInvalidRows : [];
  const datasetSchema = datasetSchemaFromRequest(request);
  const datasetSampleRows = datasetSampleRowsFromRequest(request, datasetSchema);
  const sourceMetrics = sourceMetricsFromRequest(request, datasetSchema, datasetSampleRows);
  const jobId = request.id ? `JOB-${sourceId("job", `${request.id}:${Date.now()}`).slice(-8).toUpperCase()}` : `JOB-${String(jobCount + 1).padStart(3, "0")}`;
  const datasetId = `ds_${normalizeColumnName(request.targetDataset)}`;
  await assertTargetDatasetAvailable(datasetId, request.targetDataset);

  const job = {
    dagSteps: initialDagSteps(request, sourceMetrics),
    dagStepsByRunId: {},
    id: jobId,
    datasetId,
    lastRun: "생성 후 미실행",
    lastState: `${sourceMetrics.schemaColumns}개 컬럼 추론 완료`,
    name: request.jobName,
    nextRun: isManualScheduleLabel(request.scheduleLabel) ? "-" : request.scheduleLabel,
    owner: request.owner,
    permissionRoles: request.permissionRoles,
    rag: Boolean(request.rag),
    runHistory: [],
    schedule: request.scheduleLabel,
    source: `${request.sourceType} / ${request.sourceLabel}`,
    sourceConfig: request.sourceConfig,
    sourceLabel: request.sourceLabel,
    sourceType: request.sourceType,
    compression: request.compression,
    partition: request.partition,
    storagePath: request.storagePath,
    storageType: request.storageType,
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

  await saveJob(job);

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

async function assertTargetDatasetAvailable(datasetId, targetDataset) {
  const normalizedTarget = normalizeColumnName(targetDataset);
  const [datasets, jobs] = await Promise.all([listStoredDatasets(), listStoredJobs()]);
  const datasetExists = datasets.some((dataset) => dataset.id === datasetId || normalizeColumnName(dataset.name) === normalizedTarget);
  const pendingJobExists = jobs.some((job) => job.datasetId === datasetId || normalizeColumnName(job.target) === normalizedTarget);
  if (datasetExists || pendingJobExists) {
    const error = new Error(`타깃 데이터셋이 이미 생성되었거나 실행 대기 중입니다: ${targetDataset}`);
    error.status = 409;
    error.code = "CREATE_PIPELINE_CONFLICT";
    throw error;
  }
}

export async function commandJob(jobId, command) {
  const job = await getJob(jobId);
  if (!job) throw notFoundError(`작업을 찾지 못했습니다: ${jobId}`);

  const actionByCommand = {
    cancel: "etl.run.cancel_requested",
    pause: "etl.job.pause_requested",
    retry: "etl.run.retry_requested",
    run: "etl.run.requested",
  };
  if (!actionByCommand[command]) throw validationError(`지원하지 않는 작업 명령입니다: ${command}`);
  if ((command === "run" || command === "retry") && job.status === "running") {
    throw conflictError(`이미 실행 중인 작업입니다: ${jobId}`);
  }

  const startedJob = applyJobCommand(job, command);
  Object.assign(job, startedJob);
  const run = runFromCommand(job, command);
  if (run) {
    job.runHistory = [run, ...(job.runHistory ?? [])];
    job.stats = statsFromRuns(job, job.runHistory);
    job.dagSteps = dagStepsFromCommand(job, command, run);
    job.dagStepsByRunId = {
      ...(job.dagStepsByRunId ?? {}),
      [run.runId]: job.dagSteps,
    };
  }
  await saveJob(job);
  if (run && (command === "run" || command === "retry")) {
    setImmediate(() => {
      void finalizeSparkJobRun(jobId, command, run.runId).catch((error) => {
        console.error(`Spark job finalization failed for ${jobId}/${run.runId}`, error);
      });
    });
  }
  return {
    action: actionByCommand[command],
    apiPath: `/api/etl/jobs/${jobId}/commands`,
    job,
    run,
    dagSteps: job.dagSteps ?? [],
  };
}

async function finalizeSparkJobRun(jobId, command, runId) {
  const startedJob = await getJob(jobId);
  const startedRun = startedJob?.runHistory?.find((item) => item.runId === runId);
  if (!startedJob || !startedRun || startedRun.status !== "running") return;

  let sparkResult;
  try {
    sparkResult = runSparkPipeline(startedJob, command, runId);
  } catch (error) {
    sparkResult = {
      endedAt: new Date().toISOString(),
      error: error.message || "Spark job failed.",
      inputRows: 0,
      outputPath: "-",
      outputRows: 0,
      runId,
      sourcePath: startedJob.source,
      startedAt: startedRun.startedAt,
      status: "failed",
    };
  }

  const latestJob = await getJob(jobId);
  const latestRun = latestJob?.runHistory?.find((item) => item.runId === runId);
  if (!latestJob || !latestRun || latestRun.status !== "running") return;

  const finalRun = runFromSparkResult(latestRun, sparkResult);
  const finalJob = finalizeJobFromSparkResult(latestJob, command, sparkResult);
  finalJob.runHistory = [finalRun, ...(latestJob.runHistory ?? []).filter((item) => item.runId !== runId)];
  finalJob.stats = statsFromRuns(finalJob, finalJob.runHistory);
  finalJob.dagSteps = dagStepsFromCommand(finalJob, command, finalRun, sparkResult);
  finalJob.dagStepsByRunId = {
    ...(latestJob.dagStepsByRunId ?? {}),
    [runId]: finalJob.dagSteps,
  };

  const dataset = await updateDatasetFromSparkResult(finalJob, sparkResult);
  await saveJob(finalJob);
  return dataset;
}

export async function executeQuery(request) {
  const datasetId = request?.datasetId;
  const dataset = await getDataset(datasetId);
  if (!dataset) throw notFoundError(`데이터셋을 찾지 못했습니다: ${datasetId}`);

  const columns = dataset.schema.slice(0, 6).map(([name]) => name);
  const rows = dataset.sampleRows.map((row) => row.slice(0, Math.max(columns.length, 1)));
  const result = {
    columns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    executedAt: new Date().toISOString(),
    query: request.query,
    rowCount: rows.length,
    rows,
    runId: sourceId("sql", `${dataset.id}:${Date.now()}`),
  };
  await saveSqlRun(result);
  return result;
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
  if (Array.isArray(request.schemaColumns) && request.schemaColumns.length > 0 && validRequestSchemaColumns(request).length === 0) {
    missing.push("schemaColumns[included]");
  }
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

function isManualScheduleLabel(value) {
  const label = String(value || "");
  return label === "manual" || label.includes("수동") || label.includes("스케줄 없음");
}

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  error.code = "NOT_FOUND";
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.status = 409;
  error.code = "CONFLICT";
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
    nextRun: isManualScheduleLabel(job.schedule) ? "-" : job.schedule,
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
    dagStep("source", "1. 소스 연결", `${request.sourceType} / ${request.sourceLabel}`, "success", [
      ["커넥터", request.sourceType],
      ["소스", request.sourceLabel],
    ], [`${request.sourceType} 연결 테스트 결과로 Job이 생성되었습니다.`]),
    dagStep("schema", "2. 스키마 추론", `${metrics.schemaColumns.toLocaleString()}개 컬럼 · ${metrics.sampleScope}`, metrics.schemaColumns > 0 ? "success" : "pending", [
      ["컬럼 수", `${metrics.schemaColumns.toLocaleString()}개`],
      ["샘플 범위", metrics.sampleScope],
    ], [`스키마 ${metrics.schemaColumns.toLocaleString()}개 컬럼을 생성 요청에 포함했습니다.`]),
    dagStep("create", "3. Job 생성", request.targetDataset, "success", [
      ["타겟 데이터셋", request.targetDataset],
      ["타겟 레이어", request.targetLayer],
    ], ["아직 실행 전이므로 카탈로그 데이터셋은 생성하지 않습니다."]),
    dagStep("transform", "4. 처리 규칙 대기", `${transformCount}개 규칙`, "pending", [
      ["처리 규칙", `${transformCount}개`],
    ], ["실행 시 Spark 변환 단계에서 적용됩니다."]),
    dagStep("quality", "5. 품질 검증 대기", `${qualityCount}개 검사`, "pending", [
      ["품질 검사", `${qualityCount}개`],
    ], ["실행 시 품질 규칙 평가 결과가 기록됩니다."]),
    dagStep("run", "6. 실행 대기", "아직 실행되지 않음", "pending", [
      ["Run ID", "-"],
    ], ["즉시 실행 또는 예약 실행 후 Run 로그가 연결됩니다."]),
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
    nextRun: isManualScheduleLabel(job.schedule) ? "-" : job.schedule,
    progress: undefined,
    status: success ? "scheduled" : "failed",
    targetPath: result.outputPath ?? job.targetPath,
  };
}

async function updateDatasetFromSparkResult(job, result) {
  if (result.status !== "success") return undefined;
  const existingDataset = await findDatasetForJob(job);
  const nextDataset = existingDataset ? { ...existingDataset } : datasetFromSuccessfulRun(job, result);
  nextDataset.lastUpdated = result.endedAt ?? new Date().toISOString();
  if (Array.isArray(result.schema) && result.schema.length > 0) {
    nextDataset.schema = result.schema.map((field) => [field.name, field.type]);
  }
  if (result.quality) {
    nextDataset.quality = result.quality.summary || `품질 점수 ${result.quality.score ?? "-"}% · 상태 ${qualityStatusLabel(result.quality.status)}`;
  }
  nextDataset.rows = formatRows(result.outputRows);
  nextDataset.size = result.outputPath ?? nextDataset.size;
  nextDataset.source = job.name;
  nextDataset.status = "available";
  nextDataset.upstream = Array.from(new Set([...(nextDataset.upstream ?? []), result.sourcePath ?? job.source]));
  await saveDataset(nextDataset);
  return nextDataset;
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
    return job.schemaColumns
      .filter(isSchemaColumnIncluded)
      .map((column) => [column.targetName ?? column.sourceName, column.type ?? "string"]);
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

function dagStepsFromCommand(job, command, run, sparkResult) {
  const canceled = command === "cancel";
  const transformMeta = `${(job.transformSteps ?? []).length}개 규칙`;
  const qualityMeta = `${(job.qualityRules ?? []).length}개 검사`;
  const sourcePath = sparkResult?.sourcePath ?? job.source;
  const outputPath = run.outputPath ?? sparkResult?.outputPath ?? "-";
  const sparkLogs = compactSparkLogs(sparkResult);
  const qualitySummary = sparkResult?.quality?.summary ?? "-";
  if (!canceled) {
    const failed = run.status === "failed";
    const failedStage = String(run.failedStage ?? "").toLowerCase();
    const readFailed = failed && (!failedStage || failedStage.includes("source") || failedStage.includes("read") || failedStage.includes("spark etl"));
    const transformFailed = failed && failedStage.includes("transform");
    const qualityFailed = failed && failedStage.includes("quality");
    return [
      dagStep("source", "1. 소스 연결", job.source, "success", [
        ["소스", job.source],
        ["소스 경로", sourcePath],
      ], [`${job.sourceType ?? "소스"} 커넥터 설정 확인 완료.`]),
      dagStep("schema", "2. 스키마 확인", job.stats?.schemaColumns ?? "-", "success", [
        ["스키마", job.stats?.schemaColumns ?? "-"],
        ["샘플 범위", job.stats?.sampleScope ?? "-"],
      ], ["생성 시 확정된 스키마를 Spark 실행 계약에 사용했습니다."]),
      dagStep("read", "3. Spark 소스 읽기", run.inputRows, readFailed ? "failed" : "success", [
        ["입력 행", run.inputRows],
        ["Spark source", sourcePath],
      ], readFailed ? [`Spark 소스 읽기 실패: ${run.errorSummary}`, ...sparkLogs] : [`Spark가 ${run.inputRows}을 읽었습니다.`, ...sparkLogs]),
      dagStep("transform", "4. 처리 규칙 적용", transformMeta, transformFailed ? "failed" : readFailed ? "blocked" : "success", [
        ["처리 규칙", transformMeta],
      ], transformFailed ? [`처리 규칙 적용 실패: ${run.errorSummary}`] : readFailed ? ["소스 읽기 실패로 처리 규칙 적용이 중단되었습니다."] : ["처리 규칙 적용 완료."]),
      dagStep("quality", "5. 품질 검증", qualityMeta, qualityFailed ? "failed" : readFailed || transformFailed ? "blocked" : "success", [
        ["품질 검사", qualityMeta],
        ["품질 결과", qualitySummary],
      ], qualityFailed ? [`품질 검증 실패: ${run.errorSummary}`] : readFailed || transformFailed ? ["이전 단계 실패로 품질 검증이 실행되지 않았습니다."] : [qualitySummary !== "-" ? qualitySummary : "품질 검증 완료."]),
      dagStep("write", "6. Parquet 적재", outputPath, failed ? "blocked" : "success", [
        ["출력 경로", outputPath],
        ["출력 행", run.outputRows],
      ], failed ? ["이전 단계 실패로 Parquet 적재가 수행되지 않았습니다."] : [`Parquet 출력 완료: ${outputPath}`]),
      dagStep("catalog", "7. 카탈로그 데이터셋 갱신", job.target, failed ? "blocked" : "success", [
        ["데이터셋", job.target],
        ["레이어", job.targetLayer ?? "-"],
      ], failed ? ["실행 실패로 카탈로그 데이터셋을 갱신하지 않았습니다."] : ["실행 성공 후 카탈로그 데이터셋을 갱신했습니다."]),
    ];
  }
  return [
    dagStep("source", "1. 소스 연결", job.source, canceled ? "blocked" : "success", [["소스", job.source]], ["사용자가 실행을 취소했습니다."]),
    dagStep("schema", "2. 스키마 확인", job.stats?.schemaColumns ?? "-", canceled ? "blocked" : "success", [["스키마", job.stats?.schemaColumns ?? "-"]], ["취소로 스키마 확인 이후 단계가 중단되었습니다."]),
    dagStep("read", "3. 소스 읽기", run.inputRows, canceled ? "blocked" : "running", [["입력 행", run.inputRows]], ["실행 취소 명령으로 소스 읽기를 중단했습니다."]),
    dagStep("transform", "4. 처리 규칙", transformMeta, canceled ? "blocked" : "pending", [["처리 규칙", transformMeta]], ["취소 상태입니다."]),
    dagStep("quality", "5. 품질 검증", qualityMeta, "pending", [["품질 검사", qualityMeta]], ["취소 상태입니다."]),
    dagStep("target", "6. Lake 적재", job.target, "pending", [["타겟", job.target]], ["취소 상태입니다."]),
  ];
}

function dagStep(id, title, meta, status, details = [], logs = [], note) {
  return {
    details,
    id,
    logs: logs.filter(Boolean).map((line) => String(line)),
    meta: String(meta ?? "-"),
    ...(note ? { note } : {}),
    status,
    title,
  };
}

function compactSparkLogs(result) {
  const lines = [result?.error, result?.stderr, result?.stdout]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/\r?\n/))
    .filter((line) => line.trim());
  return lines.slice(-80);
}

function sourceUnitLabel(sourceType) {
  if (sourceType === "MongoDB") return "컬렉션";
  if (sourceType === "PostgreSQL") return "테이블";
  if (sourceType === "Stream / Kafka" || sourceType === "Kafka JSON") return "파티션";
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
    .filter(({ column }) => isSchemaColumnIncluded(column) && String(column?.targetName ?? "").trim());
}

function isSchemaColumnIncluded(column) {
  const value = column?.included ?? true;
  if (typeof value === "string") {
    return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
  }
  return value !== false;
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
