import type { JobRowData, JobStatus, KafkaContinuousRuntime } from "../types";

const transitionalStatuses = new Set(["starting", "pausing", "stopping"]);

export const continuousRuntimeStatusLabels: Record<string, string> = {
  failed: "실패",
  paused: "일시정지",
  pausing: "일시정지 중",
  running: "실행 중",
  starting: "시작 중",
  stopped: "중지",
  stopping: "중지 중",
};

export type ContinuousRuntimeStatusDisplay = {
  label: string;
  spinning: boolean;
  status: JobStatus;
};

export function continuousRuntimeStatusDisplay(job: JobRowData): ContinuousRuntimeStatusDisplay | null {
  if (job.executionMode !== "continuous" || !job.continuousRuntime) return null;

  const runtimeStatus = job.continuousRuntime.status;
  const status: JobStatus = runtimeStatus === "failed"
    ? "failed"
    : runtimeStatus === "pausing" || runtimeStatus === "paused"
      ? "paused"
      : runtimeStatus === "stopping" || runtimeStatus === "stopped"
        ? "stopped"
        : "running";

  return {
    label: continuousRuntimeStatusLabels[runtimeStatus] ?? runtimeStatus,
    spinning: transitionalStatuses.has(runtimeStatus),
    status,
  };
}

export function isContinuousRuntimeTransition(job: JobRowData) {
  return job.executionMode === "continuous"
    && transitionalStatuses.has(job.continuousRuntime?.status ?? "");
}

export function shouldAcceptContinuousRuntimeUpdate(current: JobRowData, incoming: JobRowData) {
  if (current.id !== incoming.id) return false;
  if (!current.continuousRuntime || !incoming.continuousRuntime) return true;

  const currentRevision = continuousStateRevision(current.continuousRuntime);
  const incomingRevision = continuousStateRevision(incoming.continuousRuntime);
  if (incomingRevision < currentRevision) return false;
  if (incomingRevision > currentRevision) return true;

  const currentUpdatedAt = parseTimestamp(current.updatedAt);
  const incomingUpdatedAt = parseTimestamp(incoming.updatedAt);
  if (currentUpdatedAt !== null && incomingUpdatedAt !== null) {
    return incomingUpdatedAt >= currentUpdatedAt;
  }
  return true;
}

export function continuousRuntimeErrorMessage(runtime?: KafkaContinuousRuntime | null) {
  return runtime?.errorDetail?.message ?? runtime?.lastError ?? null;
}

function continuousStateRevision(runtime: KafkaContinuousRuntime) {
  const revision = Number(runtime.stateRevision ?? 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function parseTimestamp(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
