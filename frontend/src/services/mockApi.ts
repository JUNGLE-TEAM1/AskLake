import type { CatalogDataset, DraftPipeline, JobCommand, JobDagStep, JobRowData, JobRunSummary, LineageGraph, LineageGraphDataset, LineageLayer, SqlResultDraft } from "../types";
import { normalizeDatasetStatus, normalizeJobStatus } from "../utils/statusMeta";
import { apiClient, apiConfig } from "./apiClient";

export type PipelineCreationResult = {
  dataset: CatalogDataset;
  job: JobRowData;
};

export type JobCommandResult = {
  action: string;
  apiPath: string;
  dagSteps?: JobDagStep[];
  job?: JobRowData;
  run?: JobRunSummary;
};

const mockLatencyMs = 120;

function normalizeJob(job: JobRowData): JobRowData {
  return { ...job, status: normalizeJobStatus(job.status) };
}

function normalizeDataset(dataset: CatalogDataset): CatalogDataset {
  return { ...dataset, status: normalizeDatasetStatus(dataset.status) };
}

function normalizePipelineCreationResult(result: PipelineCreationResult): PipelineCreationResult {
  return {
    dataset: normalizeDataset(result.dataset),
    job: normalizeJob(result.job),
  };
}

function normalizeJobCommandResult(result: JobCommandResult): JobCommandResult {
  return result.job ? { ...result, job: normalizeJob(result.job) } : result;
}

async function resolveMock<T>(payload: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, mockLatencyMs));
  return payload;
}

export async function createPipelineDraft(draftPipeline: DraftPipeline, jobCount: number): Promise<PipelineCreationResult> {
  if (!apiConfig.useMock) {
    const result = await apiClient.post<PipelineCreationResult>("/api/etl/jobs", draftPipeline);
    return normalizePipelineCreationResult(result);
  }

  const job: JobRowData = {
    status: "scheduled",
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
    status: "available",
    tags: ["#customer", "#RAG", "#리뷰"],
    upstream: [draftPipeline.sourceLabel, draftPipeline.jobName],
  };

  return resolveMock({ dataset, job });
}

export async function getDatasetLineageGraph(dataset: CatalogDataset): Promise<LineageGraph> {
  if (!apiConfig.useMock) {
    return apiClient.get<LineageGraph>(`/api/catalog/datasets/${dataset.id}/lineage`);
  }

  return resolveMock(dataset.lineageGraph ?? buildFallbackLineageGraph(dataset));
}

export async function runJobCommand(job: JobRowData, command: Exclude<JobCommand, "edit" | "delete">): Promise<JobCommandResult> {
  if (!apiConfig.useMock) {
    const result = await apiClient.post<JobCommandResult>(`/api/etl/jobs/${job.id}/commands`, { command });
    return normalizeJobCommandResult(result);
  }

  const actionByCommand: Record<Exclude<JobCommand, "edit" | "delete">, { action: string; apiPath: string }> = {
    run: { action: "etl.run.requested", apiPath: `/api/etl/jobs/${job.id}/runs` },
    retry: { action: "etl.run.retry_requested", apiPath: `/api/etl/jobs/${job.id}/runs` },
    pause: { action: "etl.job.pause_requested", apiPath: `/api/etl/jobs/${job.id}` },
    cancel: { action: "etl.run.cancel_requested", apiPath: `/api/etl/jobs/${job.id}/runs/current/cancel` },
  };
  const audit = actionByCommand[command];
  const runId = `run_${Date.now()}`;

  if (command === "run" || command === "retry") {
    const run: JobRunSummary = {
      duration: "진행 중",
      endedAt: "-",
      errorSummary: "-",
      failedStage: "-",
      inputRows: "0",
      outputRows: "0",
      runId,
      startedAt: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
      status: "running",
    };
    const dagSteps: JobDagStep[] = [
      { id: "step-1", meta: job.source, status: "running", title: "1. Source 연결" },
      { id: "step-2", meta: "대기 중", status: "pending", title: "2. 파일 읽기" },
      { id: "step-3", meta: "대기 중", status: "pending", title: "3. Schema 매핑" },
      { id: "step-4", meta: "대기 중", status: "pending", title: "4. Transform Rule" },
      { id: "step-5", meta: "대기 중", status: "pending", title: "5. Validation" },
      { id: "step-6", meta: job.target, status: "pending", title: "6. Lake 적재" },
      { id: "step-7", meta: "row count / schema check", status: "pending", title: "7. 품질 체크" },
      { id: "step-8", meta: "SQL · Dashboard · Catalog", status: "pending", title: "8. Downstream 반영" },
    ];

    return resolveMock({
      ...audit,
      dagSteps,
      job: {
        ...job,
        status: "running",
        lastRun: "현재 실행 중",
        lastState: command === "retry" ? "재실행 중 · Source 연결" : "1/8 단계 · Source 연결",
        nextRun: "-",
        progress: { label: command === "retry" ? "재실행 중 · Source 연결" : "1/8 단계 · Source 연결", value: 12 },
      },
      run,
    });
  }

  if (command === "pause") {
    const run: JobRunSummary = {
      duration: "일시정지",
      endedAt: "-",
      errorSummary: "-",
      failedStage: "-",
      inputRows: "72,410",
      outputRows: "0",
      runId,
      startedAt: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
      status: "running",
    };
    const dagSteps: JobDagStep[] = [
      { id: "step-1", meta: job.source, status: "success", title: "1. Source 연결" },
      { id: "step-2", meta: "72,410 rows scanned", status: "success", title: "2. 파일 읽기" },
      { id: "step-3", meta: "사용자 일시정지", note: "resume 대기", status: "blocked", title: "3. Schema 매핑" },
      { id: "step-4", meta: "대기 중", status: "blocked", title: "4. Transform Rule" },
      { id: "step-5", meta: "대기 중", status: "blocked", title: "5. Validation" },
      { id: "step-6", meta: job.target, status: "blocked", title: "6. Lake 적재" },
      { id: "step-7", meta: "row count / schema check", status: "blocked", title: "7. 품질 체크" },
      { id: "step-8", meta: "SQL · Dashboard · Catalog", status: "blocked", title: "8. Downstream 반영" },
    ];

    return resolveMock({
      ...audit,
      dagSteps,
      job: {
        ...job,
        status: "paused",
        lastState: "사용자 일시정지",
        nextRun: "재개 대기",
        progress: job.progress ?? { label: "일시정지됨", value: 50 },
      },
      run,
    });
  }

  const run: JobRunSummary = {
    duration: "취소됨",
    endedAt: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
    errorSummary: "사용자 요청으로 취소",
    failedStage: "-",
    inputRows: "72,410",
    outputRows: "0",
    runId,
    startedAt: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
    status: "canceled",
  };
  const dagSteps: JobDagStep[] = [
    { id: "step-1", meta: job.source, status: "success", title: "1. Source 연결" },
    { id: "step-2", meta: "72,410 rows scanned", status: "success", title: "2. 파일 읽기" },
    { id: "step-3", meta: "사용자 취소", note: "cancel requested", status: "blocked", title: "3. Schema 매핑" },
    { id: "step-4", meta: "취소 이후 중단", status: "blocked", title: "4. Transform Rule" },
    { id: "step-5", meta: "취소 이후 중단", status: "blocked", title: "5. Validation" },
    { id: "step-6", meta: job.target, status: "blocked", title: "6. Lake 적재" },
    { id: "step-7", meta: "row count / schema check", status: "blocked", title: "7. 품질 체크" },
    { id: "step-8", meta: "SQL · Dashboard · Catalog", status: "blocked", title: "8. Downstream 반영" },
  ];

  return resolveMock({
    ...audit,
    dagSteps,
    job: {
      ...job,
      status: "canceled",
      lastRun: "방금 취소",
      lastState: "취소됨",
      nextRun: job.schedule === "수동 실행" ? "-" : "다음 예약 대기",
      progress: undefined,
    },
    run,
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

function buildFallbackLineageGraph(dataset: CatalogDataset): LineageGraph {
  const currentNode: LineageGraphDataset = {
    columns: dataset.schema.map(([name, type]) => ({ id: normalizeLineageId(name), name, type })),
    engine: "ICEBERG",
    id: dataset.id,
    layer: dataset.layer,
    name: dataset.name,
  };
  const upstreamNodes = dataset.upstream.map((item, index): LineageGraphDataset => {
    const layer = inferLineageLayer(item, dataset.layer, index);
    return {
      columns: currentNode.columns.map((column) => ({
        ...column,
        id: normalizeLineageId(`${index}-${column.name}`),
        name: layer === "SOURCE" && index > 0 ? column.name.replace(/^order_/, "").replace(/^customer_/, "user_") : column.name,
      })),
      engine: inferLineageEngine(item, layer),
      id: normalizeLineageId(`${dataset.id}-${item}`),
      layer,
      name: getLineageTableName(item),
    };
  });
  const edges = upstreamNodes.flatMap((sourceNode, index) => {
    const targetNode = upstreamNodes[index + 1] ?? currentNode;
    return targetNode.columns.map((targetColumn, columnIndex) => {
      const sourceColumn = sourceNode.columns[columnIndex % sourceNode.columns.length];
      return {
        fromColumnId: sourceColumn.id,
        fromDatasetId: sourceNode.id,
        toColumnId: targetColumn.id,
        toDatasetId: targetNode.id,
      };
    });
  });

  return {
    datasetId: dataset.id,
    datasets: [...upstreamNodes, currentNode],
    edges,
  };
}

function inferLineageEngine(value: string, layer: LineageLayer): string {
  const lower = value.toLowerCase();
  if (lower.includes("postgres")) return "POSTGRESQL";
  if (lower.includes("kafka")) return "KAFKA";
  if (lower.includes("s3")) return "S3";
  if (layer === "SOURCE" || layer === "RAW") return "LAKE";
  return "ICEBERG";
}

function inferLineageLayer(value: string, currentLayer: CatalogDataset["layer"], index: number): LineageLayer {
  const lower = value.toLowerCase();
  if (lower.includes("postgres") || lower.includes("kafka") || lower.includes("s3")) return "SOURCE";
  if (lower.includes("raw")) return "RAW";
  if (lower.includes("bronze") || (currentLayer === "SILVER" && index > 0)) return "BRONZE";
  if (lower.includes("silver") || currentLayer === "GOLD") return "SILVER";
  return "BRONZE";
}

function getLineageTableName(value: string): string {
  const parts = value.split(/[ /]/).filter(Boolean);
  return parts[parts.length - 1]?.replace(/\*\.csv$/, "events") ?? value;
}

function normalizeLineageId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "lineage";
}
