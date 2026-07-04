import type { CatalogDataset, CreatePipelineRequest, DraftPipeline, JobCommand, JobRowData, SqlResultDraft } from "../types";
import { toCreatePipelineRequest } from "./draftPipelineContract";
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

function validRequestSchemaColumns(request: CreatePipelineRequest) {
  return request.schemaColumns
    .map((column, sourceIndex) => ({ column, sourceIndex }))
    .filter(({ column }) => column.targetName.trim());
}

function datasetSchemaFromRequest(request: CreatePipelineRequest): CatalogDataset["schema"] {
  const columns = validRequestSchemaColumns(request);
  return columns.map(({ column }) => [column.targetName, column.type.toLowerCase()] as [string, string]);
}

function datasetSampleRowsFromRequest(request: CreatePipelineRequest, schema: CatalogDataset["schema"]): string[][] {
  if (request.schemaSampleRows.length === 0) {
    return [];
  }

  const columns = validRequestSchemaColumns(request);
  if (columns.length === 0) {
    return request.schemaSampleRows.map((row) => schema.map((_, index) => row[index] ?? "-"));
  }

  return request.schemaSampleRows.map((row) => columns.map(({ sourceIndex }) => row[sourceIndex] ?? "-"));
}

export async function createPipelineDraft(draftPipeline: DraftPipeline, jobCount: number): Promise<PipelineCreationResult> {
  const request = toCreatePipelineRequest(draftPipeline);
  if (!apiConfig.useMock) {
    return apiClient.post<PipelineCreationResult>("/api/etl/jobs", request);
  }
  const datasetSchema = datasetSchemaFromRequest(request);
  const datasetSampleRows = datasetSampleRowsFromRequest(request, datasetSchema);

  const job: JobRowData = {
    status: "스케줄됨",
    name: request.jobName,
    id: `JOB-${String(jobCount + 1).padStart(3, "0")}`,
    owner: request.owner,
    tag: "[리뷰]",
    source: `${request.sourceType} / ${request.sourceLabel}`,
    target: request.targetDataset,
    schedule: request.scheduleLabel,
    lastRun: "생성됨",
    lastState: "대기 중",
    nextRun: request.scheduleLabel === "수동 실행" ? "-" : "다음 예약 대기",
  };

  const dataset: CatalogDataset = {
    description: "생성 플로우에서 만든 고객 리뷰 분석용 데이터셋",
    downstream: ["SQL 분석", "대시보드", request.rag ? "AI 활용" : "카탈로그"],
    freshness: "latest",
    id: `ds_${request.targetDataset}`,
    layer: request.targetLayer,
    lastUpdated: "방금 생성됨",
    name: request.targetDataset,
    nextRefresh: request.scheduleLabel,
    owner: request.owner,
    quality: "95% (Draft verified)",
    rag: request.rag,
    rows: "0 rows",
    sampleRows: datasetSampleRows,
    schema: datasetSchema,
    size: "Pending",
    source: request.jobName,
    status: "사용 가능",
    tags: ["#customer", "#RAG", "#리뷰"],
    upstream: [request.sourceLabel, request.jobName],
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
