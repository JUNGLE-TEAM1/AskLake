import { useEffect, useMemo, useRef, useState } from "react";
import { catalogDatasets, etlJobs } from "../data/mockData";
import { apiConfig } from "../services/apiClient";
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
  JobRowData,
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

const initialDraftPipeline: DraftPipeline = {
  id: "pair_a_customer_review_gold",
  permission: {
    owner: "data-team-01",
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
      failureAction: "retry_then_fail",
      maxRetries: 3,
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
    sourceConfig: [
      ["Storage Provider", "MinIO"],
      ["Endpoint URL", "http://127.0.0.1:9000"],
      ["Region", "us-east-1"],
      ["Bucket / Stage Name", "m3-raw"],
      ["Path / Prefix", "nyc_taxi/csv/"],
      ["Access Key", ""],
      ["Secret Key", ""],
      ["Use Path Style", "true"],
    ],
    sourceLabel: "m3-raw",
    sourceType: "File / S3",
  },
  target: {
    compression: "Snappy",
    datasetName: "pair_a_customer_review_gold",
    format: "Parquet",
    layer: "GOLD",
    partition: "year/month/region",
    rag: true,
    storagePath: "s3a://asklake-output/pair_a_customer_review_gold/gold/",
    storageType: "S3",
  },
  transform: {
    outputColumns: [],
    steps: [],
    summary: "변환 규칙과 품질 검사를 설정하세요.",
  },
};

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

  return [
    ...uniqueStoredDatasets,
    ...baseDatasets.filter((dataset) => !storedDatasetIds.has(dataset.id)),
  ].map(normalizeDatasetRow);
}

function saveStoredCatalogDataset(dataset: CatalogDataset) {
  if (!apiConfig.useMock || typeof window === "undefined") return;

  const previousDatasets = loadStoredCatalogDatasets();
  const nextDatasets = [dataset, ...previousDatasets.filter((item) => item.id !== dataset.id)]
    .slice(0, maxStoredCatalogDatasets);

  window.localStorage.setItem(catalogDatasetStorageKey, JSON.stringify(nextDatasets));
}

function getInitialDatasets() {
  return apiConfig.useMock ? mergeCatalogDatasets(catalogDatasets, loadStoredCatalogDatasets()) : [];
}

function getInitialJobs() {
  return apiConfig.useMock ? etlJobs.map(normalizeJobRow) : [];
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
  return {
    ...job,
    status: normalizeJobStatus(String(job.status)),
  };
}

function normalizeDatasetRow(dataset: CatalogDataset): CatalogDataset {
  return {
    ...dataset,
    status: normalizeDatasetStatus(String(dataset.status)),
  };
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

function isOptimisticRunCommand(command: JobCommand): command is "run" | "retry" {
  return command === "run" || command === "retry";
}

function commandSuccessMessage(command: ServerJobCommand): string {
  if (command === "run") return "작업 실행 요청을 접수했습니다.";
  if (command === "retry") return "작업 재실행 요청을 접수했습니다.";
  if (command === "pause") return "작업 일시정지 요청을 접수했습니다.";
  return "작업 취소 요청을 접수했습니다.";
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
  onFlowChange,
  showToast,
  writeAuditLog,
}: {
  onFlowChange: (flow: FlowId) => void;
  showToast: (message: string, tone?: "success" | "info") => void;
  writeAuditLog: WriteAuditLog;
}) {
  const [jobs, setJobs] = useState<JobRowData[]>(getInitialJobs);
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
  const [dataLoading, setDataLoading] = useState(!apiConfig.useMock);
  const [dataError, setDataError] = useState<string | null>(null);
  const createPendingRef = useRef(false);
  const commandPendingRef = useRef<Set<string>>(new Set());

  const jobExecutionEvidence = useMemo(
    () => buildJobExecutionEvidence(runsByJobId, selectedRunIdByJobId, dagStepsByRunId),
    [dagStepsByRunId, runsByJobId, selectedRunIdByJobId],
  );

  useEffect(() => {
    if (apiConfig.useMock) {
      const hydratedRunState = buildRunStateFromJobs(getInitialJobs());
      setRunsByJobId(hydratedRunState.runsByJobId);
      setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
      setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
      setDataLoading(false);
      setDataError(null);
      return;
    }

    let cancelled = false;

    async function hydrateData() {
      setDataLoading(true);
      setDataError(null);
      try {
        const [nextJobs, nextDatasets] = await Promise.all([getJobs(), getDatasets()]);
        if (cancelled) return;
        const normalizedJobs = nextJobs.map(normalizeJobRow);
        const normalizedDatasets = nextDatasets.map(normalizeDatasetRow);
        const hydratedRunState = buildRunStateFromJobs(normalizedJobs);
        setJobs(normalizedJobs);
        setDatasets(normalizedDatasets);
        setSelectedJob(normalizedJobs[0] ?? emptySelectedJob);
        setSelectedDataset(normalizedDatasets[0] ?? emptySelectedDataset);
        setRunsByJobId(hydratedRunState.runsByJobId);
        setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
        setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
      } catch (error) {
        if (cancelled) return;
        setDataError(error instanceof Error ? error.message : "Failed to load AskLake data.");
        showToast("DB API에서 초기 데이터를 불러오지 못했습니다.", "info");
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    }

    void hydrateData();

    return () => {
      cancelled = true;
    };
  }, []);

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

      setJobs((items) => [normalizedJob, ...items.filter((item) => item.name !== normalizedJob.name)]);
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
    } catch {
      setJobs(previousState.jobs);
      setDatasets(previousState.datasets);
      setSelectedJob(previousState.selectedJob);
      setSelectedDataset(previousState.selectedDataset);
      writeAuditLog("etl.job.create_failed", "/api/etl/jobs", draftPipeline.id, "failed");
      showToast("파이프라인 생성 요청에 실패했습니다.", "info");
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

  const handleJobCommand = async (job: JobRowData, command: JobCommand) => {
    if (command === "edit") {
      writeAuditLog("etl.job.edit_opened", `/api/etl/jobs/${job.id}`, job.id);
      setSelectedJob(job);
      onFlowChange("source");
      return;
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
      return;
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
      if (updatedJob) updateJobState(job.id, () => normalizeJobRow(updatedJob));
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
        return;
      }
      if (dataset) {
        const normalizedDataset = normalizeDatasetRow(dataset);
        saveStoredCatalogDataset(normalizedDataset);
        setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
        setSelectedDataset(normalizedDataset);
      }
      showToast(commandSuccessMessage(command));
    } catch {
      if (tempRunId) {
        rollbackOptimisticRun();
      }
      writeAuditLog("etl.job.command_failed", `/api/etl/jobs/${job.id}`, job.id, "failed");
      showToast("작업 명령 처리에 실패했습니다.", "info");
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

  const openJobDag = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.dag_opened", `/api/etl/jobs/${job.id}/dag`, job.id);
    onFlowChange("jobDag");
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
    jobs,
    openDataset,
    openDatasetInSql,
    openJobDag,
    openJobDetail,
    prepareSqlDatasetJobDraft,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    selectRunForJob,
    setSelectedDataset,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  };
}
