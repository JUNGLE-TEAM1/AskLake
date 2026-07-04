import { catalogDatasets, etlJobs } from "../data/mockData";
import { defaultDashboardCards } from "../pages/dashboard/dashboardListData";
import type { CatalogDataset, DashboardListResponse, DraftPipeline, JobCommand, JobDagStep, JobRowData, JobRunSummary, SavedDashboardCard, SqlResultDraft } from "../types";
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

type PageEnvelope = {
  page?: {
    cursor: string | null;
    hasNext: boolean;
  };
};

type JobsResponse = PageEnvelope & {
  jobs: JobRowData[];
};

type DatasetsResponse = PageEnvelope & {
  datasets: CatalogDataset[];
};

type DashboardsResponse = PageEnvelope & {
  dashboards: SavedDashboardCard[];
};

type DashboardResponse = {
  dashboard: SavedDashboardCard;
};

export type DashboardQuery = {
  owner?: string;
  page?: number;
  pageSize?: number;
  searchQuery?: string;
  sort?: string;
  tags?: string[];
};

export type DashboardPageResult = {
  dashboards: SavedDashboardCard[];
  facets: {
    owners: string[];
    tags: string[];
  };
  page: {
    current: number;
    end: number;
    hasNext: boolean;
    hasPrevious: boolean;
    pageSize: number;
    start: number;
    total: number;
    totalPages: number;
  };
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

export async function getJobs(): Promise<JobRowData[]> {
  if (!apiConfig.useMock) {
    const result = await apiClient.get<JobsResponse>("/api/etl/jobs");
    return result.jobs.map(normalizeJob);
  }

  return getMockJobs();
}

export async function getMockJobs(): Promise<JobRowData[]> {
  return resolveMock(etlJobs.map(normalizeJob));
}

export async function getDatasets(): Promise<CatalogDataset[]> {
  if (!apiConfig.useMock) {
    const result = await apiClient.get<DatasetsResponse>("/api/catalog/datasets");
    return result.datasets.map(normalizeDataset);
  }

  return getMockDatasets();
}

export async function getMockDatasets(): Promise<CatalogDataset[]> {
  return resolveMock(catalogDatasets.map(normalizeDataset));
}

function splitDashboardTags(tags: string) {
  return tags.split("|").flatMap((tag) => tag.split("·")).map((tag) => tag.trim()).filter(Boolean);
}

function sortDashboards(cards: SavedDashboardCard[], sort = "updated-desc") {
  const dateValue = (value?: string) => {
    const parsed = Date.parse(value ?? "");
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return [...cards].sort((first, second) => {
    if (sort === "name-asc") return first.name.localeCompare(second.name);
    if (sort === "name-desc") return second.name.localeCompare(first.name);
    if (sort === "created-asc") return dateValue(first.createdAtValue) - dateValue(second.createdAtValue);
    if (sort === "created-desc") return dateValue(second.createdAtValue) - dateValue(first.createdAtValue);
    if (sort === "updated-asc") return dateValue(first.updatedAtValue) - dateValue(second.updatedAtValue);
    return dateValue(second.updatedAtValue) - dateValue(first.updatedAtValue);
  });
}

function getMockDashboards(query: DashboardQuery = {}): DashboardPageResult {
  const pageSize = Math.max(1, Math.min(50, query.pageSize ?? 10));
  const current = Math.max(1, query.page ?? 1);
  const searchQuery = query.searchQuery?.trim().toLowerCase() ?? "";
  const owner = query.owner && query.owner !== "all" ? query.owner : "";
  const tags = query.tags ?? [];
  const filteredCards = defaultDashboardCards.filter((dashboard) => {
    const dashboardTags = splitDashboardTags(dashboard.tags);
    const matchesSearch = !searchQuery || [dashboard.name, dashboard.owner, dashboard.tags].some((value) => value.toLowerCase().includes(searchQuery));
    const matchesOwner = !owner || dashboard.owner === owner;
    const matchesTags = tags.every((tag) => dashboardTags.includes(tag));
    return matchesSearch && matchesOwner && matchesTags;
  });
  const sortedCards = sortDashboards(filteredCards, query.sort);
  const startIndex = (current - 1) * pageSize;
  const visibleCards = sortedCards.slice(startIndex, startIndex + pageSize);
  const owners = Array.from(new Set(defaultDashboardCards.map((dashboard) => dashboard.owner))).sort((first, second) => first.localeCompare(second));
  const allTags = Array.from(new Set(defaultDashboardCards.flatMap((dashboard) => splitDashboardTags(dashboard.tags)))).sort((first, second) => first.localeCompare(second));

  return {
    dashboards: visibleCards,
    facets: {
      owners,
      tags: allTags,
    },
    page: {
      current,
      end: sortedCards.length === 0 ? 0 : Math.min(sortedCards.length, startIndex + visibleCards.length),
      hasNext: startIndex + pageSize < sortedCards.length,
      hasPrevious: current > 1,
      pageSize,
      start: sortedCards.length === 0 ? 0 : startIndex + 1,
      total: sortedCards.length,
      totalPages: Math.max(1, Math.ceil(sortedCards.length / pageSize)),
    },
  };
}

function toDashboardPageResult(response: DashboardListResponse): DashboardPageResult {
  const pageSize = Math.max(1, response.pageSize);
  const totalPages = Math.max(1, Math.ceil(response.total / pageSize));
  const current = Math.min(Math.max(1, response.page), totalPages);
  const start = response.total === 0 ? 0 : (current - 1) * pageSize + 1;

  return {
    dashboards: response.items,
    facets: response.filterOptions,
    page: {
      current,
      end: start === 0 ? 0 : start + response.items.length - 1,
      hasNext: current < totalPages,
      hasPrevious: current > 1,
      pageSize,
      start,
      total: response.total,
      totalPages,
    },
  };
}

export async function getDashboards(query: DashboardQuery = {}): Promise<DashboardPageResult> {
  if (!apiConfig.useMock) {
    const response = await apiClient.post<DashboardListResponse>("/api/dashboards/query", query);
    return toDashboardPageResult(response);
  }

  return resolveMock(getMockDashboards(query));
}

export async function saveDashboardCard(card: SavedDashboardCard): Promise<SavedDashboardCard> {
  if (!apiConfig.useMock) {
    const result = await apiClient.put<DashboardResponse>(`/api/dashboards/${encodeURIComponent(card.id)}`, card);
    return result.dashboard;
  }

  return resolveMock(card);
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
