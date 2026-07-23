import type { TrinoQueryRun } from "../../types";

const QUEUED_QUERY_STATES = new Set(["QUEUED", "WAITING", "PLANNING", "STARTING"]);

export type TrinoExecutionStageStatus = "active" | "cancelled" | "completed" | "failed";

export type TrinoEstimatedRemaining =
  | { kind: "calculating" }
  | { kind: "finalizing" }
  | { kind: "overdue" }
  | { kind: "remaining"; milliseconds: number };

export type TrinoExecutionTimelineModel = {
  collectedRows?: number;
  collectionActive: boolean;
  collectionElapsedMs: number | null;
  collectionFinalizing: boolean;
  collectionProgressPercentage: number | null;
  collectionProgressVisible: boolean;
  collectionRemainingMs: number | null;
  collectionStageStatus: TrinoExecutionStageStatus;
  collectionStageVisible: boolean;
  collectionStateUnknown: boolean;
  completedWork: { completed: number; total: number } | null;
  estimatedRemaining: TrinoEstimatedRemaining | null;
  expectedRows?: number;
  firstResultElapsedMs: number | null;
  firstResultReady: boolean;
  firstResultStageStatus: TrinoExecutionStageStatus;
  firstResultStageVisible: boolean;
  queryExecutionComplete: boolean;
  queryElapsedMs: number | null;
  queryPhaseLabel: string;
  queryProgressVisible: boolean;
  queryStageStatus: TrinoExecutionStageStatus;
  runProgressPercentage: number | null;
  storageFailed: boolean;
  terminalStageStatus: Extract<TrinoExecutionStageStatus, "cancelled" | "failed"> | null;
  totalReadyMs: number | null;
};

export function isTrinoQueryExecutionComplete(run: TrinoQueryRun) {
  const queryState = run.stats?.queryState?.toUpperCase();
  return run.status === "succeeded"
    || queryState === "FINISHING"
    || queryState === "FINISHED"
    || (run.stats?.progressPercentage === 100 && run.stats.outputRows != null);
}

export function isTrinoResultCollectionActive(run: TrinoQueryRun) {
  return run.result?.storageStatus === "collecting" && isTrinoQueryExecutionComplete(run);
}

export function shouldShowTrinoSubmissionTimeline(usesTrinoRuntime: boolean, useMock: boolean) {
  return usesTrinoRuntime && !useMock;
}

function getRunProgressPercentage(run: TrinoQueryRun) {
  const value = run.stats?.progressPercentage;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  if (isTrinoQueryExecutionComplete(run)) return 100;
  return null;
}

function getResultCollectionProgressPercentage(run: TrinoQueryRun) {
  if (run.result?.storageStatus === "available") return 100;
  const collectedRows = run.result?.collectedRowCount ?? run.result?.rowCount;
  const expectedRows = run.result?.expectedRowCount ?? run.stats?.outputRows;
  if (collectedRows == null || expectedRows == null || expectedRows <= 0) return null;
  return Math.max(0, Math.min(100, (collectedRows / expectedRows) * 100));
}

function getTrinoCompletedWork(run: TrinoQueryRun) {
  const candidates = [
    { completed: run.stats?.completedDrivers, total: run.stats?.totalDrivers },
    { completed: run.stats?.completedSplits, total: run.stats?.totalSplits },
  ].filter((candidate): candidate is { completed: number; total: number } => (
    candidate.completed != null && candidate.total != null && candidate.total > 0
  ));
  if (candidates.length === 0) return null;
  const progress = run.stats?.progressPercentage;
  if (progress == null) return candidates[0];
  return candidates.reduce((closest, candidate) => {
    const closestDelta = Math.abs((closest.completed / closest.total) * 100 - progress);
    const candidateDelta = Math.abs((candidate.completed / candidate.total) * 100 - progress);
    return candidateDelta < closestDelta ? candidate : closest;
  });
}

function getEstimatedRemaining(
  estimatedDurationSeconds: number | null | undefined,
  elapsedMs: number | null | undefined,
  progressPercentage: number | null,
  queryExecutionComplete: boolean,
): TrinoEstimatedRemaining | null {
  if (queryExecutionComplete) return null;
  if (progressPercentage != null && progressPercentage >= 100) return { kind: "finalizing" };
  if (estimatedDurationSeconds == null || elapsedMs == null) return { kind: "calculating" };
  const milliseconds = (estimatedDurationSeconds * 1000) - elapsedMs;
  return milliseconds > 0 ? { kind: "remaining", milliseconds } : { kind: "overdue" };
}

function timestampMilliseconds(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedBetween(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  const start = timestampMilliseconds(startedAt);
  const end = timestampMilliseconds(endedAt);
  if (start == null || end == null) return null;
  return Math.max(0, Math.round(end - start));
}

function activeElapsed(startedAt: string | null | undefined, persistedMs: number | null | undefined, nowMs: number) {
  const start = timestampMilliseconds(startedAt);
  if (start == null) return persistedMs ?? null;
  return Math.max(persistedMs ?? 0, Math.max(0, Math.round(nowMs - start)));
}

function getCollectionRemainingMs(elapsedMs: number | null, collectedRows: number | undefined, expectedRows: number | undefined) {
  if (elapsedMs == null || elapsedMs <= 0 || collectedRows == null || collectedRows <= 0 || expectedRows == null || expectedRows <= collectedRows) {
    return null;
  }
  return Math.max(0, Math.round((elapsedMs / collectedRows) * (expectedRows - collectedRows)));
}

export function buildTrinoExecutionTimelineModel(
  run: TrinoQueryRun,
  estimatedDurationSeconds?: number | null,
  nowMs = Date.now(),
): TrinoExecutionTimelineModel {
  const queryState = run.stats?.queryState?.toUpperCase();
  const terminalStageStatus: TrinoExecutionTimelineModel["terminalStageStatus"] = run.status === "cancelled"
    ? "cancelled"
    : run.status === "failed" ? "failed" : null;
  const queryExecutionComplete = isTrinoQueryExecutionComplete(run);
  const queryStageStatus: TrinoExecutionStageStatus = queryExecutionComplete
    ? "completed"
    : terminalStageStatus ?? "active";
  const queryPhaseLabel = terminalStageStatus
    ? run.status === "cancelled" ? "실행 취소됨" : "실행 실패"
    : QUEUED_QUERY_STATES.has(queryState ?? "") || run.status === "queued"
      ? "Trino 대기 중"
      : run.startedAt ? "SQL 실행 중" : "요청 접수 중";
  const storageStatus = run.result?.storageStatus;
  const firstResultReady = Boolean(
    run.result?.firstPageAvailableAt
      || (run.result?.availablePageCount ?? 0) > 0
      || storageStatus === "available"
      || storageStatus === "expired",
  );
  const firstResultStageVisible = queryExecutionComplete;
  const firstResultStageStatus: TrinoExecutionStageStatus = firstResultReady
    ? "completed"
    : storageStatus === "unavailable" ? "failed" : terminalStageStatus ?? "active";
  const collectionStageVisible = run.mode === "run" && queryExecutionComplete && firstResultReady;
  const storageFailed = storageStatus === "unavailable";
  const collectionStateUnknown = collectionStageVisible && storageStatus == null && terminalStageStatus == null;
  const collectionActive = collectionStageVisible
    && terminalStageStatus == null
    && (storageStatus === "collecting" || collectionStateUnknown);
  const collectionStageStatus: TrinoExecutionStageStatus = storageStatus === "available" || storageStatus === "expired"
    ? "completed"
    : storageFailed
      ? "failed"
      : terminalStageStatus ?? "active";
  const runProgressPercentage = getRunProgressPercentage(run);
  const queryActiveElapsedMs = activeElapsed(run.startedAt ?? run.submittedAt, run.stats?.elapsedMs, nowMs);
  const queryElapsedMs = queryStageStatus === "active"
    ? run.startedAt ? queryActiveElapsedMs : run.stats?.elapsedMs ?? null
    : run.stats?.elapsedMs ?? elapsedBetween(run.startedAt ?? run.submittedAt, run.stats?.queryCompletedAt ?? run.completedAt);
  const collectedRows = run.result?.collectedRowCount ?? run.result?.rowCount;
  const expectedRows = run.result?.expectedRowCount ?? run.stats?.outputRows;
  const collectionElapsedMs = collectionActive
    ? activeElapsed(run.result?.collectionStartedAt, run.result?.collectionElapsedMs, nowMs)
    : run.result?.collectionElapsedMs ?? elapsedBetween(run.result?.collectionStartedAt, run.result?.collectionCompletedAt);
  const firstResultElapsedMs = run.result?.firstPageElapsedMs
    ?? elapsedBetween(run.submittedAt, run.result?.firstPageAvailableAt)
    ?? (firstResultStageVisible && !firstResultReady ? activeElapsed(run.submittedAt, null, nowMs) : null);
  const collectionProgressPercentage = getResultCollectionProgressPercentage(run);
  const collectionFinalizing = collectionActive
    && collectionProgressPercentage != null
    && collectionProgressPercentage >= 100;
  const totalReadyMs = run.result?.totalReadyMs
    ?? (["available", "expired"].includes(storageStatus ?? "")
      ? elapsedBetween(run.submittedAt, run.result?.collectionCompletedAt ?? run.completedAt)
      : null);

  return {
    collectedRows,
    collectionActive,
    collectionElapsedMs,
    collectionFinalizing,
    collectionProgressPercentage,
    collectionProgressVisible: collectionActive && collectionProgressPercentage != null,
    collectionRemainingMs: getCollectionRemainingMs(collectionElapsedMs, collectedRows, expectedRows),
    collectionStageStatus,
    collectionStageVisible,
    collectionStateUnknown,
    completedWork: getTrinoCompletedWork(run),
    estimatedRemaining: getEstimatedRemaining(
      estimatedDurationSeconds,
      queryElapsedMs,
      runProgressPercentage,
      queryExecutionComplete,
    ),
    expectedRows,
    firstResultElapsedMs,
    firstResultReady,
    firstResultStageStatus,
    firstResultStageVisible,
    queryExecutionComplete,
    queryElapsedMs,
    queryPhaseLabel,
    queryProgressVisible: queryStageStatus === "active" && runProgressPercentage != null,
    queryStageStatus,
    runProgressPercentage,
    storageFailed,
    terminalStageStatus,
    totalReadyMs,
  };
}
