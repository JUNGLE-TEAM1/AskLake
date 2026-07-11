import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldValue, formatBytes, normalizeColumnName, sourceId } from "./profile.mjs";
import { runSparkPipeline } from "./sparkRunner.mjs";
import {
  countJobs,
  findDatasetForJob,
  getDataset,
  getJob,
  listDatasets as listStoredDatasets,
  listJobs as listStoredJobs,
  listModelArtifacts as listStoredModelArtifacts,
  saveDataset,
  saveJob,
  saveModelArtifact,
  saveSqlRun,
} from "./metadataStore.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const sparkWorkerLogDir = path.resolve(process.env.ASKLAKE_SPARK_WORKER_LOG_DIR || path.join(backendDir, "tmp", "spark-workers"));

export function listJobs() {
  return listStoredJobs();
}

export async function getPipelineJob(jobId) {
  const job = await getJob(jobId);
  if (!job) throw notFoundError(`작업을 찾지 못했습니다: ${jobId}`);
  return job;
}

export async function listDatasets() {
  const datasets = await listStoredDatasets();
  return datasets.filter((dataset) => !isCatalogModelArtifact(dataset));
}

export async function listModelArtifacts() {
  const stored = await listStoredModelArtifacts();
  const discovered = discoverReviewTextModelArtifacts();
  const byId = new Map();
  for (const artifact of discovered) {
    byId.set(artifact.id, artifact);
  }
  for (const artifact of stored) {
    byId.set(artifact.id, { ...(byId.get(artifact.id) ?? {}), ...artifact });
  }
  return dedupeModelArtifacts([...byId.values()])
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

function dedupeModelArtifacts(artifacts) {
  const byModel = new Map();
  for (const artifact of artifacts) {
    const key = [
      normalizeColumnName(artifact.targetColumn || artifact.targetName || ""),
      artifact.modelArtifact || artifact.artifact || "",
      artifact.modelPath || artifact.path || "",
    ].join("::");
    const current = byModel.get(key);
    if (!current) {
      byModel.set(key, artifact);
      continue;
    }
    const artifactIsNewer = String(artifact.updatedAt || "").localeCompare(String(current.updatedAt || "")) > 0;
    const preferred = artifactIsNewer ? artifact : current;
    const fallback = artifactIsNewer ? current : artifact;
    const trainingArtifact = [preferred, fallback].find((item) => item?.source === "training_run");
    byModel.set(key, {
      ...fallback,
      ...preferred,
      allowedValues: preferred.allowedValues?.length ? preferred.allowedValues : fallback.allowedValues,
      createdAt: preferred.createdAt || fallback.createdAt,
      id: trainingArtifact?.id || preferred.id || fallback.id,
      metrics: Object.keys(preferred.metrics || {}).length ? preferred.metrics : fallback.metrics,
      runId: trainingArtifact?.runId || preferred.runId || fallback.runId,
      source: trainingArtifact ? "training_run" : preferred.source,
      trainingRows: trainingArtifact?.trainingRows ?? preferred.trainingRows ?? fallback.trainingRows,
      validationRows: preferred.validationRows ?? fallback.validationRows,
    });
  }
  for (const [key, artifact] of byModel) {
    if (!artifact.id && artifact.modelArtifact) {
      byModel.set(key, {
        ...artifact,
        id: `model_${normalizeColumnName(artifact.targetColumn || artifact.targetName || artifact.modelArtifact)}`,
      });
    }
  }
  return [...byModel.values()];
}

export async function createTextStructuringTrainingRun(request) {
  const columns = Array.isArray(request?.columns) ? request.columns : [];
  const trainRows = Array.isArray(request?.trainRows) ? request.trainRows : [];
  if (columns.length === 0) throw validationError("Text structuring training requires at least one output column.");
  if (trainRows.length < 2) throw validationError("Text structuring training requires labeled trainRows.");
  const runId = `text_model_${Date.now().toString(36)}`;
  const outputDir = path.join(reviewTextModelRunsDir(), runId);
  const latestDir = reviewTextModelLatestDir();
  const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || process.env.PYTHON || "python";
  const result = spawnSync(
    pythonBin,
    [path.join(scriptsDir, "train_text_structuring_models.py"), "--output-dir", outputDir, "--latest-dir", latestDir],
    {
      cwd: backendDir,
      encoding: "utf8",
      input: JSON.stringify({
        ...request,
        latestDir,
        outputDir,
      }),
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || "Text structuring model training failed.");
    error.status = 500;
    error.code = "TEXT_STRUCTURING_TRAINING_FAILED";
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout || "{}");
  } catch {
    const error = new Error("Text structuring model training returned invalid JSON.");
    error.status = 500;
    error.code = "TEXT_STRUCTURING_TRAINING_INVALID_OUTPUT";
    throw error;
  }
  const trainedModels = manifest.trainedModels && typeof manifest.trainedModels === "object" ? manifest.trainedModels : {};
  const savedArtifacts = [];
  for (const [targetColumn, model] of Object.entries(trainedModels)) {
    if (!model || model.status !== "trained" || !model.artifact) continue;
    const artifact = {
      allowedValues: model.allowedValues ?? [],
      artifactType: "model",
      accuracy: model.metrics?.accuracy,
      createdAt: manifest.createdAt,
      id: `model_${normalizeColumnName(targetColumn)}_${runId}`,
      macroF1: model.metrics?.macroF1,
      method: "one_of_values",
      metrics: model.metrics ?? {},
      modelArtifact: model.artifact,
      modelKind: model.modelKind || "portable_tfidf_linear_svc",
      modelPath: path.join(manifest.latestRuntimeDir || "", model.artifact),
      runId,
      runtimeStatus: "portable_text_model_available",
      source: "training_run",
      status: "available",
      supportedMethods: ["one_of_values"],
      targetColumn,
      trainingRows: model.trainRows,
      updatedAt: new Date().toISOString(),
      validationRows: model.validationRows,
      validationStatus: "available_for_selection",
    };
    savedArtifacts.push(await saveModelArtifact(artifact));
  }
  return {
    artifacts: savedArtifacts,
    manifest,
    run: {
      id: runId,
      outputDir,
      status: savedArtifacts.length > 0 ? "success" : "no_models_trained",
      trainedModelCount: savedArtifacts.length,
    },
  };
}

function isCatalogModelArtifact(dataset) {
  const kind = String(dataset?.artifactType || dataset?.resourceType || dataset?.type || "").toLowerCase();
  return kind === "model" || kind === "model_artifact";
}

function discoverReviewTextModelArtifacts() {
  const root = reviewTextModelLatestDir();
  if (!existsSync(root)) return [];
  const files = findPortableReviewTextModels(root);
  return files.map((filePath) => {
    const filename = path.basename(filePath);
    const targetColumn = normalizeColumnName(filename.replace(/\.portable_linear_svc\.json$/i, ""));
    let allowedValues = [];
    let metrics = {};
    try {
      const payload = JSON.parse(readFileSync(filePath, "utf8"));
      const rawAllowedValues = Array.isArray(payload.allowedValues) && payload.allowedValues.length > 0
        ? payload.allowedValues
        : payload.classes;
      allowedValues = Array.isArray(rawAllowedValues) ? rawAllowedValues.map((value) => String(value)) : [];
      metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics : {};
    } catch {
      allowedValues = [];
      metrics = {};
    }
    let updatedAt = new Date().toISOString();
    try {
      updatedAt = statSync(filePath).mtime.toISOString();
    } catch {
      // Keep current timestamp fallback.
    }
    return {
      accuracy: metrics.accuracy,
      allowedValues,
      artifactType: "model",
      id: `model_${targetColumn}`,
      macroF1: metrics.macroF1,
      method: "one_of_values",
      metrics,
      modelArtifact: filename,
      modelKind: "portable_linear_svc",
      modelPath: filePath,
      runtimeStatus: "portable_text_model_available",
      source: "filesystem",
      status: "available",
      supportedMethods: ["one_of_values"],
      targetColumn,
      updatedAt,
      validationRows: metrics.validationRows,
      validationStatus: "available_for_selection",
    };
  });
}

function reviewTextModelRoot() {
  return path.resolve(process.env.ASKLAKE_REVIEW_TEXT_MODEL_HOST_DIR || path.join(backendDir, "tmp", "review-text-models"));
}

function reviewTextModelLatestDir() {
  const root = reviewTextModelRoot();
  return path.basename(root).toLowerCase() === "latest" ? root : path.join(root, "latest");
}

function reviewTextModelRunsDir() {
  const root = reviewTextModelRoot();
  return path.basename(root).toLowerCase() === "latest" ? path.join(path.dirname(root), "runs") : path.join(root, "runs");
}

function findPortableReviewTextModels(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (/\.portable_linear_svc\.json$/i.test(entry.name)) {
        found.push(fullPath);
      }
    }
  }
  return found;
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
    nextRun: scheduleNextRunLabel(request.scheduleLabel, request.scheduleSummary),
    owner: request.owner,
    permissionRoles: request.permissionRoles,
    rag: Boolean(request.rag),
    runHistory: [],
    schedule: request.scheduleLabel,
    schedulePolicy: {
      endDate: request.endDate,
      nextRunUtc: request.nextRunUtc,
      overlapPolicy: request.overlapPolicy,
      startDate: request.startDate,
      timezone: request.timezone,
      watermarkPolicy: request.watermarkPolicy,
    },
    scheduleSummary: request.scheduleSummary,
    source: `${request.sourceType} / ${request.sourceLabel}`,
    sourceConfig: request.sourceConfig,
    sourceLabel: request.sourceLabel,
    sourceType: request.sourceType,
    retryPolicy: request.retryPolicy,
    retryPolicySummary: request.retryPolicySummary,
    runLimitSummary: request.runLimitSummary,
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
  const datasetExists = datasets.some((dataset) => {
    if (!dataset || typeof dataset !== "object") return false;
    return dataset.id === datasetId || normalizeColumnName(dataset.name) === normalizedTarget;
  });
  const pendingJobExists = jobs.some((job) => {
    if (!job || typeof job !== "object") return false;
    return job.datasetId === datasetId || normalizeColumnName(job.target) === normalizedTarget;
  });
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
    cancelRun: "etl.run.cancel_requested",
    pause: "etl.job.pause_requested",
    retry: "etl.run.retry_requested",
    run: "etl.run.requested",
    stopSchedule: "etl.schedule.stop_requested",
  };
  if (!actionByCommand[command]) throw validationError(`지원하지 않는 작업 명령입니다: ${command}`);
  if (command === "run" && job.status === "running") throw conflictError(`이미 실행 중인 작업입니다: ${jobId}`);
  if (command === "pause" && job.status !== "running") throw invalidStateError(`일시정지할 수 없는 상태입니다: ${job.status}`);
  if (command === "cancelRun" && job.status !== "running") throw invalidStateError(`현재 실행을 취소할 수 없는 상태입니다: ${job.status}`);
  if (command === "stopSchedule" && !hasScheduledExecution(job)) throw invalidStateError(`중지할 스케줄이 없습니다: ${jobId}`);

  const startedJob = applyJobCommand(job, command);
  Object.assign(job, startedJob);
  const run = runFromCommand(job, command);
  if (run) {
    const workerInfo = command === "run" || command === "retry"
      ? prepareSparkJobRunWorker(jobId, command, run.runId)
      : undefined;
    if (workerInfo) {
      run.worker = {
        mode: "background_process",
        stderrPath: workerInfo.stderrPath,
        stdoutPath: workerInfo.stdoutPath,
      };
    }
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
    const startedWorker = startSparkJobRunWorker(jobId, command, run.runId, run.worker);
    run.worker = {
      ...(run.worker ?? {}),
      ...startedWorker,
      mode: "background_process",
    };
    job.runHistory = [run, ...(job.runHistory ?? []).filter((item) => item.runId !== run.runId)];
    await saveJob(job);
  }
  return {
    action: actionByCommand[command],
    apiPath: `/api/etl/jobs/${jobId}/commands`,
    job,
    run,
    dagSteps: job.dagSteps ?? [],
  };
}

export async function finalizeSparkJobRun(jobId, command, runId) {
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
  return {
    dataset,
    sparkResult,
  };
}

function prepareSparkJobRunWorker(jobId, command, runId) {
  mkdirSync(sparkWorkerLogDir, { recursive: true });
  const safeRunId = normalizeColumnName(runId) || "run";
  return {
    command,
    jobId,
    runId,
    stderrPath: path.join(sparkWorkerLogDir, `${safeRunId}.err.log`),
    stdoutPath: path.join(sparkWorkerLogDir, `${safeRunId}.out.log`),
  };
}

export async function getPipelineRun(jobId, runId) {
  const job = await getJob(jobId);
  if (!job) throw notFoundError(`Job not found: ${jobId}`);
  const run = job.runHistory?.find((item) => item.runId === runId);
  if (!run) throw notFoundError(`Run not found: ${runId}`);
  return {
    jobId,
    jobStatus: job.status,
    run,
    dagSteps: job.dagStepsByRunId?.[runId] ?? job.dagSteps ?? [],
  };
}

export async function readPipelineRunLogs(jobId, runId, options = {}) {
  const { run } = await getPipelineRun(jobId, runId);
  const stream = options.stream === "stderr" ? "stderr" : "stdout";
  const filePath = stream === "stderr" ? run.worker?.stderrPath : run.worker?.stdoutPath;
  const tailBytes = Math.min(Math.max(Number(options.tailBytes || 65536), 1024), 1048576);
  let text = "";
  if (filePath && existsSync(filePath)) {
    const stat = statSync(filePath);
    const offset = Math.max(0, stat.size - tailBytes);
    text = readFileSync(filePath, { encoding: "utf8" }).slice(offset > 0 ? -tailBytes : 0);
  }
  return {
    jobId,
    runId,
    stream,
    tailBytes,
    text,
    worker: run.worker ?? null,
  };
}

function startSparkJobRunWorker(jobId, command, runId, existingWorker = undefined) {
  const worker = existingWorker?.stdoutPath && existingWorker?.stderrPath
    ? {
      command,
      jobId,
      runId,
      stderrPath: existingWorker.stderrPath,
      stdoutPath: existingWorker.stdoutPath,
    }
    : prepareSparkJobRunWorker(jobId, command, runId);
  const stdout = openSync(worker.stdoutPath, "a");
  const stderr = openSync(worker.stderrPath, "a");
  try {
    const child = spawn(
      process.execPath,
      [path.join(scriptsDir, "finalize-spark-job-run.mjs"), jobId, command, runId],
      {
        cwd: backendDir,
        detached: true,
        env: {
          ...process.env,
          ASKLAKE_SPARK_WORKER_PARENT_PID: String(process.pid),
        },
        stdio: ["ignore", stdout, stderr],
      },
    );
    child.unref();
    return {
      ...worker,
      pid: child.pid,
    };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export async function executeQuery(request) {
  const datasetId = request?.datasetId;
  const dataset = await getDataset(datasetId);
  if (!dataset) throw notFoundError(`데이터셋을 찾지 못했습니다: ${datasetId}`);

  const referenceDatasetIds = Array.isArray(request.referenceDatasetIds) ? request.referenceDatasetIds : [];
  const contextDatasets = await queryContextDatasets(request, dataset, referenceDatasetIds);
  const queryResult = runDuckdbPreview({
    datasets: contextDatasets,
    limit: request.limit,
    offset: request.offset,
    query: request.query,
  });
  const result = {
    baseDatasetId: request.baseDatasetId ?? dataset.id,
    columns: queryResult.columns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    executedAt: new Date().toISOString(),
    mode: request.mode ?? "preview",
    previewLimit: request.limit ?? 100,
    previewOffset: request.offset ?? 0,
    query: request.query,
    referenceDatasetIds,
    rowCount: queryResult.rowCount,
    rows: queryResult.rows,
    runId: sourceId("sql", `${dataset.id}:${Date.now()}`),
    validationKey: request.validationKey,
  };
  await saveSqlRun(result);
  return result;
}

export async function previewDatasetRows(datasetId, options = {}) {
  const dataset = await getDataset(datasetId);
  if (!dataset) throw notFoundError(`Dataset not found: ${datasetId}`);

  const queryResult = runDuckdbPreview({
    datasets: [dataset],
    limit: options.limit,
    offset: options.offset,
    query: `SELECT * FROM ${duckdbIdentifier(dataset.name || dataset.id)}`,
  });

  return {
    columns: queryResult.columns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    hasNext: Boolean(queryResult.hasNext),
    limit: queryResult.limit,
    offset: queryResult.offset,
    returnedRows: queryResult.returnedRows ?? queryResult.rows.length,
    rowCount: queryResult.rowCount,
    rows: queryResult.rows,
  };
}

async function queryContextDatasets(request, dataset, referenceDatasetIds) {
  const ids = [
    request?.baseDatasetId || dataset.id,
    dataset.id,
    ...referenceDatasetIds,
  ].filter(Boolean);
  const uniqueIds = Array.from(new Set(ids));
  const datasets = [];
  for (const id of uniqueIds) {
    const contextDataset = id === dataset.id ? dataset : await getDataset(id);
    if (!contextDataset) throw notFoundError(`데이터셋을 찾지 못했습니다: ${id}`);
    datasets.push(contextDataset);
  }
  return datasets;
}

function runDuckdbPreview(payload) {
  const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || process.env.PYTHON || "python";
  const result = spawnSync(pythonBin, [path.join(scriptsDir, "query-duckdb-preview.py")], {
    cwd: backendDir,
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 32 * 1024 * 1024,
  });
  const marker = String(result.stdout || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_QUERY_RUN_RESULT="));
  if (result.status !== 0 || !marker) {
    const error = validationError([
      "SQL preview execution failed.",
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
    error.code = "SQL_PREVIEW_FAILED";
    throw error;
  }
  return JSON.parse(marker.slice("ASKLAKE_QUERY_RUN_RESULT=".length));
}

function duckdbIdentifier(value) {
  return `"${String(value || "dataset").replace(/"/g, "\"\"")}"`;
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

function hasScheduledLabel(scheduleLabel) {
  const schedule = String(scheduleLabel || "").trim().toLowerCase();
  if (!schedule || schedule === "-") return false;
  return !["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token));
}

function hasScheduledExecution(job) {
  return job.status !== "stopped" && hasScheduledLabel(job.schedule);
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

function normalizeQualityStatus(status) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (["pass", "warn", "fail"].includes(normalizedStatus)) return normalizedStatus;
  return normalizedStatus || "pass";
}

function qualityScoreFromSparkResult(result, fallbackScore) {
  const score = Number(result?.quality?.score ?? result?.quality?.passRate);
  if (Number.isFinite(score)) return score;
  const fallback = Number(fallbackScore);
  return Number.isFinite(fallback) ? fallback : undefined;
}

function qualityInvalidRowsFromSparkResult(result, fallbackRows = []) {
  const invalidRows = Number(result?.quality?.invalidRows || 0);
  if (!Number.isFinite(invalidRows) || invalidRows <= 0) return fallbackRows;
  const severity = normalizeQualityStatus(result?.quality?.status) === "fail" ? "Error" : "Warning";
  return [["Spark output", `${invalidRows.toLocaleString()} invalid rows`, severity]];
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "CREATE_PIPELINE_INVALID";
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.status = 409;
  error.code = "CONFLICT";
  return error;
}

function invalidStateError(message) {
  const error = new Error(message);
  error.status = 422;
  error.code = "INVALID_JOB_STATE";
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

  if (command === "stopSchedule") {
    return {
      ...job,
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
      status: "stopped",
    };
  }

  return {
    ...job,
    lastRun: "방금 취소",
    lastState: "취소됨",
    nextRun: scheduleNextRunLabel(job.schedule, job.nextRun),
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
    ], ["즉시 실행 또는 반복 실행 후 Run 로그가 연결됩니다."]),
  ];
}

function runFromCommand(job, command) {
  if (command === "pause" || command === "stopSchedule") return undefined;
  const now = new Date();
  const runId = sourceId("run", `${job.id}:${command}:${now.toISOString()}`);
  const inputRows = job.stats?.inputRows && job.stats.inputRows !== "-" ? job.stats.inputRows : "0";
  if (command === "cancelRun") {
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
    textStructuring: textStructuringRuntimeChecksFromSparkResult(result),
    textStructuringExecution: textStructuringExecutionFromSparkResult(result),
  };
}

function textStructuringRuntimeChecksFromSparkResult(result) {
  const checks = result?.quality?.reviewRowAnalysisChecks;
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => ({
    allowedValues: Array.isArray(check.allowedValues) ? check.allowedValues : [],
    distinctOutputValues: Number(check.distinctOutputValues || 0),
    distributionWarning: check.distributionWarning || "",
    executionMode: check.executionMode || executionModeFromRuntimeStatus(check.runtimeStatus),
    fallbackAllowed: Boolean(check.fallbackAllowed),
    fallbackUsed: Boolean(check.fallbackUsed || check.runtimeStatus === "rule_fallback_output" || check.runtimeStatus === "rule_fallback_planned"),
    invalidRows: Number(check.invalidRows || 0),
    method: check.method || "",
    metrics: check.metrics && typeof check.metrics === "object" ? check.metrics : {},
    modelArtifact: check.modelArtifact || "",
    modelRequired: Boolean(check.modelRequired),
    modelSelectionPolicy: check.modelSelectionPolicy || "",
    outputDistribution: Array.isArray(check.outputDistribution) ? check.outputDistribution : [],
    runtimeStatus: check.runtimeStatus || "",
    selectedModelArtifact: check.selectedModelArtifact || "",
    target: check.target || check.output || check.id || "",
    targetColumn: check.target || check.output || check.id || "",
    validationStatus: check.validationStatus || "",
    validationRows: Number(check.validationRows || check.metrics?.validationRows || 0),
  }));
}

function textStructuringExecutionFromSparkResult(result) {
  const execution = result?.textStructuring?.execution || result?.quality?.textStructuringExecution;
  if (execution && typeof execution === "object") return execution;
  const columns = textStructuringRuntimeChecksFromSparkResult(result);
  return {
    columns,
    fallbackColumns: columns.filter((item) => item.fallbackUsed).map((item) => item.targetColumn || item.target).filter(Boolean),
    missingModelColumns: columns.filter((item) => item.runtimeStatus === "missing_model_artifact").map((item) => item.targetColumn || item.target).filter(Boolean),
    modelColumns: columns
      .filter((item) => item.executionMode === "selected_model" || item.executionMode === "auto_model")
      .map((item) => item.targetColumn || item.target)
      .filter(Boolean),
    oneOfValueColumns: columns.filter((item) => item.method === "one_of_values").length,
    totalColumns: columns.length,
  };
}

function executionModeFromRuntimeStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("missing_model")) return "missing_model";
  if (normalized.includes("fallback")) return "fallback_rule";
  if (normalized.includes("portable_text_model")) return "auto_model";
  return "";
}

function finalizeJobFromSparkResult(job, command, result) {
  const success = result.status === "success";
  const qualityStatus = success ? normalizeQualityStatus(result.quality?.status ?? job.qualityStatus) : "fail";
  return {
    ...job,
    lastRun: result.endedAt ?? new Date().toISOString(),
    lastState: success
      ? `${command === "retry" ? "재실행" : "실행"} 완료 · Spark Parquet 적재`
      : `Spark 실행 실패 · ${result.error ?? "원인 확인 필요"}`,
    nextRun: scheduleNextRunLabel(job.schedule, job.nextRun),
    progress: undefined,
    qualityInvalidRows: success
      ? qualityInvalidRowsFromSparkResult(result, job.qualityInvalidRows)
      : job.qualityInvalidRows,
    qualityScore: success ? qualityScoreFromSparkResult(result, job.qualityScore) : job.qualityScore,
    qualityStatus,
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
    nextDataset.qualityInvalidRows = qualityInvalidRowsFromSparkResult(result, nextDataset.qualityInvalidRows);
    nextDataset.qualityScore = qualityScoreFromSparkResult(result, nextDataset.qualityScore);
    nextDataset.qualityStatus = normalizeQualityStatus(result.quality.status ?? nextDataset.qualityStatus);
  }
  nextDataset.rows = formatRows(result.outputRows);
  nextDataset.sampleRows = Array.isArray(result.sampleRows) ? result.sampleRows : nextDataset.sampleRows ?? [];
  nextDataset.size = result.outputPath ?? nextDataset.size;
  nextDataset.source = job.name;
  nextDataset.sourceRunId = result.runId;
  nextDataset.status = "available";
  nextDataset.textStructuring = textStructuringRuntimeChecksFromSparkResult(result);
  nextDataset.textStructuringDefinition = result?.textStructuring?.definition ?? null;
  nextDataset.textStructuringExecution = textStructuringExecutionFromSparkResult(result);
  if (result.outputPath) {
    nextDataset.storageFormat = "parquet";
    nextDataset.storageLocation = result.outputPath;
  }
  nextDataset.storageSizeBytes = Number(result.storageSizeBytes || nextDataset.storageSizeBytes || 0);
  nextDataset.materializationRuns = upsertMaterializationRun(nextDataset.materializationRuns, materializationRunFromSparkResult(job, result));
  nextDataset.upstream = Array.from(new Set([...(nextDataset.upstream ?? []), result.sourcePath ?? job.source]));
  await saveDataset(nextDataset);
  await saveReviewRowModelArtifacts(job, result, nextDataset);
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
    qualityInvalidRows: qualityInvalidRowsFromSparkResult(result, job.qualityInvalidRows),
    qualityScore: qualityScoreFromSparkResult(result, job.qualityScore),
    qualityStatus: normalizeQualityStatus(result.quality?.status ?? job.qualityStatus),
    rag: Boolean(job.rag),
    rows: formatRows(result.outputRows),
    sampleRows: Array.isArray(result.sampleRows) ? result.sampleRows : Array.isArray(job.schemaSampleRows) ? job.schemaSampleRows : [],
    schema,
    size: result.outputPath ?? "-",
    source: job.name,
    sourceRunId: result.runId,
    status: "available",
    tags: ["#실행완료", `#${String(layer).toLowerCase()}`],
    storageFormat: "parquet",
    storageLocation: result.outputPath ?? null,
    storageSizeBytes: Number(result.storageSizeBytes || 0),
    materializationRuns: [materializationRunFromSparkResult(job, result)],
    textStructuring: textStructuringRuntimeChecksFromSparkResult(result),
    textStructuringDefinition: result?.textStructuring?.definition ?? null,
    textStructuringExecution: textStructuringExecutionFromSparkResult(result),
    upstream: Array.from(new Set([job.sourceLabel, job.name, result.sourcePath ?? job.source].filter(Boolean))),
  };
}

function materializationRunFromSparkResult(job, result) {
  return {
    createdAt: result.endedAt ?? new Date().toISOString(),
    jobId: job.id,
    rowCount: Number(result.outputRows || 0),
    runId: result.runId,
    sourceKind: "etl",
    sourceLabel: job.sourceLabel || job.source || job.name,
    status: result.status === "success" ? "success" : "failed",
    storageLocation: result.outputPath ?? null,
    storageSizeBytes: Number(result.storageSizeBytes || 0),
    quality: result.quality ?? null,
    quarantine: result.quality?.quarantine ?? null,
    textStructuring: textStructuringRuntimeChecksFromSparkResult(result),
    textStructuringExecution: textStructuringExecutionFromSparkResult(result),
  };
}

function upsertMaterializationRun(runs, nextRun) {
  return [
    nextRun,
    ...(Array.isArray(runs) ? runs.filter((run) => run?.runId !== nextRun.runId) : []),
  ];
}

async function saveReviewRowModelArtifacts(job, result, dataset) {
  const checks = result?.quality?.reviewRowAnalysisChecks;
  if (!Array.isArray(checks) || checks.length === 0) return [];
  const saved = [];
  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    if (!check.modelArtifact) continue;
    const target = normalizeColumnName(check.target || check.output || check.id || "output");
    if (!target) continue;
    const artifact = {
      allowedValues: Array.isArray(check.allowedValues) ? check.allowedValues : [],
      artifactType: "model",
      createdAt: result.endedAt ?? new Date().toISOString(),
      datasetName: dataset.name,
      executionMode: check.executionMode || executionModeFromRuntimeStatus(check.runtimeStatus),
      fallbackAllowed: Boolean(check.fallbackAllowed),
      fallbackUsed: Boolean(check.fallbackUsed || check.runtimeStatus === "rule_fallback_output" || check.runtimeStatus === "rule_fallback_planned"),
      id: `model_${normalizeColumnName(dataset.id)}_${target}`,
      jobId: job.id,
      method: check.method || "",
      metrics: check.metrics && typeof check.metrics === "object" ? check.metrics : {},
      distinctOutputValues: Number(check.distinctOutputValues || 0),
      distributionWarning: check.distributionWarning || "",
      modelArtifact: check.modelArtifact || "",
      modelKind: "review_row_text_transform",
      modelRequired: Boolean(check.modelRequired),
      modelSelectionPolicy: check.modelSelectionPolicy || "",
      outputColumn: check.output || target,
      runId: result.runId,
      runtimeStatus: check.runtimeStatus || "",
      outputDistribution: Array.isArray(check.outputDistribution) ? check.outputDistribution : [],
      selectedModelArtifact: check.selectedModelArtifact || "",
      status: check.modelArtifact ? "available" : check.runtimeStatus === "missing_model_artifact" ? "missing" : "fallback",
      supportedMethods: Array.isArray(check.supportedMethods) ? check.supportedMethods : [],
      targetColumn: target,
      targetDatasetId: dataset.id,
      totalRows: Number(check.totalRows || result.outputRows || 0),
      updatedAt: result.endedAt ?? new Date().toISOString(),
      validRows: Number(check.validRows || 0),
      validationStatus: check.validationStatus || "",
      validationRows: Number(check.validationRows || check.metrics?.validationRows || 0),
    };
    saved.push(await saveModelArtifact(artifact));
  }
  return saved;
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
  const canceled = command === "cancelRun";
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
