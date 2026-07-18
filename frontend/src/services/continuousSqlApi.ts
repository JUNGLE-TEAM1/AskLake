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
  desiredState: "stopped" | "running" | "paused";
  generation: number;
  id: string;
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

export type ContinuousSqlCommandResponse = {
  command: "start" | "pause" | "resume" | "stop" | "recover";
  commandId: string;
  idempotentReplay: boolean;
  job: ContinuousSqlJob;
};

export function validateContinuousSqlPlan(request: ContinuousSqlPlanRequest) {
  return apiClient.post<ContinuousSqlPlan>("/api/query/continuous-jobs/validate", request);
}

export function createClickHouseContinuousSqlJob(request: CreateClickHouseContinuousSqlRequest) {
  return apiClient.post<ContinuousSqlJob>("/api/query/continuous-jobs", request);
}

export function commandContinuousSqlJob(jobId: string, command: ContinuousSqlCommandResponse["command"], commandId: string) {
  return apiClient.post<ContinuousSqlCommandResponse>(
    `/api/query/continuous-jobs/${encodeURIComponent(jobId)}/commands`,
    { command, commandId },
  );
}
