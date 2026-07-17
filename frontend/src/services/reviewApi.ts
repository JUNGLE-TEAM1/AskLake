import type { CreatePipelineRequest, DraftPipeline, RuleCompilationResult } from "../types";
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

export type ReviewSnapshotRequest = CreatePipelineRequest & {
  sourceConnectionStatus: DraftPipeline["source"]["connectionStatus"];
};

const inFlightReviewRequests = new Map<string, Promise<ReviewSnapshot>>();

export function buildReviewSnapshotRequest(draft: DraftPipeline): ReviewSnapshotRequest {
  return {
    ...toCreatePipelineRequest(draft),
    sourceConnectionStatus: draft.source.connectionStatus,
  };
}

export function getReviewSnapshotRequestKey(request: ReviewSnapshotRequest) {
  return JSON.stringify(request);
}

export function getReviewSnapshot(request: ReviewSnapshotRequest): Promise<ReviewSnapshot> {
  const requestKey = getReviewSnapshotRequestKey(request);
  const inFlightRequest = inFlightReviewRequests.get(requestKey);
  if (inFlightRequest) return inFlightRequest;

  const requestPromise = apiClient.post<ReviewSnapshot>("/api/etl/review", request);

  let trackedRequest: Promise<ReviewSnapshot>;
  trackedRequest = requestPromise.finally(() => {
    if (inFlightReviewRequests.get(requestKey) === trackedRequest) {
      inFlightReviewRequests.delete(requestKey);
    }
  });
  inFlightReviewRequests.set(requestKey, trackedRequest);
  return trackedRequest;
}
