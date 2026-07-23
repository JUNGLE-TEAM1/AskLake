

import { Calendar, CalendarOff, Info, Pencil, Play, RefreshCw, Square, Trash2, X, Zap } from "lucide-react";

import { canRunJobCommand } from "../../../utils/permissions";
import { continuousRuntimeStatusDisplay, continuousRuntimeStatusLabels } from "../../../services/continuousRuntimeContract";

import { type StatusBadgeTone } from "@/components/ui/status-badge";

import type { JobCommand, JobDagStepStatus, JobListFacets, JobListQuery, JobRowData, JobRunStatus, JobRunSummary, JobScheduleKind, JobStatus, RealtimeOperationalHealth } from "../../../types";
import { jobStatusMeta } from "../../../utils/statusMeta";
import { normalizeWhitespace } from "./jobText";

export const runStatusMeta: Record<JobRunStatus, { className: string; label: string }> = {
  queued: { className: "scheduled", label: "실행 대기" },
  running: { className: "running", label: "실행 중" },
  failed: { className: "failed", label: "실패" },
  success: { className: "success", label: "성공" },
  canceled: { className: "canceled", label: "취소" },
};

export const runStatusFilterOrder: JobRunStatus[] = ["queued", "running", "success", "failed", "canceled"];

export const dagStepStatusMeta: Record<JobDagStepStatus, { label: string }> = {
  pending: { label: "대기" },
  running: { label: "진행" },
  success: { label: "성공" },
  failed: { label: "실패" },
  blocked: { label: "중단" },
};

export const realtimeHealthMeta: Record<RealtimeOperationalHealth, { label: string; tone: "danger" | "default" | "running" | "scheduled" }> = {
  healthy: { label: "정상", tone: "running" },
  degraded: { label: "주의", tone: "scheduled" },
  unhealthy: { label: "이상", tone: "danger" },
  unknown: { label: "측정 대기", tone: "default" },
};

export type JobActionButtonVariant = "destructive" | "outline" | "primary" | "subtle";

export function getJobStatusTone(status: JobStatus): StatusBadgeTone {
  if (status === "failed" || status === "canceled") return "danger";
  if (status === "running") return "success";
  if (status === "paused") return "warning";
  if (status === "stopped") return "warning";
  return "default";
}

export function getJobStatusDisplay(job: JobRowData) {
  const continuousDisplay = continuousRuntimeStatusDisplay(job);
  if (continuousDisplay) {
    return {
      ...continuousDisplay,
      tone: getJobStatusTone(continuousDisplay.status),
    };
  }
  return {
    label: jobStatusMeta[job.status].label,
    spinning: job.status === "running",
    status: job.status,
    tone: getJobStatusTone(job.status),
  };
}

export function getRunStatusTone(status: JobRunStatus): StatusBadgeTone {
  if (status === "failed") return "danger";
  if (status === "canceled") return "muted";
  if (status === "success") return "success";
  if (status === "running") return "success";
  return "muted";
}

export function getRunStatusFilterDotClassName(status: JobRunStatus) {
  if (status === "success") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "running") return "bg-blue-500";
  if (status === "queued") return "bg-sky-400";
  return "bg-slate-400";
}

export function getDagStatusTone(status: JobDagStepStatus): StatusBadgeTone {
  if (status === "failed") return "danger";
  if (status === "success") return "success";
  if (status === "running") return "default";
  return "muted";
}

export function getJobActionButtonVariant(className: string): JobActionButtonVariant {
  if (className.includes("danger")) return "destructive";
  if (className.includes("primary soft")) return "subtle";
  if (className.includes("primary")) return "primary";
  return "outline";
}

export function getJobTableRowClassName(status: JobStatus) {
  const statusAccentClassName: Record<JobStatus, string> = {
    canceled: "[&>td:first-child]:shadow-[inset_3px_0_0_#64748b]",
    failed: "bg-red-50/40 [&>td:first-child]:shadow-[inset_3px_0_0_#dc2626]",
    paused: "[&>td:first-child]:shadow-[inset_3px_0_0_#f59e0b]",
    running: "[&>td:first-child]:shadow-[inset_3px_0_0_#16a34a]",
    scheduled: "[&>td:first-child]:shadow-[inset_3px_0_0_#2563eb]",
    stopped: "[&>td:first-child]:shadow-[inset_3px_0_0_#64748b]",
  };

  return statusAccentClassName[status];
}

export type LatestRunModalSelection = {
  fallbackJob: JobRowData;
  fallbackRun: JobRunSummary;
  jobId: string;
  runId: string;
};

export function isContinuousKafkaJob(job: JobRowData) {
  return job.executionMode === "continuous";
}

export { continuousRuntimeStatusLabels };

export const continuousSchemaStatusLabels: Record<string, string> = {
  drift_detected: "변경 감지",
  expected_schema_changed: "예상 스키마 변경",
  policy_paused: "정책 일시정지",
  stable: "정상",
};

export function continuousRuntimeLabel(job: JobRowData) {
  const runtime = job.continuousRuntime;
  if (!runtime) return "연속 수집 설정 대기";
  return `${continuousRuntimeStatusLabels[runtime.status] ?? runtime.status} · ${runtime.storedCount.toLocaleString()}건 적재`;
}

export function jobActionDisabled(job: JobRowData, action: JobListActionKind | JobCommand) {
  if (action === "detail" || action === "runs") return false;
  return !canRunJobCommand(job, action);
}

export function getJobsQueryPath(query: JobListQuery) {
  const searchParams = new URLSearchParams();
  query.statuses?.forEach((status) => searchParams.append("status", status));
  if (query.lastRunOutcome) searchParams.set("lastRunOutcome", query.lastRunOutcome);
  if (query.owner) searchParams.set("owner", query.owner);
  if (query.scheduleKind) searchParams.set("scheduleKind", query.scheduleKind);
  const serialized = searchParams.toString();
  return `/api/etl/jobs${serialized ? `?${serialized}` : ""}`;
}

export function normalizeJobSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function getJobSearchFields(job: JobRowData) {
  return [
    job.name,
    job.id,
    job.owner,
    job.tag,
    job.source,
    job.target,
    job.sourceLabel,
    job.sourceType,
    job.targetLayer,
    job.targetPath,
    job.storagePath,
    job.schedule,
    job.lastState,
  ];
}

export function filterJobsBySearch(jobs: JobRowData[], searchQuery: string) {
  const normalizedQuery = normalizeJobSearchText(searchQuery);

  if (!normalizedQuery) return jobs;

  return jobs.filter((job) => (
    getJobSearchFields(job)
      .filter((value): value is string => Boolean(value))
      .some((value) => normalizeJobSearchText(value).includes(normalizedQuery))
  ));
}

export function getJobScheduleKind(job: JobRowData): JobScheduleKind {
  const schedule = job.schedule.trim().toLocaleLowerCase();
  if (!schedule || schedule === "-" || ["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token))) return "none";
  if (isRealtimeJob(job)) return "realtime";
  if (["매일", "daily"].some((token) => schedule.includes(token))) return "daily";
  if (["매주", "weekly"].some((token) => schedule.includes(token))) return "weekly";
  if (["매월", "monthly"].some((token) => schedule.includes(token))) return "monthly";
  return "other";
}

export function formatJobSchedule(schedule: string) {
  const normalizedSchedule = schedule.trim().toLocaleLowerCase();
  return !normalizedSchedule || normalizedSchedule === "-" || ["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => normalizedSchedule.includes(token))
    ? "스케줄 없음"
    : schedule;
}

export const weeklyScheduleDayIndex: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

export function getNextScheduledRunDate(job: JobRowData, now = new Date()) {
  if (job.status === "stopped" || getJobScheduleKind(job) === "none" || getJobScheduleKind(job) === "realtime") return null;

  const persistedCandidates = [job.schedulePolicy?.nextRunUtc, job.nextRun];
  for (const value of persistedCandidates) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp) && timestamp > now.getTime()) return new Date(timestamp);
  }

  const schedule = job.schedule.trim();
  const dailyMatch = schedule.match(/매일\s*(\d{1,2}):(\d{2})/);
  if (dailyMatch) {
    const candidate = new Date(now);
    candidate.setHours(Number(dailyMatch[1]), Number(dailyMatch[2]), 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  const weeklyMatch = schedule.match(/매주\s*([월화수목금토일])요일\s*(\d{1,2}):(\d{2})/);
  if (weeklyMatch) {
    const candidate = new Date(now);
    candidate.setHours(Number(weeklyMatch[2]), Number(weeklyMatch[3]), 0, 0);
    let daysUntilRun = (weeklyScheduleDayIndex[weeklyMatch[1]] - now.getDay() + 7) % 7;
    if (daysUntilRun === 0 && candidate <= now) daysUntilRun = 7;
    candidate.setDate(candidate.getDate() + daysUntilRun);
    return candidate;
  }

  const monthlyMatch = schedule.match(/매월\s*(\d{1,2})일\s*(\d{1,2}):(\d{2})/);
  if (monthlyMatch) {
    const targetDay = Number(monthlyMatch[1]);
    const buildMonthlyCandidate = (year: number, month: number) => {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return new Date(year, month, Math.min(targetDay, lastDay), Number(monthlyMatch[2]), Number(monthlyMatch[3]), 0, 0);
    };
    let candidate = buildMonthlyCandidate(now.getFullYear(), now.getMonth());
    if (candidate <= now) candidate = buildMonthlyCandidate(now.getFullYear(), now.getMonth() + 1);
    return candidate;
  }

  const intervalMinuteMatch = schedule.match(/(\d{1,2})분마다/);
  if (intervalMinuteMatch) {
    const interval = Math.max(1, Math.min(59, Number(intervalMinuteMatch[1])));
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes((Math.floor(now.getMinutes() / interval) + 1) * interval);
    return candidate;
  }

  const hourlyMinuteMatch = schedule.match(/매시간\s*(\d{1,2})분/);
  if (hourlyMinuteMatch) {
    const candidate = new Date(now);
    candidate.setMinutes(Number(hourlyMinuteMatch[1]), 0, 0);
    if (candidate <= now) candidate.setHours(candidate.getHours() + 1);
    return candidate;
  }

  return null;
}

export function formatNextScheduledRun(job: JobRowData) {
  const nextRun = getNextScheduledRunDate(job);
  return nextRun ? formatCompactDateTime(nextRun.toISOString()) : "-";
}

export function matchesJobListQuery(job: JobRowData, query: JobListQuery) {
  const statuses = new Set(query.statuses ?? []);
  return (
    (statuses.size === 0 || statuses.has(job.status))
    && (!query.lastRunOutcome || getLatestRunOutcome(job) === query.lastRunOutcome)
    && (!query.owner || job.owner === query.owner)
    && (!query.scheduleKind || getJobScheduleKind(job) === query.scheduleKind)
  );
}

export type JobListActionKind = Exclude<JobCommand, "delete"> | "detail" | "runs";

export type JobListAction = {
  className: string;
  kind: JobListActionKind;
  label: string;
};

export type ScheduleControlAction = JobListAction & { kind: "stopSchedule" };

export type IdleExecutionAction = JobListAction & { kind: "retry" | "run" };

export function getJobListActions(job: JobRowData): JobListAction[] {
  const actions: JobListAction[] = [
    { className: "job-action-button", kind: "detail", label: "작업 정보" },
  ];

  if (isContinuousKafkaJob(job)) {
    const runtimeStatus = job.continuousRuntime?.status ?? "stopped";
    if (runtimeStatus === "stopping") {
      return [...actions, { className: "job-action-button primary soft", kind: "runs", label: "중지 중" }];
    }
    if (["starting", "running", "pausing"].includes(runtimeStatus)) {
      return [...actions, { className: "job-action-button primary soft", kind: "runs", label: "런타임" }, { className: "job-action-button danger", kind: "stopContinuous", label: "중지" }];
    }
    return [...actions, { className: "job-action-button primary soft", kind: "startContinuous", label: "스트림 시작" }, { className: "job-action-button", kind: "edit", label: "수정" }];
  }

  if (job.status === "running") {
    if (isRealtimeJob(job)) {
      return [
        ...actions,
        { className: "job-action-button danger realtime-stop", kind: "stopSchedule", label: "실행 중지" },
      ];
    }
    return [
      ...actions,
      { className: "job-action-button danger", kind: "cancelRun", label: "실행 취소" },
    ];
  }

  if (job.status === "paused") {
    return [
      ...actions,
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button retry", kind: "retry", label: "다시 실행" },
    ];
  }

  if (job.status === "stopped") {
    if (isRealtimeJob(job)) {
      return [
        ...actions,
        { className: "job-action-button", kind: "edit", label: "수정" },
        {
          className: "job-action-button realtime-start",
          kind: getLatestRunOutcome(job) === "failed" ? "retry" : "run",
          label: "실행",
        },
      ];
    }
    return [
      ...actions,
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button schedule-resume", kind: "resumeSchedule", label: "스케줄 재개" },
    ];
  }

  const idleActions: JobListAction[] = [
    ...actions,
    { className: "job-action-button", kind: "edit", label: "수정" },
  ];
  const scheduleAction = getActiveScheduleAction(job);
  if (scheduleAction) idleActions.push(scheduleAction);
  idleActions.push(getIdleExecutionAction(job));
  return idleActions;
}

export function isRealtimeJob(job: JobRowData) {
  const schedule = job.schedule.toLocaleLowerCase();
  return ["실시간", "realtime", "real-time", "stream", "kafka"].some((token) => schedule.includes(token));
}

export function hasAutomaticSchedule(job: JobRowData) {
  const schedule = job.schedule.trim().toLocaleLowerCase();
  if (!schedule || schedule === "-") return false;
  return !["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token));
}

export function getActiveScheduleAction(job: JobRowData): ScheduleControlAction | null {
  if (!hasAutomaticSchedule(job) || isRealtimeJob(job)) return null;
  return { className: "job-action-button warning", kind: "stopSchedule", label: "스케줄 일시중지" };
}

export function getIdleExecutionAction(job: JobRowData): IdleExecutionAction {
  const latestOutcome = getLatestRunOutcome(job);
  if (isRealtimeJob(job)) {
    return {
      className: "job-action-button realtime-start",
      kind: latestOutcome === "failed" || job.status === "failed" ? "retry" : "run",
      label: "실행",
    };
  }
  if (latestOutcome === "failed" || job.status === "failed") {
    return { className: "job-action-button retry", kind: "retry", label: "재실행" };
  }
  return { className: "job-action-button success", kind: "run", label: "즉시 실행" };
}

export function getJobListActionButtonClassName(action: { className: string }) {
  if (action.className.includes("success")) {
    return "border-violet-200 bg-violet-50 text-violet-700 shadow-sm hover:border-violet-300 hover:bg-violet-100";
  }
  if (action.className.includes("warning")) {
    return "border-amber-200 bg-amber-50 text-amber-700 shadow-sm hover:border-amber-300 hover:bg-amber-100";
  }
  if (action.className.includes("realtime-start") || action.className.includes("realtime-resume")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm hover:border-emerald-300 hover:bg-emerald-100";
  }
  if (action.className.includes("retry") || action.className.includes("schedule-resume")) {
    return "border-blue-200 bg-blue-50 text-blue-700 shadow-sm hover:border-blue-300 hover:bg-blue-100";
  }
  if (action.className.includes("resume")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm hover:border-emerald-300 hover:bg-emerald-100";
  }
  return "";
}

export type JobDetailAction = {
  className: string;
  kind: JobCommand;
  label: string;
};

export function getJobDetailActions(job: JobRowData): JobDetailAction[] {
  if (isContinuousKafkaJob(job)) {
    const runtimeStatus = job.continuousRuntime?.status ?? "stopped";
    if (runtimeStatus === "stopping") {
      return [];
    }
    if (["starting", "running", "pausing"].includes(runtimeStatus)) {
      return [{ className: "job-action-button danger", kind: "stopContinuous", label: "스트림 중지" }];
    }
    return [
      { className: "job-action-button primary", kind: "startContinuous", label: "스트림 시작" },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }
  if (job.status === "running") {
    if (isRealtimeJob(job)) {
      return [{ className: "job-action-button danger realtime-stop", kind: "stopSchedule", label: "실행 중지" }];
    }
    return [
      { className: "job-action-button danger", kind: "cancelRun", label: "실행 취소" },
    ];
  }

  if (job.status === "paused") {
    return [
      { className: "job-action-button retry", kind: "retry", label: "다시 실행" },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }

  if (job.status === "stopped") {
    if (isRealtimeJob(job)) {
      return [
        {
          className: "job-action-button realtime-start",
          kind: getLatestRunOutcome(job) === "failed" ? "retry" : "run",
          label: "실행",
        },
        { className: "job-action-button", kind: "edit", label: "수정" },
        { className: "job-action-button danger", kind: "delete", label: "삭제" },
      ];
    }
    return [
      {
        className: "job-action-button schedule-resume",
        kind: "resumeSchedule",
        label: "스케줄 재개",
      },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }

  const executionAction = getIdleExecutionAction(job);
  const detailActions: JobDetailAction[] = [];
  const scheduleAction = getActiveScheduleAction(job);
  if (scheduleAction) detailActions.push(scheduleAction);
  detailActions.push(executionAction);
  detailActions.push({ className: "job-action-button", kind: "edit", label: "수정" });
  detailActions.push({ className: "job-action-button danger", kind: "delete", label: "삭제" });
  return detailActions;
}

export function JobDetailActionIcon({ action, job }: { action: JobDetailAction; job: JobRowData }) {
  if (action.kind === "edit") return <Pencil aria-hidden="true" />;
  if (action.kind === "delete") return <Trash2 aria-hidden="true" />;
  if (action.kind === "cancelRun") return <X aria-hidden="true" />;
  if (action.kind === "stopContinuous") return <Square aria-hidden="true" />;
  if (action.kind === "stopSchedule") return isRealtimeJob(job) ? <Square aria-hidden="true" /> : <CalendarOff aria-hidden="true" />;
  if (action.kind === "resumeSchedule") return <Calendar aria-hidden="true" />;
  if (action.kind === "retry") return <RefreshCw aria-hidden="true" />;
  if (isRealtimeJob(job)) return <Play aria-hidden="true" />;
  return <Zap aria-hidden="true" />;
}

export function getJobDetailActionClassName(action: JobDetailAction) {
  if (action.kind === "delete" || action.kind === "cancelRun" || action.className.includes("realtime-stop")) {
    return "border-red-200 bg-red-50 text-red-700 shadow-sm hover:border-red-300 hover:bg-red-100";
  }
  return getJobListActionButtonClassName(action);
}

export type JobsTableRow = {
  job: JobRowData;
};

export function JobListActionIcon({ action }: { action: JobListAction }) {
  if (action.kind === "detail") return <Info aria-hidden="true" size={15} />;
  if (action.kind === "edit") return <Pencil aria-hidden="true" size={15} />;
  if (action.kind === "stopContinuous") return <Square aria-hidden="true" size={15} />;
  if (action.className.includes("realtime-stop")) return <Square aria-hidden="true" size={15} />;
  if (action.className.includes("realtime-start")) return <Play aria-hidden="true" size={15} />;
  if (action.className.includes("realtime-resume")) return <Play aria-hidden="true" size={15} />;
  if (action.kind === "stopSchedule") return <CalendarOff aria-hidden="true" size={15} />;
  if (action.kind === "resumeSchedule") return <Calendar aria-hidden="true" size={15} />;
  if (action.kind === "cancelRun") return <X aria-hidden="true" size={15} />;
  if (action.kind === "retry") return <RefreshCw aria-hidden="true" size={15} />;
  if (action.className.includes("resume")) return <Play aria-hidden="true" size={15} />;

  return <Zap aria-hidden="true" size={15} />;
}

export function formatJobLastRun(job: JobRowData) {
  return formatCompactDateTime(job.lastRun);
}

export function getLatestProblemRun(job: JobRowData) {
  const latestRun = job.runHistory?.[0];
  return latestRun?.status === "failed" || latestRun?.status === "canceled" ? latestRun : undefined;
}

export function getLatestRunOutcome(job: JobRowData): JobRunStatus | null {
  const latestRun = job.runHistory?.[0];
  if (latestRun && ["success", "failed", "canceled"].includes(latestRun.status)) return latestRun.status;
  if (/실행 실패/.test(job.lastState)) return "failed";
  if (/취소됨/.test(job.lastState)) return "canceled";
  return null;
}

export function formatCompactDateTime(value: string) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized === "-") return value;

  const dateCandidate = normalized.includes("T")
    ? normalized
    : /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(normalized)
      ? normalized.replace(" ", "T")
      : "";
  if (!dateCandidate) return value;

  const safeCandidate = dateCandidate.replace(/\.(\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}|$)/, ".$1");
  const date = new Date(safeCandidate);
  if (Number.isNaN(date.getTime())) return value;

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}.${month}.${day} ${hours}:${minutes}`;
}
