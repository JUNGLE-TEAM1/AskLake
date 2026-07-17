

import { normalizeJobStatus } from "../../utils/statusMeta";

import type { DagStepsByRunId, JobCommand, JobExecutionEvidence, JobListFacets, JobRowData, JobRunOutcome, JobRunSummary, RunsByJobId, SelectedRunIdByJobId } from "../../types";

export type JobRunStateMaps = {
  dagStepsByRunId: DagStepsByRunId;
  runsByJobId: RunsByJobId;
  selectedRunIdByJobId: SelectedRunIdByJobId;
};

export type ServerJobCommand = Exclude<JobCommand, "edit" | "delete">;

export type CommandPendingByJobId = Partial<Record<string, ServerJobCommand>>;

export const snapshotPollIntervalMs = 1000;

export const snapshotPollMaxAttempts = 900;

export const snapshotPollMaxConsecutiveErrors = 5;

export const emptySelectedJob: JobRowData = {
  id: "JOB-NONE",
  lastRun: "-",
  lastState: "작업 없음",
  name: "작업 없음",
  nextRun: "-",
  owner: "-",
  schedule: "-",
  source: "-",
  status: "paused",
  tag: "[없음]",
  target: "-",
};

export function getInitialJobs(): JobRowData[] {
  return [];
}

export function normalizeJobRow(job: JobRowData): JobRowData {
  const status = normalizeJobStatus(String(job.status));
  return {
    ...job,
    status,
  };
}

export function upsertJobById(jobs: JobRowData[], nextJob: JobRowData): JobRowData[] {
  return [nextJob, ...jobs.filter((job) => job.id !== nextJob.id)];
}

export function replaceJobById(
  jobs: JobRowData[],
  jobId: string,
  updater: (job: JobRowData) => JobRowData,
): JobRowData[] {
  let replaced = false;
  return jobs.flatMap((job) => {
    if (job.id !== jobId) return [job];
    if (replaced) return [];
    replaced = true;
    return [updater(job)];
  });
}

export const jobStatuses = ["scheduled", "failed", "running", "paused", "canceled", "stopped"] as const;

export function getLatestRunOutcome(job: JobRowData): JobRunOutcome | undefined {
  const status = job.runHistory?.[0]?.status;
  return status === "success" || status === "failed" || status === "canceled" ? status : undefined;
}

export function getJobListFacets(jobs: JobRowData[]): JobListFacets {
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

export function moveJobFacetCounts(facets: JobListFacets, previousJob: JobRowData, nextJob: JobRowData): JobListFacets {
  const previousOutcome = getLatestRunOutcome(previousJob);
  const nextOutcome = getLatestRunOutcome(nextJob);
  const statusCounts = { ...facets.statusCounts };
  const latestRunOutcomeCounts = { ...facets.latestRunOutcomeCounts };
  if (previousJob.status !== nextJob.status) {
    statusCounts[previousJob.status] = Math.max(0, (statusCounts[previousJob.status] ?? 0) - 1);
    statusCounts[nextJob.status] = (statusCounts[nextJob.status] ?? 0) + 1;
  }
  if (previousOutcome !== nextOutcome) {
    if (previousOutcome) latestRunOutcomeCounts[previousOutcome] = Math.max(0, (latestRunOutcomeCounts[previousOutcome] ?? 0) - 1);
    if (nextOutcome) latestRunOutcomeCounts[nextOutcome] = (latestRunOutcomeCounts[nextOutcome] ?? 0) + 1;
  }
  return {
    ...facets,
    latestRunOutcomeCounts,
    statusCounts,
  };
}

export function removeJobFacetCounts(facets: JobListFacets, job: JobRowData): JobListFacets {
  const latestRunOutcome = getLatestRunOutcome(job);
  return {
    ...facets,
    latestRunOutcomeCounts: {
      ...facets.latestRunOutcomeCounts,
      ...(latestRunOutcome
        ? { [latestRunOutcome]: Math.max(0, (facets.latestRunOutcomeCounts[latestRunOutcome] ?? 0) - 1) }
        : {}),
    },
    statusCounts: {
      ...facets.statusCounts,
      [job.status]: Math.max(0, (facets.statusCounts[job.status] ?? 0) - 1),
    },
    total: Math.max(0, facets.total - 1),
  };
}

export function upsertRunByRunId(runs: JobRunSummary[], run: JobRunSummary): JobRunSummary[] {
  return [run, ...runs.filter((item) => item.runId !== run.runId)];
}

export function replaceTempRunByRunId(runs: JobRunSummary[], tempRunId: string, run: JobRunSummary): JobRunSummary[] {
  return [run, ...runs.filter((item) => item.runId !== tempRunId && item.runId !== run.runId)];
}

export function withoutRecordKey<T>(record: Record<string, T>, key?: string | null): Record<string, T> {
  if (!key || !(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([recordKey]) => recordKey !== key)) as Record<string, T>;
}

export function restoreRecordEntry<T>(record: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  if (value === undefined) return withoutRecordKey(record, key);
  return {
    ...record,
    [key]: value,
  };
}

export function uniqueRunsByRunId(runs: JobRunSummary[]): JobRunSummary[] {
  const seenRunIds = new Set<string>();
  return runs.filter((run) => {
    if (seenRunIds.has(run.runId)) return false;
    seenRunIds.add(run.runId);
    return true;
  });
}

export function selectedRunFirst(runs: JobRunSummary[], selectedRunId?: string): JobRunSummary[] {
  if (!selectedRunId) return runs;
  const selectedRun = runs.find((run) => run.runId === selectedRunId);
  if (!selectedRun) return runs;
  return [selectedRun, ...runs.filter((run) => run.runId !== selectedRunId)];
}

export function buildJobExecutionEvidence(
  runsByJobId: RunsByJobId,
  selectedRunIdByJobId: SelectedRunIdByJobId,
  dagStepsByRunId: DagStepsByRunId,
): Record<string, JobExecutionEvidence> {
  return Object.fromEntries(
    Object.entries(runsByJobId).map(([jobId, runs]) => {
      const requestedRunId = selectedRunIdByJobId[jobId];
      const selectedRunId = requestedRunId && runs.some((run) => run.runId === requestedRunId)
        ? requestedRunId
        : runs[0]?.runId;
      return [
        jobId,
        {
          dagSteps: selectedRunId ? (dagStepsByRunId[selectedRunId] ?? []) : [],
          runs: selectedRunFirst(runs, selectedRunId),
        },
      ];
    }),
  );
}

export function buildRunStateFromJobs(jobs: JobRowData[]): JobRunStateMaps {
  const runsByJobId: RunsByJobId = {};
  const selectedRunIdByJobId: SelectedRunIdByJobId = {};
  const dagStepsByRunId: DagStepsByRunId = {};

  jobs.forEach((job) => {
    const runs = uniqueRunsByRunId(job.runHistory ?? []);
    if (runs.length === 0) return;

    const selectedRunId = runs[0].runId;
    runsByJobId[job.id] = runs;
    selectedRunIdByJobId[job.id] = selectedRunId;

    Object.entries(job.dagStepsByRunId ?? {}).forEach(([runId, steps]) => {
      if (Array.isArray(steps) && steps.length > 0) {
        dagStepsByRunId[runId] = steps;
      }
    });

    if (job.dagSteps?.length && !dagStepsByRunId[selectedRunId]) {
      dagStepsByRunId[selectedRunId] = job.dagSteps;
    }
  });

  return { dagStepsByRunId, runsByJobId, selectedRunIdByJobId };
}

export function isOptimisticRunCommand(command: JobCommand): command is "run" | "retry" {
  return command === "run" || command === "retry";
}

export function commandSuccessMessage(command: ServerJobCommand, job: JobRowData): string {
  const schedule = job.schedule.toLocaleLowerCase();
  const realtime = ["실시간", "realtime", "real-time", "stream", "kafka"].some((token) => schedule.includes(token));

  if (command === "run") return "작업 실행 요청을 접수했습니다.";
  if (command === "retry") return "작업 재실행 요청을 접수했습니다.";
  if (command === "pause") return "실행 일시정지 요청을 접수했습니다.";
  if (command === "startContinuous") return "Continuous 스트림 시작 요청을 접수했습니다.";
  if (command === "pauseContinuous") return "Continuous 스트림 일시정지 요청을 접수했습니다.";
  if (command === "resumeContinuous") return "Continuous 스트림 재개 요청을 접수했습니다.";
  if (command === "stopContinuous") return "Continuous 스트림 중지 요청을 접수했습니다.";
  if (command === "stopSchedule") return realtime ? "실시간 수집을 중지했습니다." : "다음 반복 예약을 중지했습니다.";
  if (command === "resumeSchedule") return realtime ? "실시간 수집을 다시 시작했습니다." : "반복 스케줄을 다시 시작했습니다.";
  return "작업 취소 요청을 접수했습니다.";
}

export function buildClientRunId(jobId: string): string {
  return `client:${jobId}:${Date.now()}`;
}

export function buildOptimisticRun(runId: string): JobRunSummary {
  return {
    duration: "-",
    endedAt: "-",
    errorSummary: "",
    failedStage: "-",
    inputRows: "-",
    outputRows: "-",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
  };
}

export function buildOptimisticJob(job: JobRowData): JobRowData {
  return normalizeJobRow({
    ...job,
    lastRun: "현재 실행 중",
    lastState: "실행 요청 처리 중",
    nextRun: "-",
    progress: {
      label: "실행 요청 처리 중",
      value: 5,
    },
    status: "running",
  });
}

export function isTerminalRunStatus(status: JobRunSummary["status"]) {
  return status === "success" || status === "failed" || status === "canceled";
}
