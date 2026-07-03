import type { CatalogDataset, DraftPipeline, JobCommand, JobRowData, SqlResultDraft } from "../types";
import { apiClient, apiConfig } from "./apiClient";

export type PipelineCreationResult = {
  dataset: CatalogDataset;
  job: JobRowData;
};

export type JobCommandResult = {
  action: string;
  apiPath: string;
  job?: JobRowData;
};

const mockLatencyMs = 120;

async function resolveMock<T>(payload: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, mockLatencyMs));
  return payload;
}

export async function createPipelineDraft(draftPipeline: DraftPipeline, jobCount: number): Promise<PipelineCreationResult> {
  if (!apiConfig.useMock) {
    return apiClient.post<PipelineCreationResult>("/api/etl/jobs", draftPipeline);
  }

  const job: JobRowData = {
    status: "스케줄됨",
    name: draftPipeline.jobName,
    id: `JOB-${String(jobCount + 1).padStart(3, "0")}`,
    owner: draftPipeline.owner,
    tag: "[리뷰]",
    source: `${draftPipeline.sourceType} / ${draftPipeline.sourceLabel}`,
    target: draftPipeline.targetDataset,
    schedule: draftPipeline.scheduleLabel,
    lastRun: "생성됨",
    lastState: "대기 중",
    nextRun: draftPipeline.scheduleLabel === "수동 실행" ? "-" : "다음 예약 대기",
  };

  const dataset: CatalogDataset = {
    description: "생성 플로우에서 만든 고객 리뷰 분석용 데이터셋",
    downstream: ["SQL 분석", "대시보드", draftPipeline.rag ? "AI 활용" : "카탈로그"],
    freshness: "latest",
    id: `ds_${draftPipeline.targetDataset}`,
    layer: draftPipeline.targetLayer,
    lastUpdated: "방금 생성됨",
    name: draftPipeline.targetDataset,
    nextRefresh: draftPipeline.scheduleLabel,
    owner: draftPipeline.owner,
    quality: "95% (Draft verified)",
    rag: draftPipeline.rag,
    rows: "0 rows",
    sampleRows: [["-", "-", "-", "-", "Pipeline queued"]],
    schema: [["review_id", "bigint"], ["product_id", "string"], ["rating", "int"], ["review_text", "string"], ["sentiment", "string"]],
    size: "Pending",
    source: draftPipeline.jobName,
    status: "사용 가능",
    tags: ["#customer", "#RAG", "#리뷰"],
    upstream: [draftPipeline.sourceLabel, draftPipeline.jobName],
  };

  return resolveMock({ dataset, job });
}

export async function runJobCommand(job: JobRowData, command: Exclude<JobCommand, "edit" | "delete">): Promise<JobCommandResult> {
  if (!apiConfig.useMock) {
    return apiClient.post<JobCommandResult>(`/api/etl/jobs/${job.id}/commands`, { command });
  }

  const actionByCommand: Record<Exclude<JobCommand, "edit" | "delete">, { action: string; apiPath: string }> = {
    run: { action: "etl.run.requested", apiPath: `/api/etl/jobs/${job.id}/runs` },
    retry: { action: "etl.run.retry_requested", apiPath: `/api/etl/jobs/${job.id}/runs` },
    pause: { action: "etl.job.pause_requested", apiPath: `/api/etl/jobs/${job.id}` },
    cancel: { action: "etl.run.cancel_requested", apiPath: `/api/etl/jobs/${job.id}/runs/current/cancel` },
  };
  const audit = actionByCommand[command];

  if (command === "run" || command === "retry") {
    return resolveMock({
      ...audit,
      job: {
        ...job,
        status: "실행 중",
        lastRun: "현재 실행 중",
        lastState: command === "retry" ? "재실행 중 · Source 연결" : "1/8 단계 · Source 연결",
        nextRun: "-",
        progress: { label: command === "retry" ? "재실행 중 · Source 연결" : "1/8 단계 · Source 연결", value: 12 },
      },
    });
  }

  if (command === "pause") {
    return resolveMock({
      ...audit,
      job: {
        ...job,
        status: "일시정지",
        lastState: "사용자 일시정지",
        nextRun: "재개 대기",
        progress: job.progress ?? { label: "일시정지됨", value: 50 },
      },
    });
  }

  return resolveMock({
    ...audit,
    job: {
      ...job,
      status: "스케줄됨",
      lastRun: "방금 취소",
      lastState: "취소됨",
      nextRun: job.schedule === "수동 실행" ? "-" : "다음 예약 대기",
      progress: undefined,
    },
  });
}

export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  if (!apiConfig.useMock) {
    return apiClient.post<SqlResultDraft>("/api/query/runs", { datasetId: dataset.id, query });
  }

  const columns = dataset.schema.slice(0, 6).map(([name]) => name);
  const rows = dataset.sampleRows.map((row) => row.slice(0, Math.max(columns.length, 1)));

  return resolveMock({
    columns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    executedAt: new Date().toISOString(),
    query,
    rowCount: rows.length,
    rows,
    runId: `sql_${Date.now()}`,
  });
}
