import type { DraftPipeline, RuleCompilationResult } from "../types";
import { apiClient } from "./apiClient";
import { toCreatePipelineRequest } from "./draftPipelineContract";

export type ReviewEntry = {
  label: string;
  value: string;
};

export type ReviewSchemaRow = {
  columnName: string;
  nullable: string;
  transform: string;
  type: string;
};

export type ReviewValidationRow = {
  label: string;
  status: "ready" | "warning";
  value: string;
};

export type ReviewSnapshot = {
  basicInformation: ReviewEntry[];
  canCreate: boolean;
  destination: ReviewEntry[];
  permission: ReviewEntry[];
  ruleCompilation: RuleCompilationResult;
  schema: ReviewSchemaRow[];
  validation: ReviewValidationRow[];
};

export async function getReviewSnapshot(draft: DraftPipeline): Promise<ReviewSnapshot> {
  const request = {
    ...toCreatePipelineRequest(draft),
    sourceConnectionStatus: draft.source.connectionStatus,
  };

  return apiClient.post<ReviewSnapshot>("/api/etl/review", request);
}
