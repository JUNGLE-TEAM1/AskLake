import { useEffect, useRef, useState } from "react";
import { catalogDatasets, etlJobs } from "../data/mockData";
import { apiConfig } from "../services/apiClient";
import { applyDraftPipelinePatch } from "../services/draftPipelineContract";
import {
  createDerivedDatasetFromSql,
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
  DraftPipeline,
  DraftPipelinePatch,
  FlowId,
  JobCommand,
  JobExecutionEvidence,
  JobRowData,
  SqlResultDraft,
} from "../types";

type WriteAuditLog = (action: string, apiPath: string, targetId: string, result?: AuditResult, options?: { targetType?: AuditTargetType }) => void;

const catalogDatasetStorageKey = "asklake.catalogDatasets";
const legacyDerivedDatasetStorageKey = "asklake.derivedDatasets";
const maxStoredCatalogDatasets = 30;

const initialDraftPipeline: DraftPipeline = {
  id: "pair_a_customer_review_gold",
  permission: {
    owner: "data-team-01",
    summary: "Data Engineer Group · 조직 내부",
  },
  quality: {
    invalidRows: [],
    rules: [],
    score: 94.2,
    status: "pass",
    summary: "품질 규칙 5개 · 유효하지 않은 행 격리",
  },
  schedule: {
    label: "매주 목요일 10:30",
    mode: "repeat",
    nextRun: "다음 예약 대기",
    retryPolicy: {
      failureAction: "retry_then_fail",
      maxRetries: 3,
      retryIntervalMinutes: 10,
      timeoutMinutes: 60,
    },
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
      ["Storage Provider", "S3 Compatible"],
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
    datasetName: "pair_a_customer_review_gold",
    format: "Parquet",
    layer: "GOLD",
    rag: true,
  },
  transform: {
    outputColumns: [],
    steps: [],
    summary: "품질 규칙 5개 · 유효하지 않은 행 격리",
  },
};

const emptySelectedDataset: CatalogDataset = {
  description: "생성된 데이터셋이 없습니다. 수집/처리에서 파이프라인을 먼저 생성하세요.",
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
  rows: "0 rows",
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

function nextSelectedJob(currentJob: JobRowData | null, jobs: JobRowData[]) {
  if (currentJob && jobs.some((job) => job.id === currentJob.id)) return currentJob;
  return jobs[0] ?? emptySelectedJob;
}

function nextSelectedDataset(currentDataset: CatalogDataset | null, datasets: CatalogDataset[]) {
  if (currentDataset && datasets.some((dataset) => dataset.id === currentDataset.id)) return currentDataset;
  return datasets[0] ?? emptySelectedDataset;
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
  const [selectedDataset, setSelectedDataset] = useState<CatalogDataset | null>(() => getInitialDatasets()[0] ?? emptySelectedDataset);
  const [selectedJob, setSelectedJob] = useState<JobRowData | null>(() => getInitialJobs()[0] ?? emptySelectedJob);
  const [jobExecutionEvidence, setJobExecutionEvidence] = useState<Record<string, JobExecutionEvidence>>({});
  const [sqlResultDraft, setSqlResultDraft] = useState<SqlResultDraft | null>(null);
  const [apiPending, setApiPending] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const createPendingRef = useRef(false);

  useEffect(() => {
    if (apiConfig.useMock) {
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
        setJobs(normalizedJobs);
        setDatasets(normalizedDatasets);
        setSelectedJob((job) => nextSelectedJob(job, normalizedJobs));
        setSelectedDataset((dataset) => nextSelectedDataset(dataset, normalizedDatasets));
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
      const { dataset, job } = apiConfig.useMock
        ? await createMockPipelineDraft(draftPipeline, jobs.length)
        : await createLivePipelineDraft(draftPipeline);
      const normalizedJob = normalizeJobRow(job);
      const normalizedDataset = normalizeDatasetRow(dataset);
      saveStoredCatalogDataset(normalizedDataset);
      setJobs((items) => [normalizedJob, ...items.filter((item) => item.name !== normalizedJob.name)]);
      setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
      setSelectedJob(normalizedJob);
      setSelectedDataset(normalizedDataset);
      writeAuditLog("etl.job.created", "/api/etl/jobs", draftPipeline.id);
      writeAuditLog("etl.run.queued", `/api/etl/jobs/${draftPipeline.id}/runs`, draftPipeline.id);
      showToast("파이프라인 생성 요청이 접수되었습니다.");
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

  const createSqlDerivedDataset = async (request: CreateDerivedDatasetRequest) => {
    setApiPending(true);
    try {
      const sourceDataset = datasets.find((item) => item.id === request.sourceDatasetId);
      const currentSqlResult = sqlResultDraft?.runId === request.sourceRunId ? sqlResultDraft : null;

      if (!sourceDataset || !currentSqlResult) {
        writeAuditLog("analysis.derived_dataset.create_failed", "/api/catalog/derived-datasets", request.sourceDatasetId, "failed");
        showToast("Lake Dataset 생성에 필요한 Preview 결과를 찾지 못했습니다.", "info");
        return null;
      }

      const dataset = normalizeDatasetRow(await createDerivedDatasetFromSql({ request, sourceDataset, sqlResult: currentSqlResult }));
      saveStoredCatalogDataset(dataset);
      setDatasets((items) => [dataset, ...items.filter((item) => item.id !== dataset.id)]);
      setSelectedDataset(dataset);
      writeAuditLog("analysis.derived_dataset.created", "/api/catalog/derived-datasets", dataset.id);
      showToast("SQL 결과 기반 Lake Dataset이 생성되었습니다.");
      return dataset;
    } catch {
      writeAuditLog("analysis.derived_dataset.create_failed", "/api/catalog/derived-datasets", request.sourceDatasetId, "failed");
      showToast("Lake Dataset 생성에 실패했습니다.", "info");
      return null;
    } finally {
      setApiPending(false);
    }
  };

  const updateJobState = (jobId: string, updater: (job: JobRowData) => JobRowData) => {
    setJobs((items) => items.map((job) => (job.id === jobId ? updater(job) : job)));
    setSelectedJob((job) => (job?.id === jobId ? updater(job) : job));
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
      setJobs(remaining);
      setSelectedJob(remaining[0] ?? emptySelectedJob);
      onFlowChange("jobs");
      return;
    }

    setApiPending(true);
    try {
      const { action, apiPath, dagSteps, job: updatedJob, run } = apiConfig.useMock
        ? await runMockJobCommand(job, command)
        : await runLiveJobCommand(job, command);
      writeAuditLog(action, apiPath, job.id);
      if (updatedJob) updateJobState(job.id, () => normalizeJobRow(updatedJob));
      if (run || dagSteps) {
        setJobExecutionEvidence((evidence) => {
          const previous = evidence[job.id] ?? { dagSteps: [], runs: [] };
          return {
            ...evidence,
            [job.id]: {
              dagSteps: dagSteps ?? previous.dagSteps,
              runs: run ? [run, ...previous.runs.filter((item) => item.runId !== run.runId)] : previous.runs,
            },
          };
        });
      }
    } catch {
      writeAuditLog("etl.job.command_failed", `/api/etl/jobs/${job.id}`, job.id, "failed");
      showToast("작업 명령 처리에 실패했습니다.", "info");
    } finally {
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
    writeAuditLog("catalog.open_in_sql.clicked", `/api/catalog/datasets/${dataset.id}/query`, dataset.id, "success", { targetType: "dataset" });
    onFlowChange("sql");
  };

  return {
    apiPending,
    createPipeline,
    createSqlDerivedDataset,
    dataError,
    dataLoading,
    datasets,
    draftPipeline,
    handleJobCommand,
    jobExecutionEvidence,
    jobs,
    openDataset,
    openDatasetInSql,
    openJobDetail,
    openJobRuns,
    selectedDataset,
    selectedJob,
    setSelectedDataset,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  };
}
