import { catalogDatasets, etlJobs } from "../data/mockData";
import { defaultDashboardCards } from "../pages/dashboard/dashboardListData";
import type { CatalogDataset, CreateDerivedDatasetRequest, DashboardListResponse, DraftPipeline, JobCommand, JobDagStep, JobListFacets, JobListQuery, JobListResult, JobRowData, JobRunOutcome, JobRunSummary, JobScheduleKind, JobStatus, LineageGraph, LineageGraphDataset, LineageLayer, SavedDashboardCard, SqlResultDraft } from "../types";
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
  dataset?: CatalogDataset;
  job?: JobRowData;
  run?: JobRunSummary;
};

type PageEnvelope = {
  page?: {
    cursor: string | null;
    hasNext: boolean;
  };
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
const commerceRoiResultDatasetName = "gold_commerce_channel_roi";
const commerceRoiJoinTables = ["commerce_orders_daily", "commerce_marketing_spend_daily"];
let mockJobs = etlJobs.map((job) => ({ ...job }));

function normalizeJob(job: JobRowData): JobRowData {
  const status = normalizeJobStatus(job.status);
  return { ...job, status: status === "failed" || status === "canceled" || status === "paused" ? "scheduled" : status };
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

function persistMockJob(job: JobRowData) {
  const normalizedJob = normalizeJob(job);
  const existingIndex = mockJobs.findIndex((item) => item.id === normalizedJob.id);
  if (existingIndex < 0) {
    mockJobs = [normalizedJob, ...mockJobs];
    return normalizedJob;
  }

  mockJobs = mockJobs.map((item, index) => (index === existingIndex ? normalizedJob : item));
  return normalizedJob;
}

async function resolveMockJobCommand(result: JobCommandResult): Promise<JobCommandResult> {
  if (!result.job) return resolveMock(result);

  const job = result.run
    ? {
      ...result.job,
      runHistory: [result.run, ...(result.job.runHistory ?? []).filter((item) => item.runId !== result.run?.runId)],
    }
    : result.job;
  return resolveMock({ ...result, job: persistMockJob(job) });
}

async function resolveMock<T>(payload: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, mockLatencyMs));
  return payload;
}

const jobStatuses: JobStatus[] = ["scheduled", "failed", "running", "paused", "canceled", "stopped"];

function getLatestRunOutcome(job: JobRowData): JobRunOutcome | undefined {
  const status = job.runHistory?.[0]?.status;
  return status === "success" || status === "failed" || status === "canceled" ? status : undefined;
}

function getJobScheduleKind(job: JobRowData): JobScheduleKind {
  const schedule = job.schedule.trim().toLocaleLowerCase();
  if (!schedule || schedule === "-" || ["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token))) return "none";
  if (["실시간", "realtime", "real-time", "stream", "kafka"].some((token) => schedule.includes(token))) return "realtime";
  if (["매일", "daily"].some((token) => schedule.includes(token))) return "daily";
  if (["매주", "weekly"].some((token) => schedule.includes(token))) return "weekly";
  if (["매월", "monthly"].some((token) => schedule.includes(token))) return "monthly";
  return "other";
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

function buildJobListResult(jobs: JobRowData[], query: JobListQuery): JobListResult {
  const normalizedJobs = jobs.map(normalizeJob);
  const selectedStatuses = new Set(query.statuses ?? []);
  const filteredJobs = normalizedJobs.filter((job) => (
    (selectedStatuses.size === 0 || selectedStatuses.has(job.status))
    && (!query.lastRunOutcome || getLatestRunOutcome(job) === query.lastRunOutcome)
    && (!query.scheduleKind || getJobScheduleKind(job) === query.scheduleKind)
    && (!query.owner || job.owner === query.owner)
  ));

  return {
    facets: getJobListFacets(normalizedJobs),
    jobs: filteredJobs,
  };
}

function toJobListSearchParams(query: JobListQuery) {
  const searchParams = new URLSearchParams();
  query.statuses?.forEach((status) => searchParams.append("status", status));
  if (query.lastRunOutcome) searchParams.set("lastRunOutcome", query.lastRunOutcome);
  if (query.owner) searchParams.set("owner", query.owner);
  if (query.scheduleKind) searchParams.set("scheduleKind", query.scheduleKind);
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

export async function getJobs(query: JobListQuery = {}): Promise<JobListResult> {
  if (!apiConfig.useMock) {
    const result = await apiClient.get<JobListResult>(`/api/etl/jobs${toJobListSearchParams(query)}`);
    return {
      facets: result.facets,
      jobs: result.jobs.map(normalizeJob),
    };
  }

  return resolveMock(buildJobListResult(mockJobs, query));
}

export async function getDatasets(): Promise<CatalogDataset[]> {
  if (!apiConfig.useMock) {
    const result = await apiClient.get<DatasetsResponse | CatalogDataset[]>("/api/catalog/datasets");
    const datasets = Array.isArray(result) ? result : result.datasets;
    return datasets.map(normalizeDataset);
  }

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
    name: `${draftPipeline.target.datasetName}_pipeline`,
    id: `JOB-${String(jobCount + 1).padStart(3, "0")}`,
    owner: draftPipeline.permission.owner,
    tag: "[리뷰]",
    source: `${draftPipeline.source.sourceType} / ${draftPipeline.source.sourceLabel}`,
    target: draftPipeline.target.datasetName,
    schedule: draftPipeline.schedule.label,
    lastRun: "생성됨",
    lastState: "대기 중",
    nextRun: draftPipeline.schedule.mode === "manual" ? "-" : "다음 예약 대기",
    qualityInvalidRows: draftPipeline.quality.invalidRows,
    qualityRules: draftPipeline.quality.rules,
    qualityScore: draftPipeline.quality.score,
    qualityStatus: draftPipeline.quality.status,
    sourceConfig: draftPipeline.source.sourceConfig,
    sourceLabel: draftPipeline.source.sourceLabel,
    sourceType: draftPipeline.source.sourceType,
    targetFormat: draftPipeline.target.format,
    targetLayer: draftPipeline.target.layer,
    transformOutputColumns: draftPipeline.transform.outputColumns,
    transformSteps: draftPipeline.transform.steps,
  };

  const sourceConfig = new Map(draftPipeline.source.sourceConfig);
  const isSqlResultSource = draftPipeline.source.sourceType === "SQL Result";
  const sourceRunId = sourceConfig.get("SQL Run ID") ?? "";
  const referenceDatasetIds = sourceConfig.get("Reference Dataset IDs") ?? "";
  const previewRowCount = sourceConfig.get("Preview Row Count") ?? "";
  const querySummary = sourceConfig.get("Query")?.replace(/\s+/g, " ").trim() ?? "";
  const schema = draftPipeline.transform.outputColumns.length > 0
    ? draftPipeline.transform.outputColumns
    : draftPipeline.schema.columns
      .filter((column) => column.included !== false)
      .map((column) => [column.targetName, column.type] as [string, string]);
  const sampleRows = draftPipeline.schema.sampleRows.length > 0
    ? draftPipeline.schema.sampleRows.map((row) => row.slice(0, Math.max(schema.length, 1)))
    : [["-", "-", "-", "-", "Pipeline queued"]];
  const normalizedTags = normalizeDerivedDatasetTags(
    isSqlResultSource
      ? ["#sql-derived", `#${draftPipeline.target.layer.toLowerCase()}`]
      : ["#customer", "#RAG", "#리뷰"],
  );

  const dataset: CatalogDataset = {
    description: isSqlResultSource
      ? `${draftPipeline.target.datasetName} SQL Result 처리 Job으로 생성한 데이터셋`
      : "생성 플로우에서 만든 고객 리뷰 분석용 데이터셋",
    downstream: ["SQL 분석", "대시보드", draftPipeline.target.rag ? "AI 활용" : "카탈로그"],
    freshness: "latest",
    id: `ds_${draftPipeline.target.datasetName}`,
    layer: draftPipeline.target.layer,
    lastUpdated: "방금 생성됨",
    name: draftPipeline.target.datasetName,
    nextRefresh: draftPipeline.schedule.label,
    owner: draftPipeline.permission.owner,
    quality: isSqlResultSource ? "SQL Preview verified" : "95% (Draft verified)",
    rag: draftPipeline.target.rag,
    rows: isSqlResultSource ? `${(Number(previewRowCount) || sampleRows.length).toLocaleString()} preview rows` : "0 rows",
    sampleRows,
    schema: schema.length > 0
      ? schema
      : [["review_id", "bigint"], ["product_id", "string"], ["rating", "int"], ["review_text", "string"], ["sentiment", "string"]],
    size: isSqlResultSource ? "Preview result" : "Pending",
    source: job.name,
    status: "available",
    tags: normalizedTags,
    upstream: [
      draftPipeline.source.sourceLabel,
      ...(isSqlResultSource && sourceRunId ? [sourceRunId] : []),
      ...(isSqlResultSource && referenceDatasetIds && referenceDatasetIds !== "-" ? referenceDatasetIds.split(",").map((item) => item.trim()).filter(Boolean) : []),
      ...(isSqlResultSource && querySummary ? [`SQL: ${querySummary.slice(0, 96)}`] : []),
      job.name,
    ],
  };
  dataset.lineageGraph = buildPipelineDatasetLineageGraph(draftPipeline, dataset);

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
    cancelRun: { action: "etl.run.cancel_requested", apiPath: `/api/etl/jobs/${job.id}/runs/current/cancel` },
    stopSchedule: { action: "etl.schedule.stop_requested", apiPath: `/api/etl/jobs/${job.id}/schedule` },
    resumeSchedule: { action: "etl.schedule.resume_requested", apiPath: `/api/etl/jobs/${job.id}/schedule` },
    startContinuous: { action: "etl.continuous.start_requested", apiPath: `/api/etl/jobs/${job.id}/commands` },
    pauseContinuous: { action: "etl.continuous.pause_requested", apiPath: `/api/etl/jobs/${job.id}/commands` },
    resumeContinuous: { action: "etl.continuous.resume_requested", apiPath: `/api/etl/jobs/${job.id}/commands` },
    stopContinuous: { action: "etl.continuous.stop_requested", apiPath: `/api/etl/jobs/${job.id}/commands` },
  };
  const audit = actionByCommand[command];
  const runId = `run_${Date.now()}`;

  if (["startContinuous", "pauseContinuous", "resumeContinuous", "stopContinuous"].includes(command)) {
    const current = job.continuousRuntime ?? {
      checkpointPath: `s3a://asklake-output/${job.target}/_checkpoints/${job.id}`,
      consumedCount: 0,
      failedCount: 0,
      lagAvailable: false,
      laggingPartitionCount: 0,
      lastBatchInputRows: 0,
      partitionProgress: {},
      quarantinedCount: 0,
      replayedCount: 0,
      schemaChanges: [],
      schemaStatus: "stable",
      schemaVersion: 1,
      status: "stopped" as const,
      storedCount: 0,
    };
    const status = command === "pauseContinuous" ? "paused" : command === "stopContinuous" ? "stopped" : "running" as const;
    return resolveMock({
      ...audit,
      job: {
        ...job,
        executionMode: "continuous",
        continuousRuntime: {
          ...current,
          heartbeatAt: new Date().toISOString(),
          status,
        },
        lastState: status === "running" ? "Continuous Spark streaming" : status === "paused" ? "Continuous worker 일시정지됨" : "Continuous worker 중지됨 · checkpoint 보존",
        progress: status === "running" ? { label: "Continuous micro-batch 실행 중", value: 66 } : undefined,
        status: status === "running" ? "running" : status,
      },
    });
  }

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

    return resolveMockJobCommand({
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

    return resolveMockJobCommand({
      ...audit,
      dagSteps,
      job: {
        ...job,
        status: "paused",
        lastRun: new Date().toISOString(),
        lastState: "사용자 일시정지",
        nextRun: "재개 대기",
        progress: job.progress ?? { label: "일시정지됨", value: 50 },
      },
      run,
    });
  }

  if (command === "stopSchedule") {
    const realtime = getJobScheduleKind(job) === "realtime";
    const stoppedAt = new Date().toISOString();
    const run: JobRunSummary | undefined = realtime && job.status === "running"
      ? {
        duration: "수집 중지",
        endedAt: stoppedAt,
        errorSummary: "사용자 요청으로 실시간 수집 중지",
        failedStage: "실시간 수집 중지",
        inputRows: job.stats?.inputRows ?? "-",
        outputRows: job.stats?.outputRows ?? "-",
        runId: `run_${Date.now()}`,
        startedAt: stoppedAt,
        status: "canceled",
      }
      : undefined;
    const dagSteps: JobDagStep[] | undefined = run
      ? [
        { id: "step-1", meta: job.source, status: "success", title: "1. Source 연결" },
        { id: "step-2", meta: "사용자 수집 중지", status: "blocked", title: "2. 실시간 수집" },
        { id: "step-3", meta: job.target, status: "blocked", title: "3. Lake 적재" },
      ]
      : undefined;

    return resolveMockJobCommand({
      ...audit,
      dagSteps,
      job: {
        ...job,
        status: "stopped",
        lastRun: run ? stoppedAt : job.lastRun,
        lastState: realtime ? "실시간 수집 중지" : "스케줄 일시중지",
        nextRun: "-",
        progress: undefined,
      },
      run,
    });
  }

  if (command === "resumeSchedule") {
    const realtime = getJobScheduleKind(job) === "realtime";
    return resolveMockJobCommand({
      ...audit,
      job: {
        ...job,
        status: "scheduled",
        lastState: realtime ? "실시간 수집 재개됨" : "스케줄 재개됨",
        nextRun: job.schedulePolicy?.nextRunUtc || "다음 예약 계산 중",
        progress: undefined,
      },
    });
  }

  const canceledAt = new Date().toISOString();
  const run: JobRunSummary = {
    duration: "취소됨",
    endedAt: canceledAt,
    errorSummary: "사용자 요청으로 취소",
    failedStage: "-",
    inputRows: "72,410",
    outputRows: "0",
    runId,
    startedAt: canceledAt,
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

  return resolveMockJobCommand({
    ...audit,
    dagSteps,
    job: {
      ...job,
      status: "scheduled",
      lastRun: canceledAt,
      lastState: "취소됨",
      nextRun: job.schedule === "스케줄 없음" || job.schedule === "수동 실행" ? "-" : "다음 예약 대기",
      progress: undefined,
    },
    run,
  });
}

export type QueryPreviewOptions = {
  limit: number;
  referenceDatasetIds: string[];
  validationKey: string;
};

export type DerivedDatasetCreationContext = {
  request: CreateDerivedDatasetRequest;
  sourceDataset: CatalogDataset;
  sqlResult: SqlResultDraft;
};

export async function executeQueryPreview(dataset: CatalogDataset, query: string, options: QueryPreviewOptions): Promise<SqlResultDraft> {
  if (!apiConfig.useMock) {
    return apiClient.post<SqlResultDraft>("/api/query/runs", {
      baseDatasetId: dataset.id,
      datasetId: dataset.id,
      limit: options.limit,
      mode: "preview",
      query,
      referenceDatasetIds: options.referenceDatasetIds,
      validationKey: options.validationKey,
    });
  }

  const previewDataset = resolveMockQueryResultDataset(dataset, query);
  const columns = previewDataset === dataset
    ? previewDataset.schema.slice(0, 6).map(([name]) => name)
    : previewDataset.schema.map(([name]) => name);
  const rows = previewDataset.sampleRows
    .slice(0, options.limit)
    .map((row) => row.slice(0, Math.max(columns.length, 1)));

  return resolveMock({
    baseDatasetId: dataset.id,
    columns,
    datasetId: previewDataset.id,
    datasetName: previewDataset.name,
    executedAt: new Date().toISOString(),
    mode: "preview",
    previewLimit: options.limit,
    query,
    referenceDatasetIds: options.referenceDatasetIds,
    rowCount: rows.length,
    rows,
    runId: `sql_preview_${Date.now()}`,
    validationKey: options.validationKey,
  });
}

function resolveMockQueryResultDataset(baseDataset: CatalogDataset, query: string) {
  const normalizedQuery = normalizeMockSql(query);
  const isCommerceRoiJoin = commerceRoiJoinTables.every((tableName) => normalizedQuery.includes(tableName))
    && normalizedQuery.includes(" join ")
    && (normalizedQuery.includes(" roas") || normalizedQuery.includes("cost_per_order") || normalizedQuery.includes("ad_spend"));

  if (!isCommerceRoiJoin) return baseDataset;
  return catalogDatasets.find((item) => item.name === commerceRoiResultDatasetName) ?? baseDataset;
}

function normalizeMockSql(query: string) {
  return ` ${query
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/["`[\]]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim()} `;
}

export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  return executeQueryPreview(dataset, query, { limit: 100, referenceDatasetIds: [], validationKey: `${dataset.id}:${query}` });
}

export async function createDerivedDatasetFromSql({
  request,
  sourceDataset,
  sqlResult,
}: DerivedDatasetCreationContext): Promise<CatalogDataset> {
  if (!apiConfig.useMock) {
    return apiClient.post<CatalogDataset>("/api/catalog/derived-datasets", request);
  }

  const normalizedName = request.dataset.name.trim() || `${sourceDataset.name}_analysis`;
  const normalizedDescription = request.dataset.description.trim() || `${sourceDataset.name} SQL 쿼리 결과로 생성한 분석 데이터셋`;
  const normalizedTags = normalizeDerivedDatasetTags(request.dataset.tags);
  const derivedDatasetId = `ds_${normalizeDerivedDatasetId(normalizedName)}`;
  const dataset: CatalogDataset = {
    description: normalizedDescription,
    downstream: ["SQL 분석", "대시보드"],
    freshness: "latest",
    id: derivedDatasetId,
    layer: request.dataset.layer,
    lastUpdated: "방금 생성됨",
    name: normalizedName,
    nextRefresh: "수동 갱신",
    owner: sourceDataset.owner,
    quality: "Preview verified",
    rag: request.dataset.rag,
    rows: `${sqlResult.rowCount.toLocaleString()} preview rows`,
    sampleRows: sqlResult.rows,
    schema: sqlResult.columns.map((column) => [column, inferColumnType(sourceDataset, column)]),
    size: "Preview result",
    source: `SQL Preview · ${sqlResult.runId}`,
    status: "available",
    tags: normalizedTags,
    upstream: [sourceDataset.name, ...(request.referenceDatasetIds ?? []), request.sourceRunId],
  };
  dataset.lineageGraph = buildDerivedDatasetLineageGraph(sourceDataset, dataset, sqlResult);

  return resolveMock(dataset);
}

function inferColumnType(dataset: CatalogDataset, columnName: string) {
  return dataset.schema.find(([name]) => name === columnName)?.[1] ?? "string";
}

function normalizeDerivedDatasetTags(tags: string[]) {
  const normalizedTags = tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith("#") ? tag : `#${tag}`);

  return Array.from(new Set(normalizedTags.length > 0 ? normalizedTags : ["#sql-derived"]));
}

function normalizeDerivedDatasetId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "sql_derived";
}

function buildDerivedDatasetLineageGraph(
  sourceDataset: CatalogDataset,
  derivedDataset: CatalogDataset,
  sqlResult: SqlResultDraft,
): LineageGraph {
  const sourceGraph = sourceDataset.lineageGraph;
  const derivedNode: LineageGraphDataset = {
    columns: derivedDataset.schema.map(([name, type]) => ({ id: normalizeLineageId(`${derivedDataset.id}-${name}`), name, type })),
    engine: "ICEBERG",
    id: derivedDataset.id,
    layer: derivedDataset.layer,
    name: derivedDataset.name,
  };
  const sourceNode = sourceGraph?.datasets.find((node) => node.id === sourceDataset.id)
    ?? buildLineageDatasetNode(sourceDataset);
  const sourceGraphDatasets = sourceGraph?.datasets.filter((node) => node.id !== derivedDataset.id) ?? [];
  const baseDatasets = sourceGraph
    ? sourceGraphDatasets.some((node) => node.id === sourceNode.id) ? sourceGraphDatasets : [...sourceGraphDatasets, sourceNode]
    : [sourceNode];
  const baseEdges = sourceGraph?.edges.filter((edge) => edge.toDatasetId !== derivedDataset.id && edge.fromDatasetId !== derivedDataset.id) ?? [];
  const derivedEdges = derivedNode.columns.map((targetColumn, index) => {
    const sourceColumn = sourceNode.columns.find((column) => column.name === targetColumn.name)
      ?? sourceNode.columns[index % Math.max(sourceNode.columns.length, 1)]
      ?? targetColumn;
    return {
      fromColumnId: sourceColumn.id,
      fromDatasetId: sourceNode.id,
      toColumnId: targetColumn.id,
      toDatasetId: derivedNode.id,
    };
  });

  return {
    datasetId: derivedDataset.id,
    datasets: [...baseDatasets, derivedNode],
    edges: [...baseEdges, ...derivedEdges],
  };
}

function buildPipelineDatasetLineageGraph(draftPipeline: DraftPipeline, targetDataset: CatalogDataset): LineageGraph {
  const targetNode = buildLineageDatasetNode(targetDataset);
  const sourceColumns = draftPipeline.schema.columns.length > 0
    ? draftPipeline.schema.columns.map((column) => ({
      id: normalizeLineageId(`${targetDataset.id}-source-${column.sourceName || column.targetName}`),
      name: column.sourceName || column.targetName,
      type: column.type,
    }))
    : targetNode.columns.map((column) => ({
      ...column,
      id: normalizeLineageId(`${targetDataset.id}-source-${column.name}`),
    }));
  const sourceNode: LineageGraphDataset = {
    columns: sourceColumns,
    engine: inferLineageEngine(draftPipeline.source.sourceType, "SOURCE"),
    id: normalizeLineageId(`${targetDataset.id}-${draftPipeline.source.sourceLabel}`),
    layer: "SOURCE",
    name: draftPipeline.source.sourceLabel,
  };
  const edges = targetNode.columns.map((targetColumn, index) => {
    const sourceColumn = sourceNode.columns.find((column) => column.name === targetColumn.name)
      ?? sourceNode.columns[index % Math.max(sourceNode.columns.length, 1)]
      ?? targetColumn;
    return {
      fromColumnId: sourceColumn.id,
      fromDatasetId: sourceNode.id,
      toColumnId: targetColumn.id,
      toDatasetId: targetNode.id,
    };
  });

  return {
    datasetId: targetDataset.id,
    datasets: [sourceNode, targetNode],
    edges,
  };
}

function buildLineageDatasetNode(dataset: CatalogDataset): LineageGraphDataset {
  return {
    columns: dataset.schema.map(([name, type]) => ({ id: normalizeLineageId(`${dataset.id}-${name}`), name, type })),
    engine: "ICEBERG",
    id: dataset.id,
    layer: dataset.layer,
    name: dataset.name,
  };
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
