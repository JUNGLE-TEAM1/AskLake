import { useEffect, useState } from "react";
import { createPipelineDraft, getDatasets, getJobs, getMockDatasets, getMockJobs, runJobCommand } from "../services/mockApi";
import type { AuditResult, AuditTargetType, CatalogDataset, DraftPipeline, FlowId, JobCommand, JobExecutionEvidence, JobRowData, SqlResultDraft } from "../types";

type WriteAuditLog = (action: string, apiPath: string, targetId: string, result?: AuditResult, options?: { targetType?: AuditTargetType }) => void;

const initialDraftPipeline: DraftPipeline = {
  id: "customer_review_gold",
  jobName: "customer_review_gold_pipeline",
  sourceConfig: [
    ["Storage Provider", "Amazon S3"],
    ["Bucket / Stage Name", "asklake-raw-ingest-us-east"],
    ["Path / Prefix", "data/inventory/daily/"],
  ],
  sourceType: "File / S3",
  sourceLabel: "S3 Raw reviews",
  schemaSummary: "24 fields inferred · 3 need review",
  ruleSummary: "5 quality rules · quarantine invalid rows",
  scheduleLabel: "매주 목요일 10:30",
  permissionSummary: "Data Engineer Group · 조직 내부",
  targetDataset: "customer_review_gold",
  targetLayer: "GOLD",
  targetFormat: "Parquet",
  owner: "data-team-01",
  rag: true,
};

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
  const [selectedDataset, setSelectedDataset] = useState<CatalogDataset | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobRowData | null>(null);
  const [jobExecutionEvidence, setJobExecutionEvidence] = useState<Record<string, JobExecutionEvidence>>({});
  const [sqlResultDraft, setSqlResultDraft] = useState<SqlResultDraft | null>(null);
  const [apiPending, setApiPending] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataFallbackReason, setDataFallbackReason] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;

    async function hydrateData() {
      setDataLoading(true);
      setDataError(null);
      try {
        const [nextJobs, nextDatasets] = await Promise.all([getJobs(), getDatasets()]);
        if (canceled) return;
        setJobs(nextJobs);
        setDatasets(nextDatasets);
        setSelectedJob((job) => job ?? nextJobs[1] ?? nextJobs[0] ?? null);
        setSelectedDataset((dataset) => dataset ?? nextDatasets[0] ?? null);
        setDataFallbackReason(null);
      } catch (error) {
        if (canceled) return;
        const message = error instanceof Error ? error.message : "Failed to load AskLake data.";
        try {
          const [fallbackJobs, fallbackDatasets] = await Promise.all([getMockJobs(), getMockDatasets()]);
          if (canceled) return;
          setJobs(fallbackJobs);
          setDatasets(fallbackDatasets);
          setSelectedJob((job) => job ?? fallbackJobs[1] ?? fallbackJobs[0] ?? null);
          setSelectedDataset((dataset) => dataset ?? fallbackDatasets[0] ?? null);
          setDataError(null);
          setDataFallbackReason(message);
          writeAuditLog("data.hydrate.fallback_used", "/api/bootstrap", "mock-data", "success", { targetType: "ui" });
        } catch (fallbackError) {
          if (canceled) return;
          setDataError(fallbackError instanceof Error ? fallbackError.message : message);
        }
        showToast("DB API 연결 실패로 mock fallback 데이터를 사용합니다.", "info");
      } finally {
        if (!canceled) setDataLoading(false);
      }
    }

    void hydrateData();

    return () => {
      canceled = true;
    };
  }, []);

  const updateDraftPipeline = (patch: Partial<DraftPipeline>) => {
    setDraftPipeline((draft) => ({ ...draft, ...patch }));
  };

  const createPipeline = async () => {
    setApiPending(true);
    try {
      const { dataset, job } = await createPipelineDraft(draftPipeline, jobs.length);
      setJobs((items) => [job, ...items.filter((item) => item.name !== job.name)]);
      setDatasets((items) => [dataset, ...items.filter((item) => item.id !== dataset.id)]);
      setSelectedJob(job);
      setSelectedDataset(dataset);
      writeAuditLog("etl.job.created", "/api/etl/jobs", draftPipeline.id);
      writeAuditLog("etl.run.queued", `/api/etl/jobs/${draftPipeline.id}/runs`, draftPipeline.id);
      showToast("파이프라인 생성 요청이 접수되었습니다.");
      onFlowChange("jobs");
    } catch {
      writeAuditLog("etl.job.create_failed", "/api/etl/jobs", draftPipeline.id, "failed");
      showToast("파이프라인 생성 요청에 실패했습니다.", "info");
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
      setSelectedJob(remaining[0] ?? null);
      onFlowChange("jobs");
      return;
    }

    setApiPending(true);
    try {
      const { action, apiPath, dagSteps, job: updatedJob, run } = await runJobCommand(job, command);
      writeAuditLog(action, apiPath, job.id);
      if (updatedJob) updateJobState(job.id, () => updatedJob);
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
    dataError,
    dataFallbackReason,
    dataLoading,
    datasets,
    draftPipeline,
    handleJobCommand,
    jobExecutionEvidence,
    jobs,
    openDataset,
    openDatasetInSql,
    openJobDetail,
    selectedDataset,
    selectedJob,
    setSelectedDataset,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  };
}
