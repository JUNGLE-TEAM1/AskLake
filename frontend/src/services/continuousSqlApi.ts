import { apiClient } from "./apiClient";

export type ContinuousSqlPlanRequest = {
  query: string;
  relationDatasetIds: string[];
  staticBindingPolicy: "PINNED_AT_START";
  triggerIntervalSeconds: number;
};

export type ContinuousSqlPlan = {
  normalizedSql: string;
  outputSchema: string[][];
  planHash: string;
  planVersion: string;
  warnings: Array<{ code?: string; message?: string }>;
};

export type ContinuousSqlJob = {
  dependencyBindings: Array<{
    childJobId?: string | null;
    executionPolicy: "run_on_tree_start" | "reuse_snapshot";
    inputDatasetId: string;
    inputType: "realtime" | "batch" | "static";
    required: boolean;
    sqlJobId: string;
  }>;
  desiredState: "stopped" | "running" | "paused";
  generation: number;
  id: string;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  name: string;
  observedState: "starting" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "failed" | "recovering";
  outputDatasetId: string;
  outputDatasetName: string;
  servingMode: "iceberg" | "clickhouse";
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
