import type { JobRowData, JobRunStatus, JobRunSummary, JobStatusSnapshot, RunsByJobId } from "../../types";


export const snapshotStatusPollIntervalMs = 5000;
export const snapshotStatusPollMaxDelayMs = 30000;


function isTerminalStatus(status: JobRunStatus): boolean {
  return status === "success" || status === "failed" || status === "canceled";
}


function upsertLatestRun(runs: JobRunSummary[], run: JobRunSummary): JobRunSummary[] {
  return [run, ...runs.filter((item) => item.runId !== run.runId)];
}


export function activeSnapshotJobIds(
  jobs: JobRowData[],
  runsByJobId: RunsByJobId,
): string[] {
  return jobs
    .filter((job) => job.executionMode !== "continuous")
    .filter((job) => {
      const latestServerRun = (runsByJobId[job.id] ?? job.runHistory ?? [])
        .find((run) => !run.runId.startsWith("client:"));
      return latestServerRun?.status === "queued" || latestServerRun?.status === "running";
    })
    .map((job) => job.id)
    .sort();
}


export function snapshotStatusPollDelayMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return snapshotStatusPollIntervalMs;
  return Math.min(
    snapshotStatusPollIntervalMs * (2 ** Math.min(consecutiveErrors, 3)),
    snapshotStatusPollMaxDelayMs,
  );
}


export function shouldApplyJobStatusSnapshot(
  current: JobRowData,
  snapshot: JobStatusSnapshot,
): boolean {
  if (current.id !== snapshot.id) return false;
  if (current.updatedAt && snapshot.updatedAt && snapshot.updatedAt < current.updatedAt) return false;

  const currentRun = current.runHistory?.[0];
  const nextRun = snapshot.latestRun;
  if (
    currentRun
    && nextRun
    && currentRun.runId === nextRun.runId
    && isTerminalStatus(currentRun.status)
    && !isTerminalStatus(nextRun.status)
  ) {
    return false;
  }
  return true;
}


export function mergeJobStatusSnapshot(
  current: JobRowData,
  snapshot: JobStatusSnapshot,
): JobRowData {
  if (!shouldApplyJobStatusSnapshot(current, snapshot)) return current;
  return {
    ...current,
    status: snapshot.status,
    progress: snapshot.progress ?? undefined,
    lastRun: snapshot.lastRun,
    lastState: snapshot.lastState,
    nextRun: snapshot.nextRun,
    updatedAt: snapshot.updatedAt ?? current.updatedAt,
    runHistory: snapshot.latestRun
      ? upsertLatestRun(current.runHistory ?? [], snapshot.latestRun)
      : current.runHistory,
    dagSteps: snapshot.dagSteps.length > 0 ? snapshot.dagSteps : current.dagSteps,
  };
}


export function mergeJobDetailWithCurrentStatus(
  current: JobRowData,
  detail: JobRowData,
): JobRowData {
  const currentRun = current.runHistory?.[0];
  const detailRun = detail.runHistory?.[0];
  const currentIsNewer = Boolean(
    current.updatedAt
    && detail.updatedAt
    && current.updatedAt > detail.updatedAt,
  );
  const detailWouldRegressRun = Boolean(
    currentRun
    && detailRun
    && currentRun.runId === detailRun.runId
    && isTerminalStatus(currentRun.status)
    && !isTerminalStatus(detailRun.status),
  );
  if (!currentIsNewer && !detailWouldRegressRun) return detail;

  return {
    ...detail,
    status: current.status,
    progress: current.progress,
    lastRun: current.lastRun,
    lastState: current.lastState,
    nextRun: current.nextRun,
    updatedAt: current.updatedAt ?? detail.updatedAt,
    runHistory: currentRun
      ? upsertLatestRun(detail.runHistory ?? [], currentRun)
      : detail.runHistory,
    dagSteps: current.dagSteps?.length ? current.dagSteps : detail.dagSteps,
  };
}
