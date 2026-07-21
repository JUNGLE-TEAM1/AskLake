import { apiClient } from "./apiClient";

export type ContinuousSqlPlanRequest = {
  query: string;
  relationDatasetIds: string[];
  staticBindingPolicy: "PINNED_AT_START";
  triggerIntervalSeconds: number;
};

export type ContinuousSqlPlan = {
  dependencyBindings: ContinuousSqlDependencyBinding[];
  normalizedSql: string;
  outputSchema: string[][];
  planHash: string;
  planVersion: string;
  warnings: Array<{ code?: string; message?: string }>;
};

export type ContinuousSqlDependencyBinding = {
  childJobId?: string | null;
  executionPolicy: "run_on_tree_start" | "reuse_snapshot";
  inputDatasetId: string;
  inputType: "realtime" | "batch" | "static";
  required: boolean;
  sqlJobId?: string | null;
};

export type ContinuousSqlJob = {
  activeTreeRun?: ContinuousSqlTreeRun | null;
  dependencyBindings: ContinuousSqlDependencyBinding[];
  desiredState: "stopped" | "running" | "paused";
  generation: number;
  id: string;
  executionTree?: {
    activeTreeRunId?: string | null;
    lockConflict?: Record<string, unknown> | null;
    lockedJobIds: string[];
    sqlJobId: string;
  } | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  name: string;
  observedState: "starting" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "failed" | "recovering";
  outputDatasetId: string;
  outputDatasetName: string;
  refreshState?: {
    lastError?: string | null;
    latestSourceRevision: number;
    processingSourceRevision?: number | null;
    publishedSourceRevision: number;
    status: "idle" | "running" | "failed" | "catalog_ready" | "dashboard_ready";
  };
  servingMode: "iceberg" | "clickhouse";
};

export type ContinuousSqlTreeRun = {
  continuousSqlRunId?: string | null;
  endedAt?: string | null;
  fencingTokenHash: string;
  generation: number;
  inputDatasetRevisions: Record<string, number>;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  leaseExpiresAt: string;
  locks: Array<{
    active: boolean;
    fencingTokenHash: string;
    generation: number;
    jobId: string;
    leaseExpiresAt: string;
    lockKind: "parent" | "child";
    nodeRunId: string;
  }>;
  nodes: Array<{
    endedAt?: string | null;
    inputDatasetRevisions: Record<string, number>;
    jobId: string;
    nodeRunId: string;
    nodeType: "parent" | "realtime" | "batch";
    parentRunId?: string | null;
    producerRunId?: string | null;
    startedAt: string;
    status: string;
    treeRunId: string;
    triggerType: "parent_tree" | "standalone";
  }>;
  sqlJobId: string;
  startedAt: string;
  status: string;
  treeRunId: string;
  triggerType: "parent_tree" | "standalone";
};

export type CreateClickHouseContinuousSqlRequest = ContinuousSqlPlanRequest & {
  clientRequestId: string;
  name: string;
  output: {
    clickhouseTarget: {
      database: string;
      engine: "clickhouse";
      table: string;
    };
    datasetId: string;
    datasetName: string;
    layer: "GOLD";
    servingMode: "clickhouse";
  };
};

export type CreateIcebergContinuousSqlRequest = ContinuousSqlPlanRequest & {
  clientRequestId: string;
  name: string;
  output: {
    datasetId: string;
    datasetName: string;
    layer: "GOLD";
    servingMode: "iceberg";
  };
};

export type CreateContinuousSqlRequest =
  | CreateClickHouseContinuousSqlRequest
  | CreateIcebergContinuousSqlRequest;

export type ContinuousSqlCommandResponse = {
  command: "start" | "pause" | "resume" | "stop" | "recover";
  commandId: string;
  idempotentReplay: boolean;
  job: ContinuousSqlJob;
};

export function validateContinuousSqlPlan(request: ContinuousSqlPlanRequest) {
  return apiClient.post<ContinuousSqlPlan>("/api/query/continuous-jobs/validate", request);
}

export type VerifyCatalogUniqueKeyResponse = {
  columns: string[];
  distinctKeys: number;
  invalidKeyRows: number;
  totalRows: number;
  verified: true;
};

export function verifyAndRegisterCatalogUniqueKey(datasetId: string, columns: string[]) {
  return apiClient.post<VerifyCatalogUniqueKeyResponse>(
    `/api/catalog/datasets/${encodeURIComponent(datasetId)}/unique-keys/verify-and-register`,
    { columns },
    { timeoutMs: 620_000 },
  );
}

export function createClickHouseContinuousSqlJob(request: CreateClickHouseContinuousSqlRequest) {
  return apiClient.post<ContinuousSqlJob>("/api/query/continuous-jobs", request);
}

export function createContinuousSqlJob(request: CreateContinuousSqlRequest) {
  return apiClient.post<ContinuousSqlJob>("/api/query/continuous-jobs", request);
}

export function commandContinuousSqlJob(jobId: string, command: ContinuousSqlCommandResponse["command"], commandId: string) {
  return apiClient.post<ContinuousSqlCommandResponse>(
    `/api/query/continuous-jobs/${encodeURIComponent(jobId)}/commands`,
    { command, commandId },
    { timeoutMs: 900_000 },
  );
}

export function getContinuousSqlJob(jobId: string) {
  return apiClient.get<ContinuousSqlJob>(
    `/api/query/continuous-jobs/${encodeURIComponent(jobId)}`,
    { timeoutMs: 30_000 },
  );
}
