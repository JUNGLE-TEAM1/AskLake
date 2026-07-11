import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../types";
import { apiConfig } from "../services/apiClient";
import { deleteDatasetMaterializationRun } from "../services/catalogApi";
import { applyDraftPipelinePatch } from "../services/draftPipelineContract";
import {
  createPipelineDraft as createMockPipelineDraft,
  getDatasets,
  getJobs,
  runJobCommand as runMockJobCommand,
} from "../services/mockApi";
import {
  createPipelineDraft as createLivePipelineDraft,
  runJobCommand as runLiveJobCommand,
} from "../services/pipelineApi";
import { normalizeDatasetStatus, normalizeJobStatus } from "../utils/statusMeta";
import { permissionDeniedMessage } from "../utils/permissions";
import type {
  AuditResult,
  AuditTargetType,
  CatalogDataset,
  CreateDerivedDatasetRequest,
  DagStepsByRunId,
  DraftPipeline,
  DraftPipelinePatch,
  FlowId,
  JobCommand,
  JobExecutionEvidence,
  JobListFacets,
  JobListQuery,
  JobRowData,
  JobRunOutcome,
  JobRunSummary,
  RunsByJobId,
  SelectedRunIdByJobId,
  SchemaColumnDraft,
  SqlResultDraft,
  TransformStepDraft,
} from "../types";

type WriteAuditLog = (action: string, apiPath: string, targetId: string, result?: AuditResult, options?: { targetType?: AuditTargetType }) => void;

type JobRunStateMaps = {
  dagStepsByRunId: DagStepsByRunId;
  runsByJobId: RunsByJobId;
  selectedRunIdByJobId: SelectedRunIdByJobId;
};

type ServerJobCommand = Exclude<JobCommand, "edit" | "delete">;
type CommandPendingByJobId = Partial<Record<string, ServerJobCommand>>;

const catalogDatasetStorageKey = "asklake.catalogDatasets";
const legacyDerivedDatasetStorageKey = "asklake.derivedDatasets";
const maxStoredCatalogDatasets = 30;

function normalizeInitialDraftPipeline(draft: DraftPipeline): DraftPipeline {
  return {
    ...draft,
    id: "",
    permission: {
      ...draft.permission,
      summary: "기본 소유자만 설정되었습니다.",
    },
    quality: {
      ...draft.quality,
      invalidRows: [],
      rules: [],
      score: undefined,
      status: "idle",
      summary: "데이터 품질 규칙을 설정하세요.",
    },
    schedule: {
      ...draft.schedule,
      endDate: "",
      label: "수동 실행",
      mode: "manual",
      nextRun: "-",
      nextRunUtc: undefined,
      overlapPolicy: "skip_if_running",
      startDate: "",
      summary: "수동 실행 · 저장 후 목록에서 직접 실행",
      timezone: "(GMT+09:00) Seoul, Tokyo",
      watermarkPolicy: {
        column: "updated_at",
        enabled: false,
        lookbackMinutes: 5,
        mode: "full_refresh",
      },
    },
    schema: {
      ...draft.schema,
      columns: [],
      sampleRows: [],
      summary: "스키마 추론 대기",
    },
    source: {
      ...draft.source,
      connectionMessage: "소스를 선택하고 연결 테스트를 실행하세요.",
      connectionStatus: "idle",
      sourceConfig: [],
      sourceLabel: "",
      sourceType: "",
    },
    target: {
      ...draft.target,
      datasetName: "",
      description: "",
      partition: "",
      partitionColumns: [],
      rag: false,
      storagePath: "",
      tableName: "",
      tags: [],
      testStatus: "idle",
    },
    transform: {
      ...draft.transform,
      outputColumns: [],
      steps: [],
      summary: "변환 규칙을 설정하세요.",
    },
  };
}

const initialDraftPipeline: DraftPipeline = normalizeInitialDraftPipeline({
  id: "",
  permission: {
    owner: "",
    roles: [],
    summary: "Data Engineer Group · 조직 기본 권한",
  },
  quality: {
    invalidRows: [],
    rules: [],
    score: 94.2,
    status: "pass",
    summary: "품질 규칙 5개 · 유효하지 않은 행 격리",
  },
  schedule: {
    endDate: "",
    label: "매주 목요일 10:30",
    mode: "repeat",
    nextRun: "다음 예약 대기",
    retryPolicy: {
      backoffMultiplier: 2,
      backoffStrategy: "exponential",
      failureAction: "retry_then_fail",
      initialRetryDelayMinutes: 1,
      maxRetries: 3,
      maxRetryDelayMinutes: 30,
      retryIntervalMinutes: 10,
      timeoutMinutes: 60,
    },
    startDate: "2026-07-02",
    summary: "매주 목요일 10:30 · 시작 2026.07.02 · 종료일 없음 · (GMT+09:00) Seoul, Tokyo",
    timezone: "(GMT+09:00) Seoul, Tokyo",
  },
  schema: {
    columns: [],
    sampleRows: [],
    summary: "스키마 추론 대기",
  },
  source: {
    connectionMessage: "검토 전에 소스 연결 테스트가 필요합니다.",
    connectionStatus: "idle",
    sourceConfig: [],
    sourceLabel: "",
    sourceType: "",
  },
  target: {
    compression: "Snappy",
    datasetName: "pair_a_customer_review_gold",
    description: "고객 리뷰 분석용 정제 데이터셋",
    format: "Parquet",
    layer: "GOLD",
    partition: "date/category",
    partitionColumns: ["date", "category"],
    rag: false,
    storagePath: "s3a://asklake-output/pair_a_customer_review_gold/gold/",
    storageType: "S3",
    tableName: "pair_a_customer_review_gold",
    tags: ["고객데이터", "분석용", "가공됨"],
    testStatus: "idle",
  },
  transform: {
    outputColumns: [],
    steps: [],
    summary: "변환 규칙과 품질 검사를 설정하세요.",
  },
});

const emptySelectedDataset: CatalogDataset = {
  description: "생성된 데이터셋이 없습니다. 수집/처리에서 파이프라인을 먼저 생성하고 실행하세요.",
  downstream: [],
  freshness: "approval",
  id: "dataset_not_selected",
  layer: "RAW",
  lastUpdated: "-",
  name: "데이터셋 없음",
  nextRefresh: "-",
  owner: "-",
  quality: "-",
  rag: false,
  rows: "0행",
  sampleRows: [],
  schema: [],
  size: "-",
  source: "-",
  status: "approval_required",
  tags: [],
  upstream: [],
};

const emptySelectedJob: JobRowData = {
  id: "JOB-NONE",
  lastRun: "-",
  lastState: "작업 없음",
  name: "작업 없음",
  nextRun: "-",
  owner: "-",
  schedule: "-",
  source: "-",
  status: "paused",
  tag: "[없음]",
  target: "-",
};

function isCatalogDataset(value: unknown): value is CatalogDataset {
  if (!value || typeof value !== "object") return false;
  const dataset = value as Partial<CatalogDataset>;
  return typeof dataset.id === "string"
    && typeof dataset.name === "string"
    && Array.isArray(dataset.schema)
    && Array.isArray(dataset.sampleRows)
    && Array.isArray(dataset.tags);
}

function parseStoredCatalogDatasets(storageKey: string) {
  if (typeof window === "undefined") return [];

  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter(isCatalogDataset).map(normalizeDatasetRow) : [];
  } catch {
    return [];
  }
}

function loadStoredCatalogDatasets() {
  if (!apiConfig.useMock || typeof window === "undefined") return [];

  return mergeStoredCatalogDatasets([
    ...parseStoredCatalogDatasets(catalogDatasetStorageKey),
    ...parseStoredCatalogDatasets(legacyDerivedDatasetStorageKey),
  ]);
}

function mergeStoredCatalogDatasets(datasets: CatalogDataset[]) {
  return datasets.filter((dataset, index, items) => (
    items.findIndex((item) => item.id === dataset.id) === index
  ));
}

function mergeCatalogDatasets(baseDatasets: CatalogDataset[], storedDatasets: CatalogDataset[]) {
  const uniqueStoredDatasets = mergeStoredCatalogDatasets(storedDatasets);
  const storedDatasetIds = new Set(uniqueStoredDatasets.map((dataset) => dataset.id));
  const baseDatasetById = new Map(baseDatasets.map((dataset) => [dataset.id, dataset]));
  const mergedStoredDatasets = uniqueStoredDatasets.map((storedDataset) => {
    const baseDataset = baseDatasetById.get(storedDataset.id);
    if (!baseDataset) return storedDataset;

    const materializationRuns = new Map([
      ...(baseDataset.materializationRuns ?? []),
      ...(storedDataset.materializationRuns ?? []),
    ].map((run) => [run.runId, run]));

    return {
      ...baseDataset,
      ...storedDataset,
      materializationRuns: Array.from(materializationRuns.values()),
    };
  });

  return [
    ...mergedStoredDatasets,
    ...baseDatasets.filter((dataset) => !storedDatasetIds.has(dataset.id)),
  ].map(normalizeDatasetRow);
}

function saveStoredCatalogDataset(dataset: CatalogDataset) {
  if (!apiConfig.useMock || typeof window === "undefined") return;

  const previousDatasets = loadStoredCatalogDatasets();
  const nextDatasets = [dataset, ...previousDatasets.filter((item) => item.id !== dataset.id)]
    .slice(0, maxStoredCatalogDatasets);
  const nextLegacyDatasets = parseStoredCatalogDatasets(legacyDerivedDatasetStorageKey)
    .filter((item) => item.id !== dataset.id);

  window.localStorage.setItem(catalogDatasetStorageKey, JSON.stringify(nextDatasets));
  window.localStorage.setItem(legacyDerivedDatasetStorageKey, JSON.stringify(nextLegacyDatasets));
}

function getInitialDatasets() {
  return [];
}

function getInitialJobs() {
  return [];
}

function buildSqlDatasetJobDraft(
  request: CreateDerivedDatasetRequest,
  sourceDataset: CatalogDataset,
  sqlResult: SqlResultDraft,
): DraftPipeline {
  const targetDataset = normalizeDraftDatasetName(request.dataset.name, `${sourceDataset.name}_analysis`);
  const targetLayer = request.dataset.layer;
  const outputColumns: Array<[string, string]> = sqlResult.columns.map((column) => [column, inferSqlResultColumnType(sourceDataset, column)]);
  const schemaColumns: SchemaColumnDraft[] = outputColumns.map(([name, type], index) => ({
    confidence: 1,
    included: true,
    nullable: true,
    role: index === 0 ? "primary" : "derived",
    sourceName: name,
    targetName: name,
    type,
  }));
  const transformStep: TransformStepDraft = {
    enabled: true,
    id: "sql-preview-materialize",
    input: sourceDataset.name,
    kind: "derive",
    label: "SQL Preview 결과 저장",
    onError: "Fail Run",
    operation: "SQL_RESULT_MATERIALIZE",
    output: targetDataset,
    params: request.query,
  };

  return {
    ...initialDraftPipeline,
    id: `sql_${normalizeDraftId(targetDataset)}_${normalizeDraftId(sqlResult.runId).slice(-8)}`,
    permission: {
      ...initialDraftPipeline.permission,
      owner: sourceDataset.owner || initialDraftPipeline.permission.owner,
      summary: "Data Engineer Group · 조직 내부 · 승인 완료",
    },
    quality: {
      invalidRows: [],
      rules: [],
      score: 100,
      status: "pass",
      summary: `SQL Preview 검증 완료 · ${sqlResult.rowCount.toLocaleString()} rows · read-only query`,
    },
    schedule: {
      ...initialDraftPipeline.schedule,
      endDate: "",
      label: "수동 실행",
      mode: "manual",
      nextRun: "수동 실행 대기",
      startDate: "",
      summary: "SQL 결과 저장 Job · 수동 실행",
    },
    schema: {
      columns: schemaColumns,
      sampleRows: sqlResult.rows,
      schemaFingerprint: `${sqlResult.runId}:${sqlResult.columns.join("|")}`,
      summary: `${schemaColumns.length}개 컬럼 · Preview ${sqlResult.rows.length}/${sqlResult.rowCount} rows`,
    },
    source: {
      connectionMessage: `SQL Preview ${sqlResult.runId} 결과를 처리 Job 입력으로 사용합니다.`,
      connectionStatus: "success",
      sourceConfig: [
        ["Source Dataset", sourceDataset.name],
        ["Source Dataset ID", sourceDataset.id],
        ["SQL Run ID", sqlResult.runId],
        ["Preview Limit", String(sqlResult.previewLimit ?? request.previewLimit ?? "")],
        ["Preview Row Count", String(sqlResult.rowCount)],
        ["Reference Dataset IDs", (request.referenceDatasetIds ?? []).join(", ") || "-"],
        ["Validation Key", request.validationKey ?? "-"],
        ["Query", request.query],
      ],
      sourceLabel: `${sourceDataset.name} / ${sqlResult.runId}`,
      sourceType: "SQL Result",
    },
    target: {
      ...initialDraftPipeline.target,
      compression: "Snappy",
      datasetName: targetDataset,
      format: "Parquet",
      layer: targetLayer,
      partition: "sql_run_date",
      rag: request.dataset.rag,
      storagePath: `s3a://asklake-output/${targetDataset}/${targetLayer.toLowerCase()}/`,
      storageType: "S3",
    },
    transform: {
      outputColumns,
      steps: [transformStep],
      summary: `SQL Preview ${sqlResult.runId} 결과를 ${targetDataset} 데이터셋으로 저장`,
    },
  };
}

function inferSqlResultColumnType(dataset: CatalogDataset, columnName: string) {
  return dataset.schema.find(([name]) => name === columnName)?.[1] ?? "string";
}

function normalizeDraftDatasetName(value: string, fallback: string) {
  const normalized = value.trim() || fallback;
  return normalized.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "sql_derived_dataset";
}

function normalizeDraftId(value: string) {
  return normalizeDraftDatasetName(value, "sql_derived").toLowerCase();
}

function normalizeJobRow(job: JobRowData): JobRowData {
  const status = normalizeJobStatus(String(job.status));
  return {
    ...job,
    status: status === "failed" || status === "canceled" || status === "paused" ? "scheduled" : status,
  };
}

const jobStatuses = ["scheduled", "failed", "running", "paused", "canceled", "stopped"] as const;

function getLatestRunOutcome(job: JobRowData): JobRunOutcome | undefined {
  const status = job.runHistory?.[0]?.status;
  return status === "success" || status === "failed" || status === "canceled" ? status : undefined;
}

function getJobListFacets(jobs: JobRowData[]): JobListFacets {
  return {
    latestRunOutcomeCounts: {
      canceled: jobs.filter((job) => getLatestRunOutcome(job) === "canceled").length,
      failed: jobs.filter((job) => getLatestRunOutcome(job) === "failed").length,
      success: jobs.filter((job) => getLatestRunOutcome(job) === "success").length,
    },
    owners: Array.from(new Set(jobs.map((job) => job.owner).filter(Boolean))).sort((first, second) => first.localeCompare(second)),
    statusCounts: Object.fromEntries(jobStatuses.map((status) => [status, jobs.filter((job) => job.status === status).length])) as JobListFacets["statusCounts"],
    total: jobs.length,
  };
}

function moveJobFacetCounts(facets: JobListFacets, previousJob: JobRowData, nextJob: JobRowData): JobListFacets {
  const previousOutcome = getLatestRunOutcome(previousJob);
  const nextOutcome = getLatestRunOutcome(nextJob);
  const statusCounts = { ...facets.statusCounts };
  const latestRunOutcomeCounts = { ...facets.latestRunOutcomeCounts };
  if (previousJob.status !== nextJob.status) {
    statusCounts[previousJob.status] = Math.max(0, (statusCounts[previousJob.status] ?? 0) - 1);
    statusCounts[nextJob.status] = (statusCounts[nextJob.status] ?? 0) + 1;
  }
  if (previousOutcome !== nextOutcome) {
    if (previousOutcome) latestRunOutcomeCounts[previousOutcome] = Math.max(0, (latestRunOutcomeCounts[previousOutcome] ?? 0) - 1);
    if (nextOutcome) latestRunOutcomeCounts[nextOutcome] = (latestRunOutcomeCounts[nextOutcome] ?? 0) + 1;
  }
  return {
    ...facets,
    latestRunOutcomeCounts,
    statusCounts,
  };
}

function normalizeDatasetRow(dataset: CatalogDataset): CatalogDataset {
  return {
    ...dataset,
    materializationRuns: dataset.materializationRuns ?? [],
    status: normalizeDatasetStatus(String(dataset.status)),
  };
}

function formatStorageSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = sizeBytes;
  for (const unit of units) {
    size /= 1024;
    if (size < 1024) return `${size.toFixed(1)}${unit}`;
  }
  return `${size.toFixed(1)}PB`;
}

function recalculateDatasetFromMaterializationRuns(dataset: CatalogDataset): CatalogDataset {
  const materializationRuns = dataset.materializationRuns ?? [];
  const activeRuns = materializationRuns.filter((run) => run.status === "success");
  const latestRun = activeRuns[0];
  const rowCount = activeRuns.reduce((total, run) => total + Math.max(run.rowCount || 0, 0), 0);
  const storageSizeBytes = activeRuns.reduce((total, run) => total + Math.max(run.storageSizeBytes || 0, 0), 0);

  return normalizeDatasetRow({
    ...dataset,
    lastUpdated: latestRun?.createdAt ?? dataset.lastUpdated,
    rows: `${rowCount.toLocaleString()} rows`,
    size: storageSizeBytes > 0 ? formatStorageSize(storageSizeBytes) : "0B",
    sourceRunId: latestRun?.runId,
    storageSizeBytes,
  });
}

function upsertRunByRunId(runs: JobRunSummary[], run: JobRunSummary): JobRunSummary[] {
  return [run, ...runs.filter((item) => item.runId !== run.runId)];
}

function replaceTempRunByRunId(runs: JobRunSummary[], tempRunId: string, run: JobRunSummary): JobRunSummary[] {
  return [run, ...runs.filter((item) => item.runId !== tempRunId && item.runId !== run.runId)];
}

function withoutRecordKey<T>(record: Record<string, T>, key?: string | null): Record<string, T> {
  if (!key || !(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([recordKey]) => recordKey !== key)) as Record<string, T>;
}

function restoreRecordEntry<T>(record: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  if (value === undefined) return withoutRecordKey(record, key);
  return {
    ...record,
    [key]: value,
  };
}

function uniqueRunsByRunId(runs: JobRunSummary[]): JobRunSummary[] {
  const seenRunIds = new Set<string>();
  return runs.filter((run) => {
    if (seenRunIds.has(run.runId)) return false;
    seenRunIds.add(run.runId);
    return true;
  });
}

function selectedRunFirst(runs: JobRunSummary[], selectedRunId?: string): JobRunSummary[] {
  if (!selectedRunId) return runs;
  const selectedRun = runs.find((run) => run.runId === selectedRunId);
  if (!selectedRun) return runs;
  return [selectedRun, ...runs.filter((run) => run.runId !== selectedRunId)];
}

function buildJobExecutionEvidence(
  runsByJobId: RunsByJobId,
  selectedRunIdByJobId: SelectedRunIdByJobId,
  dagStepsByRunId: DagStepsByRunId,
): Record<string, JobExecutionEvidence> {
  return Object.fromEntries(
    Object.entries(runsByJobId).map(([jobId, runs]) => {
      const requestedRunId = selectedRunIdByJobId[jobId];
      const selectedRunId = requestedRunId && runs.some((run) => run.runId === requestedRunId)
        ? requestedRunId
        : runs[0]?.runId;
      return [
        jobId,
        {
          dagSteps: selectedRunId ? (dagStepsByRunId[selectedRunId] ?? []) : [],
          runs: selectedRunFirst(runs, selectedRunId),
        },
      ];
    }),
  );
}

function buildRunStateFromJobs(jobs: JobRowData[]): JobRunStateMaps {
  const runsByJobId: RunsByJobId = {};
  const selectedRunIdByJobId: SelectedRunIdByJobId = {};
  const dagStepsByRunId: DagStepsByRunId = {};

  jobs.forEach((job) => {
    const runs = uniqueRunsByRunId(job.runHistory ?? []);
    if (runs.length === 0) return;

    const selectedRunId = runs[0].runId;
    runsByJobId[job.id] = runs;
    selectedRunIdByJobId[job.id] = selectedRunId;

    Object.entries(job.dagStepsByRunId ?? {}).forEach(([runId, steps]) => {
      if (Array.isArray(steps) && steps.length > 0) {
        dagStepsByRunId[runId] = steps;
      }
    });

    if (job.dagSteps?.length && !dagStepsByRunId[selectedRunId]) {
      dagStepsByRunId[selectedRunId] = job.dagSteps;
    }
  });

  return { dagStepsByRunId, runsByJobId, selectedRunIdByJobId };
}

function isFetchConnectionError(error: unknown) {
  return error instanceof TypeError && /fetch|network|load failed|connection/i.test(error.message);
}

function isRecoverableInitialReadError(error: unknown) {
  if (error instanceof ApiError) {
    return error.status === 404 || error.status === 502 || error.status === 503 || error.status === 504;
  }

  return isFetchConnectionError(error);
}

function getInitialReadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to load AskLake data.";
}

async function readInitialResource<T>(
  read: () => Promise<T>,
  resourceName: string,
  fallback: T,
): Promise<{ data: T; error: string | null; fatal: boolean }> {
  try {
    return {
      data: await read(),
      error: null,
      fatal: false,
    };
  } catch (error) {
    return {
      data: fallback,
      error: `${resourceName}: ${getInitialReadErrorMessage(error)}`,
      fatal: !isRecoverableInitialReadError(error),
    };
  }
}

function isOptimisticRunCommand(command: JobCommand): command is "run" | "retry" {
  return command === "run" || command === "retry";
}

function commandSuccessMessage(command: ServerJobCommand, job: JobRowData): string {
  const schedule = job.schedule.toLocaleLowerCase();
  const realtime = ["실시간", "realtime", "real-time", "stream", "kafka"].some((token) => schedule.includes(token));

  if (command === "run") return "작업 실행 요청을 접수했습니다.";
  if (command === "retry") return "작업 재실행 요청을 접수했습니다.";
  if (command === "pause") return "실행 일시정지 요청을 접수했습니다.";
  if (command === "stopSchedule") return realtime ? "실시간 수집을 중지했습니다." : "다음 반복 예약을 중지했습니다.";
  if (command === "resumeSchedule") return realtime ? "실시간 수집을 다시 시작했습니다." : "반복 스케줄을 다시 시작했습니다.";
  return "작업 취소 요청을 접수했습니다.";
}

function commandFailureMessage(error: unknown, command: ServerJobCommand): string {
  if (error instanceof ApiError && error.status === 403) {
    return permissionDeniedMessage("작업", command === "run" || command === "retry" ? "실행" : "관리");
  }
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `작업 명령 실패: ${detail}` : "작업 명령 처리에 실패했습니다.";
}

function buildClientRunId(jobId: string): string {
  return `client:${jobId}:${Date.now()}`;
}

function buildOptimisticRun(runId: string): JobRunSummary {
  return {
    duration: "-",
    endedAt: "-",
    errorSummary: "",
    failedStage: "-",
    inputRows: "-",
    outputRows: "-",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
  };
}

function buildOptimisticJob(job: JobRowData): JobRowData {
  return normalizeJobRow({
    ...job,
    lastRun: "현재 실행 중",
    lastState: "실행 요청 처리 중",
    nextRun: "-",
    progress: {
      label: "실행 요청 처리 중",
      value: 5,
    },
    status: "running",
  });
}

export function useAskLakeData({
  enabled = true,
  onFlowChange,
  showToast,
  writeAuditLog,
}: {
  enabled?: boolean;
  onFlowChange: (flow: FlowId) => void;
  showToast: (message: string, tone?: "success" | "info") => void;
  writeAuditLog: WriteAuditLog;
}) {
  const [jobs, setJobs] = useState<JobRowData[]>(getInitialJobs);
  const [jobListFacets, setJobListFacets] = useState<JobListFacets>(() => getJobListFacets(getInitialJobs()));
  const [datasets, setDatasets] = useState<CatalogDataset[]>(getInitialDatasets);
  const [draftPipeline, setDraftPipeline] = useState<DraftPipeline>(initialDraftPipeline);
  const [selectedDataset, setSelectedDataset] = useState<CatalogDataset>(() => getInitialDatasets()[0] ?? emptySelectedDataset);
  const [selectedJob, setSelectedJob] = useState<JobRowData>(() => getInitialJobs()[0] ?? emptySelectedJob);
  const [runsByJobId, setRunsByJobId] = useState<RunsByJobId>({});
  const [selectedRunIdByJobId, setSelectedRunIdByJobId] = useState<SelectedRunIdByJobId>({});
  const [dagStepsByRunId, setDagStepsByRunId] = useState<DagStepsByRunId>({});
  const [commandPendingByJobId, setCommandPendingByJobId] = useState<CommandPendingByJobId>({});
  const [sqlResultDraft, setSqlResultDraft] = useState<SqlResultDraft | null>(null);
  const [apiPending, setApiPending] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const createPendingRef = useRef(false);
  const commandPendingRef = useRef<Set<string>>(new Set());
  const jobsFilterRequestRef = useRef(0);

  const jobExecutionEvidence = useMemo(
    () => buildJobExecutionEvidence(runsByJobId, selectedRunIdByJobId, dagStepsByRunId),
    [dagStepsByRunId, runsByJobId, selectedRunIdByJobId],
  );

  useEffect(() => {
    if (!enabled) {
      setDataLoading(false);
      return;
    }
    if (apiConfig.useMock) {
      const initialJobs = getInitialJobs();
      const hydratedRunState = buildRunStateFromJobs(initialJobs);
      setJobListFacets(getJobListFacets(initialJobs));
      setRunsByJobId(hydratedRunState.runsByJobId);
      setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
      setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
      setDataLoading(false);
      setDataError(null);
      return;
    }

    let cancelled = false;

    async function hydrateData() {
      setDataError(null);
      const [jobsResult, datasetsResult] = await Promise.all([
        readInitialResource(getJobs, "jobs", { facets: getJobListFacets([]), jobs: [] }),
        readInitialResource(getDatasets, "catalog", []),
      ]);
      if (cancelled) return;

      const normalizedJobs = jobsResult.data.jobs.map(normalizeJobRow);
      const normalizedDatasets = datasetsResult.data.map(normalizeDatasetRow);
      const hydratedRunState = buildRunStateFromJobs(normalizedJobs);
      setJobs(normalizedJobs);
      setJobListFacets(jobsResult.data.facets);
      setDatasets(normalizedDatasets);
      setSelectedJob(normalizedJobs[0] ?? emptySelectedJob);
      setSelectedDataset(normalizedDatasets[0] ?? emptySelectedDataset);
      setRunsByJobId(hydratedRunState.runsByJobId);
      setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
      setDagStepsByRunId(hydratedRunState.dagStepsByRunId);

      const fatalErrors = [jobsResult, datasetsResult]
        .filter((result) => result.fatal && result.error)
        .map((result) => result.error);
      const recoverableErrors = [jobsResult, datasetsResult]
        .filter((result) => !result.fatal && result.error)
        .map((result) => result.error);

      if (fatalErrors.length > 0) {
        setDataError(fatalErrors.join(" / "));
      } else if (recoverableErrors.length > 0) {
        setDataError(null);
        showToast("DB API 초기 목록을 불러오지 못해 빈 상태로 표시합니다.", "info");
      }

      setDataLoading(false);
    }

    void hydrateData();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const filterJobs = async (query: JobListQuery) => {
    const requestId = jobsFilterRequestRef.current + 1;
    jobsFilterRequestRef.current = requestId;
    setJobsLoading(true);
    try {
      const result = await getJobs(query);
      if (requestId !== jobsFilterRequestRef.current) return;
      const normalizedJobs = result.jobs.map(normalizeJobRow);
      const hydratedRunState = buildRunStateFromJobs(normalizedJobs);
      setJobs(normalizedJobs);
      setJobListFacets(result.facets);
      setRunsByJobId(hydratedRunState.runsByJobId);
      setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
      setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
    } catch (error) {
      if (requestId !== jobsFilterRequestRef.current) return;
      const message = error instanceof ApiError ? error.message : "작업 목록 필터를 불러오지 못했습니다.";
      showToast(message, "info");
    } finally {
      if (requestId === jobsFilterRequestRef.current) setJobsLoading(false);
    }
  };

  const updateDraftPipeline = (patch: DraftPipelinePatch) => {
    setDraftPipeline((draft) => applyDraftPipelinePatch(draft, patch));
  };

  const createPipeline = async () => {
    if (createPendingRef.current) {
      showToast("이미 생성 요청이 처리 중입니다.", "info");
      return;
    }

    const previousState = {
      datasets,
      jobListFacets,
      jobs,
      selectedDataset,
      selectedJob,
    };
    createPendingRef.current = true;
    setApiPending(true);
    try {
      const result = apiConfig.useMock
        ? await createMockPipelineDraft(draftPipeline, jobs.length)
        : await createLivePipelineDraft(draftPipeline);
      const normalizedJob = normalizeJobRow(result.job);
      const normalizedDataset = result.dataset ? normalizeDatasetRow(result.dataset) : null;
      const nextJobs = [normalizedJob, ...jobs.filter((item) => item.name !== normalizedJob.name)];

      setJobs(nextJobs);
      setJobListFacets(getJobListFacets(nextJobs));
      setSelectedJob(normalizedJob);
      if (normalizedDataset) {
        saveStoredCatalogDataset(normalizedDataset);
        setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
        setSelectedDataset(normalizedDataset);
      }
      writeAuditLog("etl.job.created", "/api/etl/jobs", draftPipeline.id);
      writeAuditLog("etl.run.queued", `/api/etl/jobs/${draftPipeline.id}/runs`, draftPipeline.id);
      showToast(normalizedDataset ? "파이프라인 생성 요청이 접수되었습니다." : "파이프라인 생성 요청을 접수했습니다. 실행 성공 후 카탈로그에 등록됩니다.");
      setDraftPipeline(initialDraftPipeline);
      onFlowChange("jobs");
    } catch (error) {
      setJobs(previousState.jobs);
      setJobListFacets(previousState.jobListFacets);
      setDatasets(previousState.datasets);
      setSelectedJob(previousState.selectedJob);
      setSelectedDataset(previousState.selectedDataset);
      writeAuditLog("etl.job.create_failed", "/api/etl/jobs", draftPipeline.id, "failed");
      const message = error instanceof ApiError ? error.message : "파이프라인 생성 요청에 실패했습니다.";
      showToast(message, "info");
    } finally {
      createPendingRef.current = false;
      setApiPending(false);
    }
  };

  const prepareSqlDatasetJobDraft = (request: CreateDerivedDatasetRequest) => {
    const sourceDataset = datasets.find((item) => item.id === request.sourceDatasetId);
    const currentSqlResult = sqlResultDraft?.runId === request.sourceRunId ? sqlResultDraft : null;

    if (!sourceDataset || !currentSqlResult) {
      writeAuditLog("analysis.derived_dataset.job_draft_failed", "/api/etl/jobs", request.sourceDatasetId, "failed");
      showToast("처리 Job 생성에 필요한 SQL Preview 결과를 찾지 못했습니다.", "info");
      return false;
    }

    const nextDraft = buildSqlDatasetJobDraft(request, sourceDataset, currentSqlResult);
    setDraftPipeline(nextDraft);
    setSelectedDataset(sourceDataset);
    writeAuditLog("analysis.derived_dataset.job_draft_prepared", "/api/etl/jobs", nextDraft.id);
    showToast("SQL 결과 기반 처리 Job 초안을 만들었습니다.");
    onFlowChange("review");
    return true;
  };

  const deleteMaterializationRun = async (datasetId: string, runId: string) => {
    const previousState = {
      datasets,
      selectedDataset,
    };
    const targetDataset = datasets.find((dataset) => dataset.id === datasetId);
    if (!targetDataset) {
      showToast("삭제할 append 결과를 찾지 못했습니다.", "info");
      return;
    }

    const applyDataset = (dataset: CatalogDataset) => {
      const normalizedDataset = normalizeDatasetRow(dataset);
      setDatasets((items) => items.map((item) => (item.id === datasetId ? normalizedDataset : item)));
      setSelectedDataset((current) => (current.id === datasetId ? normalizedDataset : current));
      return normalizedDataset;
    };

    try {
      const nextDataset = apiConfig.useMock
        ? recalculateDatasetFromMaterializationRuns({
            ...targetDataset,
            materializationRuns: (targetDataset.materializationRuns ?? []).filter((run) => run.runId !== runId),
          })
        : normalizeDatasetRow((await deleteDatasetMaterializationRun(datasetId, runId)).dataset);

      applyDataset(nextDataset);
      writeAuditLog("catalog.dataset.materialization_run_deleted", `/api/catalog/datasets/${datasetId}/materialization-runs/${runId}`, runId, "success", { targetType: "dataset" });
      showToast("데이터셋 append 결과를 삭제했습니다.");
    } catch (error) {
      setDatasets(previousState.datasets);
      setSelectedDataset(previousState.selectedDataset);
      writeAuditLog("catalog.dataset.materialization_run_delete_failed", `/api/catalog/datasets/${datasetId}/materialization-runs/${runId}`, runId, "failed", { targetType: "dataset" });
      showToast("append 결과 삭제에 실패했습니다.", "info");
    }
  };

  const updateJobState = (jobId: string, updater: (job: JobRowData) => JobRowData) => {
    setJobs((items) => items.map((job) => (job.id === jobId ? updater(job) : job)));
    setSelectedJob((job) => (job.id === jobId ? updater(job) : job));
  };

  const selectRunForJob = (jobId: string, runId: string) => {
    setSelectedRunIdByJobId((state) => {
      const runExists = (runsByJobId[jobId] ?? []).some((run) => run.runId === runId);
      if (!runExists || state[jobId] === runId) return state;
      return {
        ...state,
        [jobId]: runId,
      };
    });
  };

  const handleJobCommand = async (job: JobRowData, command: JobCommand): Promise<JobRowData | undefined> => {
    if (command === "edit") {
      writeAuditLog("etl.job.edit_opened", `/api/etl/jobs/${job.id}`, job.id);
      setSelectedJob(job);
      onFlowChange("source");
      return undefined;
    }

    if (command === "delete") {
      writeAuditLog("etl.job.delete_requested", `/api/etl/jobs/${job.id}`, job.id);
      const remaining = jobs.filter((item) => item.id !== job.id);
      const deletedRunIds = new Set((runsByJobId[job.id] ?? []).map((run) => run.runId));
      setJobs(remaining);
      setSelectedJob(remaining[0] ?? emptySelectedJob);
      setRunsByJobId((state) => withoutRecordKey(state, job.id));
      setSelectedRunIdByJobId((state) => withoutRecordKey(state, job.id));
      setDagStepsByRunId((state) => Object.fromEntries(Object.entries(state).filter(([runId]) => !deletedRunIds.has(runId))));
      commandPendingRef.current.delete(job.id);
      setCommandPendingByJobId((state) => {
        const { [job.id]: _pendingCommand, ...rest } = state;
        return rest;
      });
      onFlowChange("jobs");
      return undefined;
    }

    if (commandPendingRef.current.has(job.id)) {
      showToast("이미 이 작업 명령을 처리 중입니다.", "info");
      return;
    }

    const previousJob = jobs.find((item) => item.id === job.id) ?? job;
    const previousRunsForJob = runsByJobId[job.id];
    const previousSelectedRunId = selectedRunIdByJobId[job.id];
    const tempRunId = isOptimisticRunCommand(command) ? buildClientRunId(job.id) : null;
    const rollbackOptimisticRun = () => {
      setJobs((items) => items.map((item) => (item.id === job.id ? previousJob : item)));
      setSelectedJob((current) => (current.id === job.id ? previousJob : current));
      setRunsByJobId((state) => restoreRecordEntry(state, job.id, previousRunsForJob));
      setSelectedRunIdByJobId((state) => restoreRecordEntry(state, job.id, previousSelectedRunId));
      setDagStepsByRunId((state) => withoutRecordKey(state, tempRunId));
    };

    if (tempRunId) {
      const optimisticRun = buildOptimisticRun(tempRunId);
      const optimisticJob = buildOptimisticJob(job);
      updateJobState(job.id, () => optimisticJob);
      setRunsByJobId((state) => ({
        ...state,
        [job.id]: upsertRunByRunId(state[job.id] ?? [], optimisticRun),
      }));
      setSelectedRunIdByJobId((state) => ({
        ...state,
        [job.id]: tempRunId,
      }));
    }

    commandPendingRef.current.add(job.id);
    setCommandPendingByJobId((state) => ({
      ...state,
      [job.id]: command,
    }));
    setApiPending(true);
    try {
      const { action, apiPath, dagSteps, dataset, job: updatedJob, run } = apiConfig.useMock
        ? await runMockJobCommand(job, command)
        : await runLiveJobCommand(job, command);
      writeAuditLog(action, apiPath, job.id);
      let normalizedUpdatedJob: JobRowData | undefined;
      if (updatedJob) {
        const nextJob = normalizeJobRow(updatedJob);
        normalizedUpdatedJob = nextJob;
        updateJobState(job.id, () => nextJob);
        setJobListFacets((facets) => moveJobFacetCounts(facets, previousJob, nextJob));
      }
      if (run) {
        setRunsByJobId((state) => ({
          ...state,
          [job.id]: tempRunId ? replaceTempRunByRunId(state[job.id] ?? [], tempRunId, run) : upsertRunByRunId(state[job.id] ?? [], run),
        }));
        setSelectedRunIdByJobId((state) => ({
          ...state,
          [job.id]: run.runId,
        }));
        setDagStepsByRunId((state) => {
          const rest = withoutRecordKey(state, tempRunId);
          return dagSteps
            ? {
                ...rest,
                [run.runId]: dagSteps,
              }
            : rest;
        });
      } else if (tempRunId) {
        rollbackOptimisticRun();
        showToast("실행 응답에 Run 정보가 없어 상태를 되돌렸습니다.", "info");
        return undefined;
      }
      if (dataset) {
        const normalizedDataset = normalizeDatasetRow(dataset);
        saveStoredCatalogDataset(normalizedDataset);
        setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
        setSelectedDataset(normalizedDataset);
      }
      showToast(commandSuccessMessage(command, job));
      return normalizedUpdatedJob;
    } catch (error) {
      if (tempRunId) {
        rollbackOptimisticRun();
      }
      writeAuditLog("etl.job.command_failed", `/api/etl/jobs/${job.id}`, job.id, "failed");
      showToast(commandFailureMessage(error, command), "info");
    } finally {
      commandPendingRef.current.delete(job.id);
      setCommandPendingByJobId((state) => {
        const { [job.id]: _pendingCommand, ...rest } = state;
        return rest;
      });
      setApiPending(false);
    }
  };

  const openJobDetail = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.detail_opened", `/api/etl/jobs/${job.id}`, job.id);
    onFlowChange("jobDetail");
  };

  const openJobRuns = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.runs_opened", `/api/etl/jobs/${job.id}/runs`, job.id);
    onFlowChange("jobRuns");
  };

  const openDataset = (dataset: CatalogDataset) => {
    setSelectedDataset(dataset);
    writeAuditLog("catalog.dataset.opened", `/api/catalog/datasets/${dataset.id}`, dataset.id);
    onFlowChange("catalogDetail");
  };

  const openDatasetInSql = (dataset: CatalogDataset) => {
    setSelectedDataset(dataset);
    setSqlResultDraft(null);
    writeAuditLog("catalog.open_in_sql.clicked", `/api/catalog/datasets/${dataset.id}/query`, dataset.id, "success", { targetType: "dataset" });
    onFlowChange("sql");
  };

  return {
    apiPending,
    commandPendingByJobId,
    createPipeline,
    dataError,
    dataLoading,
    datasets,
    draftPipeline,
    handleJobCommand,
    dagStepsByRunId,
    jobExecutionEvidence,
    jobListFacets,
    jobsLoading,
    jobs,
    openDataset,
    openDatasetInSql,
    openJobDetail,
    openJobRuns,
    filterJobs,
    prepareSqlDatasetJobDraft,
    deleteMaterializationRun,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    selectRunForJob,
    setSelectedDataset,
    setSelectedJob,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  };
}
