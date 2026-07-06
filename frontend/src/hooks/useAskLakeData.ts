import { useEffect, useMemo, useRef, useState } from "react";
import { applyDraftPipelinePatch } from "../services/draftPipelineContract";
import { apiClient } from "../services/apiClient";
import { createPipelineDraft, runJobCommand } from "../services/pipelineApi";
import { normalizeDatasetStatus, normalizeJobStatus } from "../utils/statusMeta";
import type { AuditResult, AuditTargetType, CatalogDataset, DagStepsByRunId, DraftPipeline, DraftPipelinePatch, FlowId, JobCommand, JobExecutionEvidence, JobRowData, JobRunSummary, RunsByJobId, SelectedRunIdByJobId, SqlResultDraft } from "../types";

type WriteAuditLog = (action: string, apiPath: string, targetId: string, result?: AuditResult, options?: { targetType?: AuditTargetType }) => void;

type JobRunStateMaps = {
  dagStepsByRunId: DagStepsByRunId;
  runsByJobId: RunsByJobId;
  selectedRunIdByJobId: SelectedRunIdByJobId;
};

type ServerJobCommand = Exclude<JobCommand, "edit" | "delete">;
type CommandPendingByJobId = Partial<Record<string, ServerJobCommand>>;

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
  const [jobs, setJobs] = useState<JobRowData[]>([]);
  const [datasets, setDatasets] = useState<CatalogDataset[]>([]);
  const [draftPipeline, setDraftPipeline] = useState<DraftPipeline>(initialDraftPipeline);
  const [selectedDataset, setSelectedDataset] = useState<CatalogDataset>(emptySelectedDataset);
  const [selectedJob, setSelectedJob] = useState<JobRowData>(emptySelectedJob);
  const [runsByJobId, setRunsByJobId] = useState<RunsByJobId>({});
  const [selectedRunIdByJobId, setSelectedRunIdByJobId] = useState<SelectedRunIdByJobId>({});
  const [dagStepsByRunId, setDagStepsByRunId] = useState<DagStepsByRunId>({});
  const [commandPendingByJobId, setCommandPendingByJobId] = useState<CommandPendingByJobId>({});
  const [sqlResultDraft, setSqlResultDraft] = useState<SqlResultDraft | null>(null);
  const [apiPending, setApiPending] = useState(false);
  const createPendingRef = useRef(false);
  const commandPendingRef = useRef<Set<string>>(new Set());

  const jobExecutionEvidence = useMemo(
    () => buildJobExecutionEvidence(runsByJobId, selectedRunIdByJobId, dagStepsByRunId),
    [dagStepsByRunId, runsByJobId, selectedRunIdByJobId],
  );

  useEffect(() => {
    let cancelled = false;
    setApiPending(true);
    Promise.all([
      apiClient.get<JobRowData[]>("/api/etl/jobs"),
      apiClient.get<CatalogDataset[]>("/api/catalog/datasets"),
    ])
      .then(([nextJobs, nextDatasets]) => {
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
      })
      .catch(() => {
        if (!cancelled) showToast("백엔드 초기 데이터를 불러오지 못했습니다.", "info");
      })
      .finally(() => {
        if (!cancelled) setApiPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateDraftPipeline = (patch: DraftPipelinePatch) => {
    setDraftPipeline((draft) => applyDraftPipelinePatch(draft, patch));
  };

  const createPipeline = async () => {
    if (createPendingRef.current) {
      return;
    }

    const previousState = {
      jobs,
      selectedJob,
    };
    createPendingRef.current = true;
    setApiPending(true);
    try {
      const { job } = await createPipelineDraft(draftPipeline);
      const normalizedJob = normalizeJobRow(job);
      setJobs((items) => [normalizedJob, ...items.filter((item) => item.name !== normalizedJob.name)]);
      setSelectedJob(normalizedJob);
      writeAuditLog("etl.job.created", "/api/etl/jobs", draftPipeline.id);
      writeAuditLog("etl.run.queued", `/api/etl/jobs/${draftPipeline.id}/runs`, draftPipeline.id);
      showToast("파이프라인 생성 요청을 접수했습니다. 실행 성공 후 카탈로그에 등록됩니다.");
      setDraftPipeline(initialDraftPipeline);
      onFlowChange("jobs");
    } catch {
      setJobs(previousState.jobs);
      setSelectedJob(previousState.selectedJob);
      writeAuditLog("etl.job.create_failed", "/api/etl/jobs", draftPipeline.id, "failed");
      showToast("파이프라인 생성 요청에 실패했습니다.", "info");
    } finally {
      createPendingRef.current = false;
      setApiPending(false);
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
      const { action, apiPath, dagSteps, dataset, job: updatedJob, run } = await runJobCommand(job, command);
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
    writeAuditLog("catalog.open_in_sql.clicked", `/api/catalog/datasets/${dataset.id}/query`, dataset.id, "success", { targetType: "dataset" });
    onFlowChange("sql");
  };

  return {
    apiPending,
    commandPendingByJobId,
    createPipeline,
    datasets,
    draftPipeline,
    handleJobCommand,
    dagStepsByRunId,
    jobExecutionEvidence,
    jobs,
    openJobDag,
    openDataset,
    openDatasetInSql,
    openJobDetail,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    selectRunForJob,
    setSelectedDataset,
    setSqlResultDraft,
    sqlResultDraft,
    runsByJobId,
    updateDraftPipeline,
  };
}
