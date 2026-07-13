import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@/components/reui/timeline";
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CalendarOff,
  Check,
  CircleUser,
  Clock3,
  Database,
  Download,
  Filter,
  HardDrive,
  History,
  Info,
  ListChecks,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Star,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Square,
  Table2,
  TerminalSquare,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { Field, PageTitle } from "../../components/common";
import { getSourceBrandMeta, SourceBrandIcon } from "../../components/source/SourceBrand";
import { getCatalogDataset } from "../../services/catalogApi";
import { getCellphonesReviewAnalysis, runCellphonesReviewAnalysis, type ReviewAnalysisSummary } from "../../services/reviewAnalysisApi";
import { compactContinuousTarget, getContinuousMaintenanceRuns, getContinuousQuarantine, getContinuousSessionBatches, getContinuousSessions, getContinuousWorkerLogs, replayContinuousQuarantine } from "../../services/pipelineApi";
import type { ContinuousMaintenanceRun, ContinuousQuarantineRecord, KafkaContinuousBatch, KafkaContinuousSession, KafkaContinuousSessionStatus } from "../../types";
import { canRunJobCommand, permissionDeniedMessage } from "../../utils/permissions";
import { ActionGroup } from "@/components/ui/action-group";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getIdentityInitials, UserIdentity } from "@/components/ui/user-identity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import {
  DataTableCellPrimary,
  DataTableCellSecondary,
  DataTableStackedCell,
} from "@/components/ui/data-table-stacked-cell";
import { DetailTableSection } from "@/components/ui/detail-table-section";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterToolbar, FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { IconButton } from "@/components/ui/icon-button";
import { KeyValueList, type KeyValueListItem } from "@/components/ui/key-value-list";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, type StatusBadgeTone } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AuditResult, JobCommand, JobDagStep, JobDagStepStatus, JobExecutionEvidence, JobListFacets, JobListQuery, JobRowData, JobRunStatus, JobRunSummary, JobScheduleKind, JobStats, JobStatus, RealtimeOperationalHealth } from "../../types";
import { jobStatusMeta } from "../../utils/statusMeta";

const runStatusMeta: Record<JobRunStatus, { className: string; label: string }> = {
  queued: { className: "scheduled", label: "실행 대기" },
  running: { className: "running", label: "실행 중" },
  failed: { className: "failed", label: "실패" },
  success: { className: "success", label: "성공" },
  canceled: { className: "canceled", label: "취소" },
};

const runStatusFilterOrder: JobRunStatus[] = ["queued", "running", "success", "failed", "canceled"];

const dagStepStatusMeta: Record<JobDagStepStatus, { label: string }> = {
  pending: { label: "대기" },
  running: { label: "진행" },
  success: { label: "성공" },
  failed: { label: "실패" },
  blocked: { label: "중단" },
};

const realtimeHealthMeta: Record<RealtimeOperationalHealth, { label: string; tone: "danger" | "default" | "running" | "scheduled" }> = {
  healthy: { label: "정상", tone: "running" },
  degraded: { label: "주의", tone: "scheduled" },
  unhealthy: { label: "이상", tone: "danger" },
  unknown: { label: "측정 대기", tone: "default" },
};

type JobActionButtonVariant = "destructive" | "outline" | "primary" | "subtle";

function getJobStatusTone(status: JobStatus): StatusBadgeTone {
  if (status === "failed" || status === "canceled") return "danger";
  if (status === "running") return "success";
  if (status === "paused") return "warning";
  if (status === "stopped") return "warning";
  return "default";
}

function getRunStatusTone(status: JobRunStatus): StatusBadgeTone {
  if (status === "failed") return "danger";
  if (status === "canceled") return "muted";
  if (status === "success") return "success";
  if (status === "running") return "success";
  return "muted";
}

function getRunStatusFilterDotClassName(status: JobRunStatus) {
  if (status === "success") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "running") return "bg-blue-500";
  if (status === "queued") return "bg-sky-400";
  return "bg-slate-400";
}

function getDagStatusTone(status: JobDagStepStatus): StatusBadgeTone {
  if (status === "failed") return "danger";
  if (status === "success") return "success";
  if (status === "running") return "default";
  return "muted";
}

function getJobActionButtonVariant(className: string): JobActionButtonVariant {
  if (className.includes("danger")) return "destructive";
  if (className.includes("primary soft")) return "subtle";
  if (className.includes("primary")) return "primary";
  return "outline";
}

function getJobTableRowClassName(status: JobStatus) {
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

type JobMetricTone = "total" | "running" | "scheduled" | "stopped";

type JobMetric = {
  label: string;
  statuses?: JobStatus[];
  tone: JobMetricTone;
  value: string;
};

type LatestRunModalSelection = {
  fallbackJob: JobRowData;
  fallbackRun: JobRunSummary;
  jobId: string;
  runId: string;
};

function getJobMetrics(facets: JobListFacets): JobMetric[] {
  return [
    { label: "전체 작업", tone: "total", value: String(facets.total) },
    { label: jobStatusMeta.running.label, statuses: ["running"], tone: "running", value: String(facets.statusCounts.running) },
    { label: jobStatusMeta.scheduled.label, statuses: ["scheduled"], tone: "scheduled", value: String(facets.statusCounts.scheduled) },
    { label: "자동 실행 중지", statuses: ["stopped"], tone: "stopped", value: String(facets.statusCounts.stopped) },
  ];
}

function hasSameStatuses(first?: JobStatus[], second?: JobStatus[]) {
  if (!first?.length && !second?.length) return true;
  if (!first || !second || first.length !== second.length) return false;
  return first.every((status) => second.includes(status));
}

function isContinuousKafkaJob(job: JobRowData) {
  return job.executionMode === "continuous";
}

function continuousRuntimeLabel(job: JobRowData) {
  const runtime = job.continuousRuntime;
  if (!runtime) return "Continuous 설정 대기";
  return `${runtime.status} · ${runtime.storedCount.toLocaleString()}건 적재`;
}

function jobActionDisabled(job: JobRowData, action: JobListActionKind | JobCommand) {
  if (action === "detail" || action === "runs") return false;
  return !canRunJobCommand(job, action);
}

function getJobsQueryPath(query: JobListQuery) {
  const searchParams = new URLSearchParams();
  query.statuses?.forEach((status) => searchParams.append("status", status));
  if (query.lastRunOutcome) searchParams.set("lastRunOutcome", query.lastRunOutcome);
  if (query.owner) searchParams.set("owner", query.owner);
  if (query.scheduleKind) searchParams.set("scheduleKind", query.scheduleKind);
  const serialized = searchParams.toString();
  return `/api/etl/jobs${serialized ? `?${serialized}` : ""}`;
}

function normalizeJobSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function getJobSearchFields(job: JobRowData) {
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

function filterJobsBySearch(jobs: JobRowData[], searchQuery: string) {
  const normalizedQuery = normalizeJobSearchText(searchQuery);

  if (!normalizedQuery) return jobs;

  return jobs.filter((job) => (
    getJobSearchFields(job)
      .filter((value): value is string => Boolean(value))
      .some((value) => normalizeJobSearchText(value).includes(normalizedQuery))
  ));
}

function getJobScheduleKind(job: JobRowData): JobScheduleKind {
  const schedule = job.schedule.trim().toLocaleLowerCase();
  if (!schedule || schedule === "-" || ["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token))) return "none";
  if (isRealtimeJob(job)) return "realtime";
  if (["매일", "daily"].some((token) => schedule.includes(token))) return "daily";
  if (["매주", "weekly"].some((token) => schedule.includes(token))) return "weekly";
  if (["매월", "monthly"].some((token) => schedule.includes(token))) return "monthly";
  return "other";
}

function formatJobSchedule(schedule: string) {
  const normalizedSchedule = schedule.trim().toLocaleLowerCase();
  return !normalizedSchedule || normalizedSchedule === "-" || ["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => normalizedSchedule.includes(token))
    ? "스케줄 없음"
    : schedule;
}

const weeklyScheduleDayIndex: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

function getNextScheduledRunDate(job: JobRowData, now = new Date()) {
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

function formatNextScheduledRun(job: JobRowData) {
  const nextRun = getNextScheduledRunDate(job);
  return nextRun ? formatCompactDateTime(nextRun.toISOString()) : "-";
}

function matchesJobListQuery(job: JobRowData, query: JobListQuery) {
  const statuses = new Set(query.statuses ?? []);
  return (
    (statuses.size === 0 || statuses.has(job.status))
    && (!query.lastRunOutcome || getLatestRunOutcome(job) === query.lastRunOutcome)
    && (!query.owner || job.owner === query.owner)
    && (!query.scheduleKind || getJobScheduleKind(job) === query.scheduleKind)
  );
}

export function JobsLandingPage({
  jobListFacets,
  jobsLoading,
  jobs,
  onAction,
  onCommand,
  onCreate,
  onDetail,
  onFilter,
}: {
  jobListFacets: JobListFacets;
  jobsLoading: boolean;
  jobs: JobRowData[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => Promise<JobRowData | undefined>;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onFilter: (query: JobListQuery) => Promise<void> | void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [jobQuery, setJobQuery] = useState<JobListQuery>({});
  const [excludedJobIds, setExcludedJobIds] = useState<Set<string>>(() => new Set());
  const [latestRunModalSelection, setLatestRunModalSelection] = useState<LatestRunModalSelection | null>(null);
  const metrics = getJobMetrics(jobListFacets);
  const failureFilterActive = jobQuery.lastRunOutcome === "failed";
  const failedRunCount = jobListFacets.latestRunOutcomeCounts.failed;
  const filteredJobs = useMemo(
    () => filterJobsBySearch(jobs, searchQuery).filter((job) => !excludedJobIds.has(job.id)),
    [excludedJobIds, jobs, searchQuery],
  );
  const latestRunModal = useMemo(() => {
    if (!latestRunModalSelection) return null;
    const job = jobs.find((candidate) => candidate.id === latestRunModalSelection.jobId)
      ?? latestRunModalSelection.fallbackJob;
    const run = job.runHistory?.find((candidate) => candidate.runId === latestRunModalSelection.runId)
      ?? latestRunModalSelection.fallbackRun;
    return { job, run };
  }, [jobs, latestRunModalSelection]);
  const hasSearchQuery = searchQuery.trim().length > 0;

  const updateJobQuery = (nextQuery: JobListQuery) => {
    setExcludedJobIds(new Set());
    setJobQuery(nextQuery);
    onAction("etl.jobs.filter_changed", getJobsQueryPath(nextQuery), nextQuery.statuses?.join(",") ?? nextQuery.lastRunOutcome ?? nextQuery.owner ?? nextQuery.scheduleKind ?? "all");
    onFilter(nextQuery);
  };

  const handleJobCommand = useCallback(async (job: JobRowData, command: JobCommand) => {
    const updatedJob = await onCommand(job, command);
    if (!updatedJob || matchesJobListQuery(updatedJob, jobQuery)) return;
    setExcludedJobIds((current) => new Set(current).add(updatedJob.id));
  }, [jobQuery, onCommand]);

  const clearSearch = () => {
    setSearchQuery("");
    onAction("etl.jobs.search_reset", "/api/etl/jobs", "search");
  };

  const openLatestRunTimeline = (job: JobRowData) => {
    const latestRun = job.runHistory?.[0];
    if (!latestRun) return;
    onAction("etl.run.detail_opened", `/api/etl/jobs/${job.id}/runs/${latestRun.runId}`, latestRun.runId);
    setLatestRunModalSelection({
      fallbackJob: job,
      fallbackRun: latestRun,
      jobId: job.id,
      runId: latestRun.runId,
    });
  };

  const toggleFailureFilter = () => {
    if (failureFilterActive) {
      setSearchQuery("");
      updateJobQuery({});
      return;
    }
    updateJobQuery({
      ...jobQuery,
      lastRunOutcome: "failed",
    });
  };

  return (
    <div className="jobs-landing">
      <PageHeader
        actions={(
          <Button type="button" onClick={onCreate}>
            <Plus size={16} />
            새 수집/처리 생성
          </Button>
        )}
        icon={<Database size={30} />}
        iconClassName="mt-0 size-16 rounded-xl"
        leadingAlign="center"
        size="lg"
        title="수집/처리"
        titleClassName="text-4xl"
      />
      <div className="content-main jobs-panel-stack">
        <Panel className="jobs-metrics-card">
          <PanelHeader
            className="min-h-[68px] [&_h2]:text-xl"
            icon={<Activity size={16} />}
            iconClassName="size-11 border border-blue-100 bg-white text-blue-700 shadow-sm [&_svg]:size-[22px]"
            title="작업 현황"
          />
          <div className="jobs-panel-metrics grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => (
              <JobStatusFilterCard
                active={hasSameStatuses(jobQuery.statuses, metric.statuses)}
                key={metric.label}
                metric={metric}
                onSelect={() => updateJobQuery({
                  ...jobQuery,
                  statuses: metric.statuses,
                })}
              />
            ))}
          </div>
          {(failedRunCount > 0 || failureFilterActive) && (
            <div className="px-5 pb-5">
              <JobFailureAlert
                active={failureFilterActive}
                count={failedRunCount}
                onToggle={toggleFailureFilter}
              />
            </div>
          )}
        </Panel>
        <JobsTableSection
          ariaLabel="ETL 작업 목록"
          emptyAction={hasSearchQuery ? <Button type="button" variant="outline" onClick={clearSearch}>검색어 지우기</Button> : undefined}
          emptyBody={hasSearchQuery ? "검색어와 일치하는 수집/처리 작업이 없습니다. 검색어를 지우거나 다른 작업명, 소스명, 타겟 데이터셋명을 입력해 보세요." : "소스 연결과 스키마 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다."}
          emptyTitle={hasSearchQuery ? "검색 결과가 없습니다." : undefined}
          jobs={filteredJobs}
          onCommand={handleJobCommand}
          onCreate={onCreate}
          onDetail={onDetail}
          onRuns={openLatestRunTimeline}
          toolbar={<JobsToolbar searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} />}
          statusFilters={jobQuery.statuses}
          scheduleKind={jobQuery.scheduleKind}
          owner={jobQuery.owner}
          owners={jobListFacets.owners}
          onStatusFilterChange={(statuses) => updateJobQuery({ ...jobQuery, statuses })}
          onScheduleKindChange={(scheduleKind) => updateJobQuery({ ...jobQuery, scheduleKind })}
          onOwnerChange={(owner) => updateJobQuery({ ...jobQuery, owner })}
          isLoading={jobsLoading}
          title="작업 목록"
        />
      </div>
      {latestRunModal && (
        <RunDagModal
          job={latestRunModal.job}
          onAction={onAction}
          onClose={() => setLatestRunModalSelection(null)}
          run={latestRunModal.run}
        />
      )}
    </div>
  );
}

function JobStatusFilterCard({
  active,
  metric,
  onSelect,
}: {
  active: boolean;
  metric: JobMetric;
  onSelect: () => void;
}) {
  const toneClassName: Record<JobMetricTone, { active: string; dot: string }> = {
    running: { active: "border-emerald-300 bg-emerald-50 text-emerald-950 ring-1 ring-emerald-200", dot: "bg-emerald-500" },
    scheduled: { active: "border-blue-300 bg-blue-50 text-blue-950 ring-1 ring-blue-200", dot: "bg-blue-500" },
    stopped: { active: "border-amber-300 bg-amber-50 text-amber-950 ring-1 ring-amber-200", dot: "bg-amber-500" },
    total: { active: "border-slate-400 bg-slate-100 text-slate-950 ring-1 ring-slate-300", dot: "bg-slate-500" },
  };
  const tone = toneClassName[metric.tone];

  return (
    <Button
      aria-pressed={active}
      className={`group h-[100px] min-w-0 items-stretch justify-start rounded-lg border px-5 py-4 text-left shadow-none transition-colors ${active ? tone.active : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"}`}
      type="button"
      variant="outline"
      onClick={onSelect}
    >
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span className="grid min-w-0 gap-1.5">
        <strong className="text-3xl font-bold leading-none tracking-normal text-slate-950">{metric.value}</strong>
        <span className="truncate text-base font-semibold tracking-normal">{metric.label}</span>
      </span>
    </Button>
  );
}

function JobFailureAlert({
  active,
  count,
  onToggle,
}: {
  active: boolean;
  count: number;
  onToggle: () => void;
}) {
  const hasFailures = count > 0;

  return (
    <Alert
      className="flex min-h-20 items-center gap-3 [&>svg]:static [&>svg~*]:pl-0"
      variant={hasFailures ? "destructive" : "default"}
    >
      <AlertCircle className="!size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <AlertTitle className="text-base">
          {hasFailures ? `마지막 실행이 실패한 작업이 ${count}개 있습니다.` : "현재 마지막 실행이 실패한 작업이 없습니다."}
        </AlertTitle>
        <AlertDescription>
          {hasFailures ? "실행 이력에서 실패 원인을 확인하거나 작업을 재실행할 수 있습니다." : "필터를 해제하면 전체 작업을 다시 볼 수 있습니다."}
        </AlertDescription>
      </div>
      <Button
        className={`!grid h-9 min-w-[124px] shrink-0 place-items-center px-0 text-sm leading-none ${hasFailures && !active ? "border-red-300 bg-white text-red-700 hover:border-red-400 hover:bg-red-100" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
        size="sm"
        type="button"
        variant="outline"
        onClick={onToggle}
      >
        <span className="block w-full text-center">{active ? "전체 작업 보기" : "실패 작업 보기"}</span>
      </Button>
    </Alert>
  );
}

function JobsToolbar({
  onSearchQueryChange,
  searchQuery,
}: {
  onSearchQueryChange: (value: string) => void;
  searchQuery: string;
}) {
  return (
    <FilterToolbar layout="actions">
      <FilterToolbarSearch className="min-h-12 text-base" icon={<Search size={20} />} size="compact">
        <FilterToolbarInput
          aria-label="수집/처리 작업 검색"
          autoComplete="off"
          className="text-lg"
          placeholder="작업명, 소스명, 타겟 데이터셋명 검색"
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
      </FilterToolbarSearch>
    </FilterToolbar>
  );
}

type JobsTableSectionProps = {
  ariaLabel: string;
  emptyAction?: React.ReactNode;
  emptyBody: string;
  emptyTitle?: string;
  jobs: JobRowData[];
  isLoading?: boolean;
  onCommand: (job: JobRowData, command: JobCommand) => Promise<void> | void;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onRuns: (job: JobRowData) => void;
  onScheduleKindChange?: (scheduleKind?: JobScheduleKind) => void;
  onStatusFilterChange?: (statuses?: JobStatus[]) => void;
  onOwnerChange?: (owner?: string) => void;
  owner?: string;
  owners?: string[];
  scheduleKind?: JobScheduleKind;
  statusFilters?: JobStatus[];
  title: string;
  toolbar?: React.ReactNode;
};

function JobStatusFilter({
  onValueChange,
  value,
}: {
  onValueChange?: (statuses?: JobStatus[]) => void;
  value?: JobStatus[];
}) {
  const selectedValue = value?.length === 1 ? value[0] : "all";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="작업 상태 필터"
          className="h-9 w-full justify-center gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
          size="sm"
          type="button"
          variant="ghost"
        >
          상태
          <Filter className="size-[18px]" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-40">
        <DropdownMenuLabel>작업 상태 필터</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={selectedValue}
          onValueChange={(nextValue) => onValueChange?.(nextValue === "all" ? undefined : [nextValue as JobStatus])}
        >
          <DropdownMenuRadioItem value="all">전체</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="scheduled">실행 대기</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="running">실행 중</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="stopped">자동 실행 중지</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunStatusFilter({
  counts,
  onValueChange,
  statuses,
  value,
}: {
  counts: Record<JobRunStatus, number>;
  onValueChange: (status: "all" | JobRunStatus) => void;
  statuses: JobRunStatus[];
  value: "all" | JobRunStatus;
}) {
  const totalCount = Object.values(counts).reduce((total, count) => total + count, 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="실행 상태 필터"
          className="h-8 w-full justify-center gap-1.5 px-0 text-base font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
          size="sm"
          type="button"
          variant="ghost"
        >
          상태
          <Filter className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-48">
        <DropdownMenuLabel>실행 상태 필터</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={(nextValue) => onValueChange(nextValue as "all" | JobRunStatus)}>
          <DropdownMenuRadioItem className="gap-2 text-base" value="all">
            <span className="size-2 rounded-full bg-slate-500" aria-hidden="true" />
            <span>전체</span>
            <span className="ml-auto text-sm font-semibold tabular-nums text-slate-500">{totalCount}</span>
          </DropdownMenuRadioItem>
          {statuses.map((status) => (
            <DropdownMenuRadioItem className="gap-2 text-base" key={status} value={status}>
              <span className={cn("size-2 rounded-full", getRunStatusFilterDotClassName(status))} aria-hidden="true" />
              <span>{runStatusMeta[status].label}</span>
              <span className="ml-auto text-sm font-semibold tabular-nums text-slate-500">{counts[status]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function JobOwnerFilter({
  onValueChange,
  owners,
  value,
}: {
  onValueChange?: (owner?: string) => void;
  owners: string[];
  value?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="소유자 필터"
          className="h-9 w-full justify-start gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
          size="sm"
          type="button"
          variant="ghost"
        >
          소유자
          <Filter className="size-[18px]" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>소유자 필터</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value ?? "all"} onValueChange={(nextValue) => onValueChange?.(nextValue === "all" ? undefined : nextValue)}>
          <DropdownMenuRadioItem value="all">전체</DropdownMenuRadioItem>
          {owners.map((owner) => <DropdownMenuRadioItem key={owner} value={owner}>{owner}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScheduleKindFilter({
  onValueChange,
  value,
}: {
  onValueChange?: (scheduleKind?: JobScheduleKind) => void;
  value?: JobScheduleKind;
}) {
  const selectedValue = value ?? "all";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="실행 주기 필터"
          className="h-9 w-full justify-start gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
          size="sm"
          type="button"
          variant="ghost"
        >
          실행 주기
          <Filter className="size-[18px]" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>실행 주기 필터</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={selectedValue}
          onValueChange={(nextValue) => onValueChange?.(nextValue === "all" ? undefined : nextValue as JobScheduleKind)}
        >
          <DropdownMenuRadioItem value="all">전체</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="daily">매일</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="weekly">매주</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="monthly">매월</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="realtime">실시간</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="none">스케줄 없음</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="other">기타</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function JobsTableSection({
  ariaLabel,
  emptyAction,
  emptyBody,
  emptyTitle,
  jobs,
  isLoading,
  onCommand,
  onCreate,
  onDetail,
  onRuns,
  onScheduleKindChange,
  onStatusFilterChange,
  onOwnerChange,
  owner,
  owners,
  scheduleKind,
  statusFilters,
  title,
  toolbar,
}: JobsTableSectionProps) {
  const tableRows = useMemo<JobsTableRow[]>(() => jobs.map((job) => ({ job })), [jobs]);
  const runAction = useCallback((action: JobListActionKind, job: JobRowData) => {
    if (action === "detail") {
      onDetail(job);
      return;
    }
    if (action === "runs") {
      onRuns(job);
      return;
    }
    onCommand(job, action);
  }, [onCommand, onDetail, onRuns]);
  const columns = useMemo<ColumnDef<JobsTableRow>[]>(() => [
    {
      accessorFn: (row) => row.job.status,
      cell: ({ row }) => <StatusPill job={row.original.job} />,
      header: () => onStatusFilterChange ? (
        <JobStatusFilter
          value={statusFilters}
          onValueChange={onStatusFilterChange}
        />
      ) : "상태",
      id: "status",
      enableSorting: false,
      meta: {
        align: "center",
        cellClassName: "h-px p-0",
        headerClassName: "text-lg",
        widthClassName: "w-[184px]",
      } satisfies DataTableColumnMeta,
    },
    {
      accessorFn: (row) => row.job.target,
      cell: ({ row }) => {
        const { job } = row.original;
        const { brandKind, path: sourcePath, type: sourceType } = getJobListSourceDisplay(job);

        return (
          <DataTableStackedCell className="gap-1.5">
            <DataTableCellPrimary className="text-xl leading-7">{job.target}</DataTableCellPrimary>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 cursor-help items-center gap-1.5 text-sm text-slate-500">
                  <SourceBrandIcon className="shrink-0" kind={brandKind} size={17} />
                  <span className="shrink-0 font-semibold">{sourceType}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-[480px]">
                <div className="grid gap-1">
                  <strong className="font-semibold">{sourceType}</strong>
                  <span className="break-all text-slate-200">{sourcePath}</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </DataTableStackedCell>
        );
      },
      header: "데이터셋",
      id: "dataset",
      meta: {
        headerClassName: "text-lg",
        widthClassName: "w-[300px]",
      } satisfies DataTableColumnMeta,
    },
    {
      accessorFn: (row) => row.job.schedule,
      cell: ({ row }) => <DataTableCellPrimary className="text-lg">{formatJobSchedule(row.original.job.schedule)}</DataTableCellPrimary>,
      header: () => onScheduleKindChange ? (
        <ScheduleKindFilter
          value={scheduleKind}
          onValueChange={onScheduleKindChange}
        />
      ) : "실행 주기",
      id: "schedule",
      enableSorting: false,
      meta: {
        headerClassName: "text-lg",
        widthClassName: "w-[150px]",
      } satisfies DataTableColumnMeta,
    },
    {
      accessorFn: (row) => getNextScheduledRunDate(row.job)?.getTime() ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => (
        <div className="flex min-h-[76px] items-center">
          <DataTableCellPrimary className="text-lg leading-7">{formatNextScheduledRun(row.original.job)}</DataTableCellPrimary>
        </div>
      ),
      header: "다음 예정 실행",
      id: "nextRun",
      meta: {
        headerClassName: "text-lg",
        widthClassName: "w-[180px]",
      } satisfies DataTableColumnMeta,
    },
    {
      accessorFn: (row) => row.job.lastRun,
      cell: ({ row }) => {
        const { job } = row.original;
        const latestRun = job.runHistory?.[0];

        return (
          <DataTableStackedCell className="relative min-h-[76px] gap-0">
            <div className="absolute left-0 top-1/2 flex min-w-0 -translate-y-1/2 items-center gap-2.5">
              <DataTableCellPrimary className="text-lg leading-7">{formatJobLastRun(job)}</DataTableCellPrimary>
              {getLatestRunOutcome(job) === "failed" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span aria-label="최근 실행 실패" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 ring-1 ring-red-100">
                      <AlertCircle className="size-[18px]" aria-hidden="true" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">최근 실행 실패</TooltipContent>
                </Tooltip>
              )}
              {getLatestRunOutcome(job) === "canceled" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span aria-label="최근 실행 취소" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 ring-1 ring-slate-200">
                      <X className="size-[18px]" aria-hidden="true" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">최근 실행 취소</TooltipContent>
                </Tooltip>
              )}
              {hasLatestSuccessfulRun(job) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span aria-label="최근 실행 성공" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
                      <Check className="size-[18px]" aria-hidden="true" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">최근 실행 성공</TooltipContent>
                </Tooltip>
              )}
            </div>
            <Button
              className="absolute left-0 top-[calc(50%+18px)] h-auto px-0 py-0 text-base"
              disabled={!latestRun}
              size="sm"
              title={latestRun ? "최근 실행 단계 보기" : "아직 실행 이력이 없습니다."}
              type="button"
              variant="link"
              onClick={() => onRuns(job)}
            >
              실행 기록 보기
            </Button>
          </DataTableStackedCell>
        );
      },
      header: "마지막 실행",
      id: "lastRun",
      meta: {
        headerClassName: "text-lg",
        widthClassName: "w-[260px]",
      } satisfies DataTableColumnMeta,
    },
    {
      accessorFn: (row) => row.job.owner,
      cell: ({ row }) => <OwnerIdentity job={row.original.job} />,
      header: () => onOwnerChange ? <JobOwnerFilter owners={owners ?? []} value={owner} onValueChange={onOwnerChange} /> : "소유자",
      id: "owner",
      enableSorting: false,
      meta: {
        headerClassName: "text-lg",
        widthClassName: "w-[220px]",
      } satisfies DataTableColumnMeta,
    },
  ], [onOwnerChange, onRuns, onScheduleKindChange, onStatusFilterChange, owner, owners, scheduleKind, statusFilters]);

  return (
    <TooltipProvider delayDuration={250}>
      <Panel aria-label={ariaLabel}>
        <PanelHeader
          className="min-h-[68px] [&_h2]:text-xl"
          icon={<ListChecks size={16} />}
          iconClassName="size-11 border border-blue-100 bg-white text-blue-700 shadow-sm [&_svg]:size-[22px]"
          title={title}
        />
        {toolbar}
        <DataTable
          className="gap-0 [&>div:last-child]:min-h-14 [&>div:last-child]:rounded-none [&>div:last-child]:border-x-0 [&>div:last-child]:border-b-0"
          columns={columns}
          data={tableRows}
          emptyState={{
            action: emptyAction ?? <Button type="button" onClick={onCreate}>새 수집/처리 생성</Button>,
            description: emptyBody,
            icon: <Plus size={22} />,
            title: emptyTitle ?? "생성된 수집/처리 작업이 없습니다.",
          }}
          getRowClassName={(row) => getJobTableRowClassName(row.original.job.status)}
          getRowId={(row) => row.job.id}
          isLoading={isLoading}
          pagination={{ label: title, pageSize: 5, showSummary: false }}
          renderRowActions={(row) => {
            const { job } = row.original;

            return (
              <div className="flex flex-wrap justify-center gap-1.5">
                {getJobListActions(job).map((action) => (
                  <Tooltip key={action.label}>
                    <TooltipTrigger asChild>
                      <IconButton
                        className={`[&_svg]:size-[18px] ${getJobListActionButtonClassName(action)}`}
                        label={action.label}
                        size="sm"
                        title=""
                        type="button"
                        variant={getJobActionButtonVariant(action.className)}
                        onClick={() => runAction(action.kind, job)}
                      >
                        <JobListActionIcon action={action} />
                      </IconButton>
                    </TooltipTrigger>
                    <TooltipContent side="top">{action.label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            );
          }}
          resetPaginationKey={jobs.length}
          rowActionsAlign="center"
          rowActionsClassName="w-[190px] text-lg"
          rowActionsHeader="액션"
          headerRowClassName="[&_th]:h-14 [&_th]:py-3 [&_th]:text-slate-600 [&_th_button]:text-slate-600 [&_th_svg]:text-slate-600"
          tableClassName="min-w-[1550px] table-fixed [&_td]:h-[120px] [&_thead_th_button]:gap-2 [&_thead_th_button_svg]:size-[18px]"
          viewportClassName="rounded-none border-0 bg-transparent"
        />
      </Panel>
    </TooltipProvider>
  );
}

type JobListActionKind = Exclude<JobCommand, "delete"> | "detail" | "runs";

type JobListAction = {
  className: string;
  kind: JobListActionKind;
  label: string;
};

type ScheduleControlAction = JobListAction & { kind: "stopSchedule" };
type IdleExecutionAction = JobListAction & { kind: "retry" | "run" };

function getJobListActions(job: JobRowData): JobListAction[] {
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

function isRealtimeJob(job: JobRowData) {
  const schedule = job.schedule.toLocaleLowerCase();
  return ["실시간", "realtime", "real-time", "stream", "kafka"].some((token) => schedule.includes(token));
}

function hasAutomaticSchedule(job: JobRowData) {
  const schedule = job.schedule.trim().toLocaleLowerCase();
  if (!schedule || schedule === "-") return false;
  return !["manual", "수동", "스케줄 없음", "건너뛰기"].some((token) => schedule.includes(token));
}

function getActiveScheduleAction(job: JobRowData): ScheduleControlAction | null {
  if (!hasAutomaticSchedule(job) || isRealtimeJob(job)) return null;
  return { className: "job-action-button warning", kind: "stopSchedule", label: "스케줄 일시중지" };
}

function getIdleExecutionAction(job: JobRowData): IdleExecutionAction {
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

function getJobListActionButtonClassName(action: { className: string }) {
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

type JobDetailAction = {
  className: string;
  kind: JobCommand;
  label: string;
};

function getJobDetailActions(job: JobRowData): JobDetailAction[] {
  if (isContinuousKafkaJob(job)) {
    const runtimeStatus = job.continuousRuntime?.status ?? "stopped";
    if (runtimeStatus === "stopping") {
      return [];
    }
    if (["starting", "running", "pausing"].includes(runtimeStatus)) {
      return [{ className: "job-action-button danger", kind: "stopContinuous", label: "스트림 중지" }];
    }
    return [{ className: "job-action-button primary", kind: "startContinuous", label: "스트림 시작" }, { className: "job-action-button", kind: "edit", label: "수정" }];
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

function JobDetailActionIcon({ action, job }: { action: JobDetailAction; job: JobRowData }) {
  if (action.kind === "edit") return <Pencil aria-hidden="true" />;
  if (action.kind === "delete") return <Trash2 aria-hidden="true" />;
  if (action.kind === "cancelRun") return <X aria-hidden="true" />;
  if (action.kind === "stopSchedule") return isRealtimeJob(job) ? <Square aria-hidden="true" /> : <CalendarOff aria-hidden="true" />;
  if (action.kind === "resumeSchedule") return <Calendar aria-hidden="true" />;
  if (action.kind === "retry") return <RefreshCw aria-hidden="true" />;
  if (isRealtimeJob(job)) return <Play aria-hidden="true" />;
  return <Zap aria-hidden="true" />;
}

function getJobDetailActionClassName(action: JobDetailAction) {
  if (action.kind === "delete" || action.kind === "cancelRun" || action.className.includes("realtime-stop")) {
    return "border-red-200 bg-red-50 text-red-700 shadow-sm hover:border-red-300 hover:bg-red-100";
  }
  return getJobListActionButtonClassName(action);
}

type JobsTableRow = {
  job: JobRowData;
};

function JobListActionIcon({ action }: { action: JobListAction }) {
  if (action.kind === "detail") return <Info aria-hidden="true" size={15} />;
  if (action.kind === "edit") return <Pencil aria-hidden="true" size={15} />;
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

function formatJobLastRun(job: JobRowData) {
  return formatCompactDateTime(job.lastRun);
}

type JobExecutionDisplay = {
  raw: string;
  stage: string;
  summary: string;
  tone: "danger" | "normal";
};

function getJobExecutionDisplay(job: JobRowData): JobExecutionDisplay {
  const problemRun = getLatestProblemRun(job);
  const problemStage = normalizeShortText(problemRun?.failedStage);
  const errorSummary = normalizeShortText(problemRun?.errorSummary);
  const rawCandidates = [job.lastState, problemRun?.errorSummary ?? ""].map((value) => value.trim()).filter(Boolean);
  const raw = rawCandidates.sort((first, second) => second.length - first.length)[0] ?? job.lastState;
  const latestOutcome = getLatestRunOutcome(job);
  const isProblem = latestOutcome === "failed" || latestOutcome === "canceled" || /실행 실패|취소됨/.test(job.lastState);
  const stage = problemStage && problemStage !== "-" ? problemStage : isProblem ? "실패 단계 미확인" : job.progress?.label ?? jobStatusMeta[job.status].summaryLabel;
  const fallbackSummary = isProblem ? compactLogSummary(raw) : normalizeWhitespace(job.lastState);
  const summarySource = errorSummary && errorSummary !== "-" && !isVerboseLogText(errorSummary) ? errorSummary : fallbackSummary;
  const normalizedSummary = summarySource === "실패" || summarySource === "FAILED" ? "실패 원인 확인 필요" : summarySource;
  const summary = truncateText(normalizedSummary || jobStatusMeta[job.status].summaryLabel, isProblem ? 72 : 58);
  return {
    raw: raw || "-",
    stage,
    summary,
    tone: isProblem ? "danger" : "normal",
  };
}

function getLatestProblemRun(job: JobRowData) {
  const latestRun = job.runHistory?.[0];
  return latestRun?.status === "failed" || latestRun?.status === "canceled" ? latestRun : undefined;
}

function getLatestRunOutcome(job: JobRowData): JobRunStatus | null {
  const latestRun = job.runHistory?.[0];
  if (latestRun && ["success", "failed", "canceled"].includes(latestRun.status)) return latestRun.status;
  if (/실행 실패/.test(job.lastState)) return "failed";
  if (/취소됨/.test(job.lastState)) return "canceled";
  return null;
}

function hasLatestSuccessfulRun(job: JobRowData) {
  const latestRun = job.runHistory?.[0];
  if (latestRun) return latestRun.status === "success";

  return /^(성공|success)$/i.test(normalizeWhitespace(job.lastState));
}

function normalizeShortText(value?: string) {
  if (!value) return "";
  return value.trim();
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isVerboseLogText(value: string) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length > 120) return true;
  return /warning:|exception|traceback|spark|ivy|\/opt\/spark|hadoop-aws|jar:file|download|successfully/i.test(normalized);
}

function formatCompactDateTime(value: string) {
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

function compactLogSummary(value: string) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized === "실패") return "실패 원인 확인 필요";

  const priorityPatterns = [
    /(Spark 실행 실패)/i,
    /([A-Za-z0-9_.]*(?:Exception|Error):\s*[^:]{8,120})/,
    /(Connection refused[^:]{0,100})/i,
    /(AccessDenied[^:]{0,100})/i,
    /(failed to [^:]{8,120})/i,
  ];
  const matched = priorityPatterns
    .map((pattern) => normalized.match(pattern)?.[1])
    .find(Boolean);

  return truncateText(matched ?? normalized, 72);
}

function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function StatusPill({ job }: { job: JobRowData }) {
  const showExecutionProgress = job.status === "running" && job.progress !== undefined;

  return (
    <div className={cn(
      "grid h-full min-w-[184px] justify-items-center px-3",
      showExecutionProgress
        ? "min-h-[132px] grid-rows-[1fr_auto] gap-2 pb-3 pt-5"
        : "min-h-[100px] content-center py-3",
    )}>
      <StatusBadge
        className={cn(
          "min-w-[160px] justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2.5 text-base font-semibold",
          showExecutionProgress && "self-end translate-y-0.5",
        )}
        tone={getJobStatusTone(job.status)}
      >
        {job.status === "running" && <Spinner className="size-4" aria-label="실행 중" />}
        {jobStatusMeta[job.status].label}
      </StatusBadge>
      {showExecutionProgress && job.progress ? (
        <div className="w-full self-end text-left">
          <Progress
            aria-label={`${job.progress.label} ${job.progress.value}%`}
            className="w-full"
            indicatorClassName="bg-green-500"
            value={job.progress.value}
          >
            <ProgressLabel className="text-left text-sm" title={job.progress.label}>{job.progress.label}</ProgressLabel>
            <ProgressValue className="text-right text-sm" />
          </Progress>
        </div>
      ) : null}
    </div>
  );
}

function OwnerIdentity({
  job,
  layout = "stacked",
}: {
  job: JobRowData;
  layout?: "header" | "stacked";
}) {
  const timestamp = job.updatedAt ?? job.createdAt;
  const timestampLabel = job.updatedAt ? "최근 수정" : "생성";

  if (layout === "header") {
    return (
      <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar size="lg">
            {job.ownerAvatarUrl && <AvatarImage alt={`${job.owner} 프로필`} src={job.ownerAvatarUrl} />}
            <AvatarFallback className="bg-slate-100 font-semibold text-slate-700 ring-1 ring-slate-200">
              {getIdentityInitials(job.owner)}
            </AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 gap-0.5 text-left">
            <span className="text-sm font-semibold text-slate-500">소유자</span>
            <span className="truncate text-base font-semibold text-slate-800" title={job.owner}>{job.owner}</span>
          </div>
        </div>
        {timestamp && (
          <div className="grid shrink-0 gap-0.5 text-right">
            <span className="text-sm font-semibold text-slate-500">{timestampLabel}</span>
            <time className="text-base font-medium tabular-nums text-slate-700" dateTime={timestamp} title={`${timestampLabel} ${timestamp}`}>
              {formatCompactDateTime(timestamp)}
            </time>
          </div>
        )}
      </div>
    );
  }

  return (
    <UserIdentity
      avatarUrl={job.ownerAvatarUrl}
      name={job.owner}
      secondary={timestamp ? `${timestampLabel} ${formatCompactDateTime(timestamp)}` : undefined}
    />
  );
}

function fallbackJobStats(job: JobRowData): JobStats {
  const runs = job.runHistory ?? [];
  const successRuns = runs.filter((run) => run.status === "success").length;
  const latestRun = runs[0];
  const lastSuccess = runs.find((run) => run.status === "success");

  return {
    averageDuration: latestRun?.duration ?? "-",
    currentStage: job.progress?.label ?? jobStatusMeta[job.status].summaryLabel,
    inputRows: latestRun?.inputRows ?? "-",
    lastSuccess: lastSuccess?.endedAt ?? "-",
    outputRows: latestRun?.outputRows ?? "-",
    sampleScope: "-",
    schemaColumns: "-",
    sourceUnits: "-",
    successRate: runs.length > 0 ? `${Math.round((successRuns / runs.length) * 100)}%` : "-",
    totalRuns: String(runs.length),
  };
}

function formatOperationalRate(value: number | null) {
  return value === null ? "-" : `${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function formatOperationalDelay(value: number | null) {
  if (value === null) return "-";
  if (value < 1000) return `${value.toLocaleString("ko-KR")}ms`;
  return `${(value / 1000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}초`;
}

const jobDetailFieldLabelMap: Record<string, string> = {
  Accept: "응답 형식",
  Aggregation: "집계 주기",
  Authentication: "인증",
  "Authentication Type": "인증 방식",
  "Broker / Endpoint": "브로커 / 엔드포인트",
  "Bootstrap Server": "부트스트랩 서버",
  Bucket: "버킷",
  "Bucket / Stage Name": "버킷 / 스테이지 이름",
  "CATALOG / NAMESPACE": "카탈로그 / 네임스페이스",
  Collection: "컬렉션",
  "Connection URI": "연결 URI",
  "Consumer Group": "컨슈머 그룹",
  "CONSUMER GROUP ID": "컨슈머 그룹 ID",
  "DATASET OR TABLE SELECTOR": "데이터셋 또는 테이블 선택자",
  Database: "데이터베이스",
  "DATABASE / SCHEMA": "데이터베이스 / 스키마",
  "Database Name": "데이터베이스 이름",
  Dataset: "데이터셋",
  Delimiter: "구분자",
  Encoding: "인코딩",
  Endpoint: "엔드포인트",
  "Endpoint / Host": "엔드포인트 / 호스트",
  "Endpoint URL": "엔드포인트 URL",
  "File Type": "파일 형식",
  Format: "파일 형식",
  Header: "헤더 처리",
  Host: "호스트",
  "Incremental Key": "증분 기준 키",
  "Lake Access": "레이크 접근",
  "Lake Type": "레이크 유형",
  "Message Format": "메시지 형식",
  Method: "메서드",
  Offset: "시작 오프셋",
  "Offset Policy": "오프셋 정책",
  "Pagination Strategy": "페이지네이션 방식",
  Path: "경로",
  "Path / Prefix": "경로 / 프리픽스",
  Port: "포트",
  Prefix: "경로 접두사",
  Region: "리전",
  "Root Path": "루트 경로",
  "Storage Provider": "스토리지 제공자",
  "Stream Type": "스트림 유형",
  Table: "테이블",
  Topic: "토픽",
  "TOPIC / QUEUE NAME": "토픽 / 큐 이름",
  Username: "사용자 이름",
  "Use Path Style": "Path Style 사용",
  Window: "집계 범위",
};

const hiddenJobDetailFieldLabels = new Set([
  "Access Key",
  "Password / Auth Token",
  "Secret Key",
  "Token / Secret",
]);

function getJobDetailFieldLabel(label: string) {
  return jobDetailFieldLabelMap[label] ?? label;
}

function isVisibleJobDetailField(label: string) {
  return !label.startsWith("__") && !hiddenJobDetailFieldLabels.has(label);
}

type JobEndpointItem = {
  label: string;
  value: string;
};

function sourceConfigValue(job: JobRowData, labels: string[]) {
  const values = new Map(job.sourceConfig ?? []);
  for (const label of labels) {
    const value = values.get(label)?.trim();
    if (value) return value;
  }
  return "";
}

function inferSourceFileFormat(job: JobRowData, sourcePath: string) {
  const configuredFormat = sourceConfigValue(job, ["File Type", "Format"]);
  if (configuredFormat && configuredFormat.toLowerCase() !== "auto") return configuredFormat;

  const normalizedPath = sourcePath.split(/[?#]/)[0].toLowerCase();
  if (normalizedPath.endsWith(".parquet")) return "Parquet";
  if (normalizedPath.endsWith(".csv")) return "CSV";
  if (normalizedPath.endsWith(".jsonl") || normalizedPath.endsWith(".ndjson")) return "JSONL";
  if (normalizedPath.endsWith(".json")) return "JSON";
  if (normalizedPath.endsWith(".avro")) return "Avro";
  return configuredFormat;
}

function inferObjectSourceScope(sourcePath: string) {
  if (/[*?{}]/.test(sourcePath)) return "경로 패턴";
  const normalizedPath = sourcePath.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  if (/\.(avro|csv|json|jsonl|ndjson|orc|parquet)$/.test(normalizedPath)) return "단일 파일";
  return "폴더 / 프리픽스";
}

function inferSourceReadMode(job: JobRowData, sourceType: string) {
  const configuredMode = sourceConfigValue(job, ["Read Mode", "읽기 방식"]);
  if (configuredMode) return configuredMode;
  if (sourceType.includes("kafka") || sourceType.includes("stream")) return "연속 수집";
  if (sourceConfigValue(job, ["Incremental Key", "Offset Policy", "Offset"])) return "증분 수집";
  return "전체 스캔";
}

function compactSourceConfigItems(job: JobRowData, rawSourceType: string, sourcePath: string): JobEndpointItem[] {
  const sourceType = rawSourceType.toLowerCase();
  const item = (label: string, value: string): JobEndpointItem | null => value ? { label, value } : null;
  const compact = (items: Array<JobEndpointItem | null>) => items.filter((value): value is JobEndpointItem => Boolean(value));

  if (sourceType.includes("file") || sourceType.includes("s3") || sourceType.includes("minio")) {
    const fileFormat = inferSourceFileFormat(job, sourcePath);
    const isCsv = fileFormat.toLowerCase() === "csv";
    return compact([
      item("소스 경로", sourcePath),
      item("파일 형식", fileFormat),
      item("읽기 범위", inferObjectSourceScope(sourcePath)),
      item("읽기 방식", inferSourceReadMode(job, sourceType)),
      isCsv ? item("구분자", sourceConfigValue(job, ["Delimiter"])) : null,
      isCsv ? item("헤더 처리", sourceConfigValue(job, ["Header"])) : null,
    ]);
  }

  if (sourceType.includes("kafka") || sourceType.includes("stream")) {
    return compact([
      item("브로커 / 엔드포인트", sourceConfigValue(job, ["Broker / Endpoint", "Bootstrap Server"])),
      item("토픽", sourceConfigValue(job, ["TOPIC / QUEUE NAME", "Topic"])),
      item("컨슈머 그룹", sourceConfigValue(job, ["CONSUMER GROUP ID", "Consumer Group"])),
      item("메시지 형식", sourceConfigValue(job, ["Message Format", "Format"])),
      item("시작 오프셋", sourceConfigValue(job, ["Offset Policy", "Offset"])),
      item("수집 방식", inferSourceReadMode(job, sourceType)),
    ]);
  }

  if (sourceType.includes("postgres") || sourceType.includes("mysql") || sourceType.includes("database")) {
    return compact([
      item("호스트", sourceConfigValue(job, ["Host", "Endpoint / Host"])),
      item("데이터베이스", sourceConfigValue(job, ["Database", "Database Name"])),
      item("테이블", sourceConfigValue(job, ["Table", "DATASET OR TABLE SELECTOR"])),
      item("읽기 방식", inferSourceReadMode(job, sourceType)),
      item("증분 기준 키", sourceConfigValue(job, ["Incremental Key"])),
    ]);
  }

  if (sourceType.includes("mongo")) {
    return compact([
      item("엔드포인트 / 호스트", sourceConfigValue(job, ["Endpoint / Host", "Host", "Endpoint"])),
      item("데이터베이스", sourceConfigValue(job, ["Database Name", "Database"])),
      item("컬렉션", sourceConfigValue(job, ["Collection"])),
      item("읽기 방식", inferSourceReadMode(job, sourceType)),
      item("증분 기준 키", sourceConfigValue(job, ["Incremental Key"])),
    ]);
  }

  if (sourceType.includes("sql result")) {
    return compact([
      item("소스 데이터셋", sourceConfigValue(job, ["Source Dataset"])),
      item("SQL 실행 ID", sourceConfigValue(job, ["SQL Run ID"])),
    ]);
  }

  const fallbackItems = (job.sourceConfig ?? [])
    .filter(([label, value]) => isVisibleJobDetailField(label) && value.trim())
    .slice(0, 4)
    .map(([label, value]) => ({ label: getJobDetailFieldLabel(label), value }));
  return fallbackItems.length > 0 ? fallbackItems : [{ label: "소스 경로", value: sourcePath }];
}

function getJobListSourceDisplay(job: JobRowData) {
  const sourceParts = job.source
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean);
  const rawType = job.sourceType?.trim()
    || (sourceParts[0] === "File" && sourceParts[1] === "S3" ? "File / S3" : sourceParts[0])
    || "소스";
  const inferredPath = rawType === "File / S3" && sourceParts[0] === "File" && sourceParts[1] === "S3"
    ? sourceParts.slice(2).join(" / ")
    : sourceParts.slice(1).join(" / ");

  const path = job.sourceLabel?.trim() || inferredPath || job.source;

  const brand = getSourceBrandMeta(rawType);

  return {
    brandKind: brand.kind,
    path,
    type: brand.label,
  };
}

const ruleActionLabelMap: Record<string, string> = {
  "Drop Row": "행 제외",
  "Fail Run": "실행 실패 처리",
  Quarantine: "격리",
  "Set Null": "NULL 처리",
  Warn: "경고 기록",
};

const validationTypeLabelMap: Record<string, string> = {
  "Accepted Values": "허용값 검사",
  "Not Null": "NULL 불가",
  "Range Check": "범위 검사",
  "Regex Match": "정규식 검사",
};

function getRuleActionLabel(value: string) {
  return ruleActionLabelMap[value] ?? value;
}

const detailKeyValueListClassName = "grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2 [&>div]:min-w-0 [&_dt]:mb-1.5 [&_dt]:text-sm [&_dt]:font-bold [&_dt]:text-slate-500 [&_dd]:m-0 [&_dd]:text-base [&_dd]:font-semibold [&_dd]:leading-7 [&_dd]:text-slate-900 [&_dd]:[overflow-wrap:anywhere]";
const endpointKeyValueListClassName = "grid grid-cols-1 gap-x-8 sm:grid-cols-2 [&>div]:min-w-0 [&>div]:border-b [&>div]:border-slate-100 [&>div]:py-4 [&_dt]:mb-1.5 [&_dt]:text-sm [&_dt]:font-bold [&_dt]:text-slate-500 [&_dd]:m-0 [&_dd]:text-base [&_dd]:font-semibold [&_dd]:leading-7 [&_dd]:text-slate-950 [&_dd]:[overflow-wrap:anywhere]";

function JobEndpointCard({
  badge,
  icon,
  items,
  tone,
  title,
}: {
  badge: string;
  icon: React.ReactNode;
  items: KeyValueListItem[];
  tone: "source" | "target";
  title: string;
}) {
  const isSource = tone === "source";

  return (
    <Card
      className={`relative h-full overflow-hidden border-slate-200 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.45)] before:absolute before:inset-x-0 before:top-0 before:h-0.5 ${isSource ? "before:bg-blue-500" : "before:bg-emerald-500"}`}
      size="none"
    >
      <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-4">
        <span className={`grid size-11 place-items-center rounded-md ring-1 ring-inset ${isSource ? "bg-blue-50 text-blue-600 ring-blue-100" : "bg-emerald-50 text-emerald-600 ring-emerald-100"}`}>
          {icon}
        </span>
        <CardTitle className="text-lg font-extrabold">{title}</CardTitle>
        <Badge shape="compact" size="lg" variant={isSource ? "default" : "success"}>{badge}</Badge>
      </CardHeader>
      <CardContent className="px-5 pb-5 !pt-3">
        <KeyValueList className={endpointKeyValueListClassName} items={items} />
      </CardContent>
    </Card>
  );
}

type OutputSchemaRow = {
  field: string;
  index: number;
  sample: string;
  type: string;
};

type TransformRuleRow = {
  enabled: boolean;
  index: number;
  input: string;
  label: string;
  onError: string;
  operation: string;
  output: string;
  params: string;
};

type QualityRuleRow = {
  enabled: boolean;
  failureAction: string;
  severity: string;
  targetColumn: string;
  validationType: string;
};

const outputSchemaColumns: ColumnDef<OutputSchemaRow>[] = [
  {
    accessorKey: "index",
    header: "순서",
    meta: { align: "center", widthClassName: "w-[80px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "field",
    header: "출력 필드",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-bold">{row.original.field}</DataTableCellPrimary>,
  },
  {
    accessorKey: "type",
    header: "타입",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant="muted">{row.original.type}</Badge>,
  },
  {
    accessorKey: "sample",
    header: "샘플",
    cell: ({ row }) => (
      <span className="block max-w-[280px] truncate text-base font-medium text-slate-700" title={row.original.sample}>
        {row.original.sample}
      </span>
    ),
  },
];

function TransformRuleSettingsAction({ rule }: { rule: TransformRuleRow }) {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex h-auto items-center justify-center whitespace-nowrap p-0 text-base font-semibold text-blue-600 underline-offset-4 transition-colors hover:text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
        설정 보기
      </DialogTrigger>
      <DialogContent
        closeLabel="닫기"
        className="max-h-[calc(100vh-2rem)] w-[min(calc(100vw-2rem),48rem)] gap-0 overflow-hidden p-0"
      >
        <header className="grid min-w-0 gap-1.5 border-b border-slate-200 px-6 py-5 pr-16">
          <span className="text-xs font-black uppercase tracking-normal text-blue-600">변환 규칙 {rule.index}</span>
          <DialogTitle className="text-xl font-extrabold leading-tight">{rule.label}</DialogTitle>
          <DialogDescription>{rule.operation}</DialogDescription>
        </header>
        <div className="grid min-h-0 gap-5 overflow-y-auto px-6 py-5">
          <KeyValueList
            className={detailKeyValueListClassName}
            items={[
              { label: "입력", value: rule.input },
              { label: "출력", value: rule.output },
              { label: "오류 처리", value: rule.onError },
              { label: "상태", value: rule.enabled ? "활성" : "비활성" },
            ]}
          />
          <section className="grid min-w-0 gap-3">
            <h3 className="text-base font-extrabold text-slate-950">설정</h3>
            <pre className="max-h-[320px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100">
              {rule.params || "설정 없음"}
            </pre>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const transformRuleColumns: ColumnDef<TransformRuleRow>[] = [
  {
    accessorKey: "index",
    header: "순서",
    meta: { align: "center", widthClassName: "w-[64px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "label",
    header: "변환 규칙",
    cell: ({ row }) => (
      <DataTableStackedCell className="min-w-[170px] gap-1">
        <DataTableCellPrimary className="text-base font-bold">{row.original.label}</DataTableCellPrimary>
        <DataTableCellSecondary className="text-[13px] font-semibold">{row.original.operation}</DataTableCellSecondary>
      </DataTableStackedCell>
    ),
    meta: { widthClassName: "w-[190px]" } satisfies DataTableColumnMeta,
  },
  {
    id: "mapping",
    header: "입력 → 출력",
    cell: ({ row }) => {
      const mapping = `${row.original.input} → ${row.original.output}`;
      return (
        <DataTableCellPrimary className="block max-w-[260px] truncate text-base font-semibold" title={mapping}>
          {mapping}
        </DataTableCellPrimary>
      );
    },
    meta: { widthClassName: "w-[280px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "onError",
    header: "오류 처리",
    cell: ({ row }) => <DataTableCellPrimary className="whitespace-nowrap text-base font-medium text-slate-700">{row.original.onError}</DataTableCellPrimary>,
    meta: { widthClassName: "w-[140px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "enabled",
    header: "상태",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.enabled ? "success" : "muted"}>{row.original.enabled ? "활성" : "비활성"}</Badge>,
    meta: { widthClassName: "w-[96px]" } satisfies DataTableColumnMeta,
  },
  {
    id: "settings",
    header: "상세",
    cell: ({ row }) => <TransformRuleSettingsAction rule={row.original} />,
    meta: { align: "center", widthClassName: "w-[112px]" } satisfies DataTableColumnMeta,
  },
];

const qualityRuleColumns: ColumnDef<QualityRuleRow>[] = [
  {
    accessorKey: "targetColumn",
    header: "대상 컬럼",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-bold">{row.original.targetColumn}</DataTableCellPrimary>,
    meta: {
      cellClassName: "pl-10",
      headerClassName: "pl-10",
    } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "validationType",
    header: "검증 규칙",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-medium text-slate-700">{row.original.validationType}</DataTableCellPrimary>,
  },
  {
    accessorKey: "severity",
    header: "심각도",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.severity === "오류" ? "destructive" : "warning"}>{row.original.severity}</Badge>,
  },
  {
    accessorKey: "failureAction",
    header: "실패 시",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-medium text-slate-700">{row.original.failureAction}</DataTableCellPrimary>,
  },
  {
    accessorKey: "enabled",
    header: "상태",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.enabled ? "success" : "muted"}>{row.original.enabled ? "활성" : "비활성"}</Badge>,
  },
];

function OperationSummaryItem({
  detail,
  label,
  tone = "default",
  value,
}: {
  detail: string;
  label: string;
  tone?: "danger" | "default" | "running" | "scheduled";
  value: string;
}) {
  const accentClassName = tone === "danger"
    ? "border-red-400"
    : tone === "running"
      ? "border-emerald-400"
      : tone === "scheduled"
        ? "border-blue-400"
        : "border-slate-300";

  return (
    <div className={`grid min-w-0 content-start gap-1 border-l-2 pl-3 ${accentClassName}`}>
      <span className="text-sm font-bold text-slate-500">{label}</span>
      <strong className="text-lg font-extrabold leading-snug text-slate-950 [overflow-wrap:anywhere]">{value}</strong>
      <span className="text-sm font-semibold leading-snug text-slate-500 [overflow-wrap:anywhere]">{detail}</span>
    </div>
  );
}

function PipelineFlowNode({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="grid min-h-24 min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 rounded-md border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <span className="grid size-10 place-items-center rounded-md bg-blue-50 text-blue-600">
        {icon}
      </span>
      <div className="grid min-w-0 gap-1 text-left">
        <span className="text-sm font-extrabold text-slate-500">{label}</span>
        <strong className="text-lg font-extrabold leading-snug text-slate-950 [overflow-wrap:anywhere]">{value}</strong>
      </div>
    </div>
  );
}

function JobDetailHeader({
  backLabel,
  job,
  onBack,
  onCommand,
}: {
  backLabel: string;
  job: JobRowData;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
}) {
  const runAction = (action: JobCommand) => {
    onCommand(job, action);
  };

  return (
    <div className="grid gap-4">
      <Button className="w-fit justify-start text-slate-500 hover:text-slate-900" size="content" type="button" variant="link" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        {backLabel}
      </Button>
      <PageHeader
        actions={(
          <div className="grid max-w-full justify-items-end gap-3">
            <ActionGroup density="compact">
              {getJobDetailActions(job).map((action) => (
                <Button
                  className={getJobDetailActionClassName(action)}
                  key={action.label}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => runAction(action.kind)}
                >
                  <JobDetailActionIcon action={action} job={job} />
                  {action.label}
                </Button>
              ))}
            </ActionGroup>
            <OwnerIdentity job={job} layout="header" />
          </div>
        )}
        icon={<Database aria-hidden="true" size={26} />}
        iconClassName="size-14 rounded-xl"
        leadingAlign="center"
        title={(
          <>
            <span>{job.target}</span>
            <StatusBadge className="min-w-0 justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-semibold" tone={getJobStatusTone(job.status)}>
              {job.status === "running" && <Spinner className="size-3.5" aria-label="실행 중" />}
              {jobStatusMeta[job.status].label}
            </StatusBadge>
          </>
        )}
        titleClassName="flex flex-wrap items-center gap-3 text-3xl font-bold"
        variant="bordered"
      />
    </div>
  );
}

export function JobDetailPage({
  job,
  onBack,
  onCommand,
  onRuns,
}: {
  job: JobRowData;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onRuns: () => void;
}) {
  const rawSourceType = job.sourceType ?? job.source.split(" / ")[0] ?? job.source;
  const sourceType = getSourceBrandMeta(rawSourceType).label;
  const sourcePath = job.sourceLabel ?? (job.source.split(" / ").slice(1).join(" / ") || job.source);
  const stats = { ...fallbackJobStats(job), ...(job.stats ?? {}) };
  const realtime = isRealtimeJob(job);
  const totalRuns = String(stats.totalRuns ?? "-");
  const totalRunsLabel = totalRuns === "-" || totalRuns.endsWith("회") ? totalRuns : `${totalRuns}회`;
  const realtimeMetrics = job.operationalMetrics?.metricType === "realtime" ? job.operationalMetrics : undefined;
  const realtimeHealth = realtimeHealthMeta[realtimeMetrics?.healthStatus ?? "unknown"];
  const physicalOutputPath = job.targetPath ?? stats.outputPath ?? `lake/${job.target}`;
  const executionDisplay = getJobExecutionDisplay(job);
  const latestRun = job.runHistory?.[0];
  const activeRun = latestRun?.status === "running" ? latestRun : undefined;
  const latestRunTimestamp = latestRun?.endedAt || latestRun?.startedAt || job.lastRun;
  const processSummary = job.transformSteps?.length
    ? `${job.transformSteps.length}개 변환 규칙`
    : "처리 설정 적용";
  const currentStatusTone = job.status === "failed"
    ? "danger"
    : job.status === "running"
      ? "running"
      : "scheduled";
  const currentStatusDetail = job.status === "failed"
    ? executionDisplay.summary
    : job.status === "running"
      ? job.progress?.label ?? "처리 진행 중"
      : job.status === "paused"
        ? "수동 재개 필요"
        : job.status === "stopped"
          ? realtime ? "실시간 수집 중지" : "스케줄 일시중지"
          : job.status === "canceled"
            ? "최근 실행 취소"
            : "자동 실행 활성";
  const outputSchemaRows: OutputSchemaRow[] = (job.transformOutputColumns ?? []).map(([field, type], index) => ({
    field,
    index: index + 1,
    sample: job.schemaSampleValues?.[field] ?? "-",
    type,
  }));
  const transformRuleRows: TransformRuleRow[] = (job.transformSteps ?? []).map((step, index) => ({
    enabled: step.enabled,
    index: index + 1,
    input: step.input,
    label: step.label,
    onError: getRuleActionLabel(step.onError),
    operation: step.operation,
    output: step.output,
    params: step.params,
  }));
  const qualityRuleRows: QualityRuleRow[] = (job.qualityRules ?? []).map((rule) => ({
    enabled: rule.enabled,
    failureAction: getRuleActionLabel(rule.failureAction),
    severity: rule.severity === "Error" ? "오류" : "경고",
    targetColumn: rule.targetColumn,
    validationType: validationTypeLabelMap[rule.validationType] ?? rule.validationType,
  }));
  const activePermissionRoles = (job.permissionRoles ?? []).filter((role) => role.checked);
  const permissionRoleNames = (accessNames: string[]) => activePermissionRoles
    .filter((role) => accessNames.some((accessName) => role.access.includes(accessName)))
    .map((role) => role.name)
    .join(", ") || "설정 없음";
  const retrySummary = job.retryPolicySummary ?? (job.retryPolicy
    ? `${job.retryPolicy.maxRetries}회 · ${job.retryPolicy.backoffStrategy === "exponential" ? "지수" : "고정"} 백오프`
    : "설정 없음");
  const sourceDetailItems = compactSourceConfigItems(job, rawSourceType, sourcePath);
  const targetDetailItems: JobEndpointItem[] = [
    { label: "데이터셋", value: job.target },
    { label: "저장소", value: job.storageType ?? "설정 없음" },
    { label: "저장 경로", value: job.storagePath ?? physicalOutputPath },
    { label: "압축", value: job.compression ?? "사용 안 함" },
    ...(job.partition?.trim() ? [{ label: "파티션", value: job.partition }] : []),
  ];

  return (
    <div className="job-detail-page">
      <JobDetailHeader backLabel="작업 목록으로 돌아가기" job={job} onBack={onBack} onCommand={onCommand} />

      <Panel overflow="visible">
        <PanelHeader
          actions={(
            <Button size="sm" type="button" variant="outline" onClick={onRuns}>
              실행 이력 보기
              <ArrowRight aria-hidden="true" />
            </Button>
          )}
          icon={<BarChart3 aria-hidden="true" size={18} />}
          title="운영 요약"
        />
        <div className="grid gap-5 p-5">
          <div className="rounded-lg border border-slate-200 bg-transparent p-3">
            <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
              <PipelineFlowNode
                icon={<Database aria-hidden="true" className="size-5" />}
                label="소스"
                value={`${sourceType} · ${sourcePath}`}
              />
              <span className="hidden items-center justify-center px-1 text-slate-400 md:flex">
                <ArrowRight aria-hidden="true" className="size-5" />
              </span>
              <PipelineFlowNode
                icon={<Settings aria-hidden="true" className="size-5" />}
                label="처리"
                value={processSummary}
              />
              <span className="hidden items-center justify-center px-1 text-slate-400 md:flex">
                <ArrowRight aria-hidden="true" className="size-5" />
              </span>
              <PipelineFlowNode
                icon={<Table2 aria-hidden="true" className="size-5" />}
                label="타겟"
                value={job.target}
              />
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <OperationSummaryItem
              detail={currentStatusDetail}
              label="현재 상태"
              tone={currentStatusTone}
              value={jobStatusMeta[job.status].label}
            />
            <OperationSummaryItem
              detail={activeRun
                ? activeRun.runId
                : latestRun
                  ? `${formatCompactDateTime(latestRunTimestamp)} · ${latestRun.duration}`
                  : "실행 기록 없음"}
              label={activeRun ? "현재 Run" : "최근 실행"}
              tone={latestRun?.status === "failed" ? "danger" : latestRun?.status === "running" ? "running" : "default"}
              value={activeRun ? `${formatCompactDateTime(activeRun.startedAt)} 시작` : latestRun ? runStatusMeta[latestRun.status].label : "-"}
            />
            <OperationSummaryItem
              detail={realtime ? job.scheduleSummary ?? formatJobSchedule(job.schedule) : formatJobSchedule(job.schedule)}
              label={realtime ? "수집 방식" : "다음 실행"}
              tone="scheduled"
              value={realtime ? "실시간" : formatNextScheduledRun(job)}
            />
            {realtime ? (
              <OperationSummaryItem
                detail={realtimeMetrics
                  ? `가동률 ${formatOperationalRate(realtimeMetrics.availabilityRate)} · 처리 지연 ${formatOperationalDelay(realtimeMetrics.processingDelayMs)}`
                  : "실시간 지표 API 연동 대기"}
                label="수집 안정성"
                tone={realtimeHealth.tone}
                value={realtimeHealth.label}
              />
            ) : (
              <OperationSummaryItem
                detail={`${totalRunsLabel} 실행 · 평균 ${stats.averageDuration}`}
                label="실행 안정성"
                value={stats.successRate}
              />
            )}
          </div>
        </div>
      </Panel>

      {isContinuousKafkaJob(job) && <ContinuousRuntimeCard job={job} />}

      <Accordion className="grid gap-4" defaultValue={["source-target", "schema-transform"]} type="multiple">
        <AccordionItem className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" value="source-target">
          <AccordionTrigger className="h-[72px] min-h-0 px-5 py-0 text-base">
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 text-left">
              <span className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-600">
                <Repeat2 aria-hidden="true" className="size-[18px]" />
              </span>
              <span className="grid min-w-0 gap-1">
                <span className="text-base font-[850] leading-tight text-slate-900">소스 / 타겟</span>
                <span className="text-sm font-semibold text-slate-500">{sourceType} → {job.targetFormat ?? "데이터셋"}</span>
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="grid items-stretch gap-4 border-t border-slate-100 p-4 lg:grid-cols-2">
            <JobEndpointCard
              badge={sourceType}
              icon={<Database aria-hidden="true" className="size-5" />}
              items={sourceDetailItems}
              title="소스"
              tone="source"
            />

            <JobEndpointCard
              badge={job.targetFormat ?? "데이터셋"}
              icon={<Table2 aria-hidden="true" className="size-5" />}
              items={targetDetailItems}
              title="타겟"
              tone="target"
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" value="schema-transform">
          <AccordionTrigger className="h-[72px] min-h-0 px-5 py-0 text-base">
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 text-left">
              <span className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-600">
                <ShieldCheck aria-hidden="true" className="size-[18px]" />
              </span>
              <span className="grid min-w-0 gap-1">
                <span className="text-base font-[850] leading-tight text-slate-900">스키마 / 변환 / 품질</span>
                <span className="text-sm font-semibold text-slate-500">{outputSchemaRows.length}개 컬럼 · 변환 {transformRuleRows.length}개 · 품질 규칙 {qualityRuleRows.length}개</span>
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="grid gap-5 border-t border-slate-100 p-4">
            <DetailTableSection
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
              headerClassName="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200 px-5 [&_h3]:text-base [&_h3]:font-extrabold [&_h3]:text-slate-950"
              meta={<Badge shape="compact" size="lg" variant="muted">{outputSchemaRows.length}개 컬럼</Badge>}
              title="출력 스키마"
            >
              <DataTable
                bodyRowClassName="[&_td]:py-4"
                className="[&_th]:text-sm [&_td]:text-base"
                columns={outputSchemaColumns}
                data={outputSchemaRows}
                emptyState={{ title: "저장된 출력 스키마가 없습니다." }}
                enableSorting={false}
                pagination={false}
                tableClassName="min-w-[680px]"
                viewportClassName="rounded-none border-0"
              />
            </DetailTableSection>

            <DetailTableSection
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
              headerClassName="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200 px-5 [&_h3]:text-base [&_h3]:font-extrabold [&_h3]:text-slate-950"
              meta={<Badge shape="compact" size="lg" variant="muted">{transformRuleRows.length}개 규칙</Badge>}
              title="변환 규칙"
            >
              <DataTable
                bodyRowClassName="[&_td]:py-4"
                className="[&_th]:text-sm [&_td]:text-base"
                columns={transformRuleColumns}
                data={transformRuleRows}
                emptyState={{ title: "저장된 변환 규칙이 없습니다." }}
                enableSorting={false}
                pagination={transformRuleRows.length > 5 ? { label: "변환 규칙", pageSize: 5, showPageSize: false, showSummary: true } : false}
                tableClassName="min-w-[860px] table-fixed"
                viewportClassName="rounded-none border-0"
              />
            </DetailTableSection>

            <DetailTableSection
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
              headerClassName="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200 px-5 [&_h3]:text-base [&_h3]:font-extrabold [&_h3]:text-slate-950"
              meta={<Badge shape="compact" size="lg" variant="muted">{qualityRuleRows.length}개 규칙</Badge>}
              title="품질 규칙"
            >
              <DataTable
                bodyRowClassName="[&_td]:py-4"
                className="[&_th]:text-sm [&_td]:text-base"
                columns={qualityRuleColumns}
                data={qualityRuleRows}
                emptyState={{ title: "저장된 품질 규칙이 없습니다." }}
                enableSorting={false}
                pagination={false}
                tableClassName="min-w-[760px]"
                viewportClassName="rounded-none border-0"
              />
            </DetailTableSection>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" value="schedule-permission">
          <AccordionTrigger className="h-[72px] min-h-0 px-5 py-0 text-base">
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 text-left">
              <span className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-600">
                <Calendar aria-hidden="true" className="size-[18px]" />
              </span>
              <span className="grid min-w-0 gap-1">
                <span className="text-base font-[850] leading-tight text-slate-900">스케줄 / 권한</span>
                <span className="text-sm font-semibold text-slate-500">{formatJobSchedule(job.schedule)} · 역할별 접근 권한</span>
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="grid gap-5 border-t border-slate-100 p-5 lg:grid-cols-2">
            <section className="grid content-start gap-5 rounded-lg bg-slate-50 p-5 ring-1 ring-inset ring-slate-200">
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-lg bg-blue-100/70 text-blue-600">
                  <Calendar className="size-5" aria-hidden="true" />
                </span>
                <h3 className="text-lg font-extrabold text-slate-950">스케줄</h3>
              </div>
              <KeyValueList
                className={detailKeyValueListClassName}
                items={[
                  { label: "실행 유형", value: isRealtimeJob(job) ? "실시간 수집" : getJobScheduleKind(job) === "none" ? "수동 실행" : "반복 스케줄" },
                  { label: "주기", value: formatJobSchedule(job.schedule) },
                  { label: "다음 실행", value: formatNextScheduledRun(job) },
                  { label: "재시도 정책", value: retrySummary },
                ]}
              />
            </section>

            <section className="grid content-start gap-5 rounded-lg bg-slate-50 p-5 ring-1 ring-inset ring-slate-200">
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-lg bg-blue-100/70 text-blue-600">
                  <ShieldCheck className="size-5" aria-hidden="true" />
                </span>
                <h3 className="text-lg font-extrabold text-slate-950">권한</h3>
              </div>
              <KeyValueList
                className={detailKeyValueListClassName}
                items={[
                  { label: "소유자", value: job.owner },
                  { label: "조회 가능", value: permissionRoleNames(["조회", "view", "read"]) },
                  { label: "쿼리 실행 가능", value: permissionRoleNames(["쿼리 실행", "query"]) },
                  { label: "메타데이터 조회", value: permissionRoleNames(["메타데이터", "metadata"]) },
                  { label: "관리 가능", value: permissionRoleNames(["관리", "manage"]) },
                ]}
              />
            </section>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function ContinuousRuntimeCard({ job }: { job: JobRowData }) {
  const runtime = job.continuousRuntime;
  const ruleMetrics = runtime?.ruleMetrics ?? {};
  const maintenanceBlocked = runtime ? !["paused", "stopped"].includes(runtime.status) : true;
  const [logs, setLogs] = useState<string[]>([]);
  const [logError, setLogError] = useState("");
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [quarantine, setQuarantine] = useState<ContinuousQuarantineRecord[]>([]);
  const [maintenanceRuns, setMaintenanceRuns] = useState<ContinuousMaintenanceRun[]>([]);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    setLogError("");
    try {
      setLogs((await getContinuousWorkerLogs(job.id, 100)).lines);
    } catch (error) {
      setLogError(error instanceof Error ? error.message : "Worker 로그를 불러오지 못했습니다.");
    } finally {
      setLoadingLogs(false);
    }
  }, [job.id]);
  useEffect(() => { void loadLogs(); }, [loadLogs]);
  const refreshMaintenance = useCallback(async () => {
    try {
      const runs = await getContinuousMaintenanceRuns(job.id);
      setMaintenanceRuns(runs);
      if (maintenanceBlocked) {
        setQuarantine([]);
      } else {
        setQuarantine((await getContinuousQuarantine(job.id, 25)).records);
      }
    } catch (error) {
      setMaintenanceMessage(error instanceof Error ? error.message : "Maintenance 정보를 불러오지 못했습니다.");
    }
  }, [job.id, maintenanceBlocked]);
  useEffect(() => { void refreshMaintenance(); }, [refreshMaintenance]);
  const runMaintenance = async (kind: "replay" | "compact") => {
    setMaintenanceBusy(true);
    setMaintenanceMessage("");
    try {
      const run = kind === "replay"
        ? await replayContinuousQuarantine(job.id)
        : await compactContinuousTarget(job.id, 256);
      if (kind === "replay") {
        const stored = Number(run.result?.storedCount ?? 0);
        const failed = Number(run.result?.failedCount ?? 0);
        const skipped = Number(run.result?.skippedCount ?? 0);
        setMaintenanceMessage(`격리 재처리 ${run.status} · 적재 ${stored.toLocaleString()} · 정책 거부 ${failed.toLocaleString()} · 이미 처리 ${skipped.toLocaleString()}`);
      } else {
        setMaintenanceMessage(`Compaction ${run.status}`);
      }
      await refreshMaintenance();
    } catch (error) {
      setMaintenanceMessage(error instanceof Error ? error.message : "Maintenance 실행에 실패했습니다.");
    } finally {
      setMaintenanceBusy(false);
    }
  };
  return (
    <article className="job-detail-card metadata-card">
      <h3>Continuous Runtime</h3>
      <div className="detail-kv-grid">
        <Field label="상태" value={continuousRuntimeLabel(job)} />
        <Field label="마지막 batch" value={runtime?.lastBatchId ?? "-"} />
        <Field label="소비 / 적재" value={`${runtime?.consumedCount?.toLocaleString() ?? "0"} / ${runtime?.storedCount?.toLocaleString() ?? "0"}`} />
        <Field label="격리 / 재처리" value={`${runtime?.quarantinedCount?.toLocaleString() ?? "0"} / ${runtime?.replayedCount?.toLocaleString() ?? "0"}`} />
        <Field label="실패" value={runtime?.failedCount?.toLocaleString() ?? "0"} />
        <Field label="Kafka Lag" value={runtime?.lagAvailable ? `${runtime.lag?.toLocaleString() ?? 0}건 · 최대 ${runtime.maxPartitionLag?.toLocaleString() ?? 0}` : "측정 대기"} />
        <Field label="처리량" value={runtime?.throughputRowsPerSecond != null ? `${runtime.throughputRowsPerSecond.toLocaleString()} rows/s` : "-"} />
        <Field label="최근 Batch" value={runtime?.lastBatchDurationMs != null ? `${runtime.lastBatchInputRows.toLocaleString()}건 · ${runtime.lastBatchDurationMs.toLocaleString()}ms` : "-"} />
        <Field label="Schema" value={`v${runtime?.schemaVersion ?? 1} · ${runtime?.schemaStatus ?? "stable"}`} />
        <Field label="Rule 계약" value={`v${runtime?.ruleContractVersion ?? "1.0"} · ${runtime?.ruleFingerprint?.slice(0, 10) ?? "대기"}`} />
        <Field label="Rule 처리" value={`경고 ${(Number(ruleMetrics.transformWarnCount ?? 0) + Number(ruleMetrics.qualityWarnCount ?? 0)).toLocaleString()} · 격리 ${(Number(ruleMetrics.transformQuarantinedCount ?? 0) + Number(ruleMetrics.qualityQuarantinedCount ?? 0)).toLocaleString()} · 실패 batch ${Number(ruleMetrics.failedBatchCount ?? 0).toLocaleString()}`} />
        <Field label="Heartbeat" value={runtime?.heartbeatAt ? formatCompactDateTime(runtime.heartbeatAt) : "-"} />
        <Field label="Checkpoint" value={runtime?.checkpointPath ?? "-"} />
        {runtime?.lastError && <Field label="최근 오류" value={runtime.lastError} />}
      </div>
      <div className="job-runtime-log-header">
        <strong>Worker Log</strong>
        <button className="job-action-button" disabled={loadingLogs} onClick={() => void loadLogs()} type="button"><RefreshCw size={15} />새로고침</button>
      </div>
      {logError ? <p className="job-inline-error">{logError}</p> : <pre className="job-runtime-log">{logs.length ? logs.join("\n") : loadingLogs ? "로그 불러오는 중..." : "표시할 로그가 없습니다."}</pre>}
      <div className="job-runtime-log-header">
        <strong>Quarantine · Maintenance</strong>
        <div className="job-runtime-actions">
          <button className="job-action-button" disabled={maintenanceBlocked || maintenanceBusy || !quarantine.some((item) => item.replayStatus !== "replayed")} onClick={() => void runMaintenance("replay")} title={maintenanceBlocked ? "스트림을 중지한 뒤 실행할 수 있습니다." : undefined} type="button"><Repeat2 size={15} />전체 재처리</button>
          <button className="job-action-button" disabled={maintenanceBlocked || maintenanceBusy || (runtime?.storedCount ?? 0) === 0} onClick={() => void runMaintenance("compact")} title={maintenanceBlocked ? "스트림을 중지한 뒤 실행할 수 있습니다." : undefined} type="button"><HardDrive size={15} />Compaction</button>
        </div>
      </div>
      {maintenanceMessage && <p className="panel-note">{maintenanceMessage}</p>}
      <div className="job-maintenance-summary">
        <span>격리 샘플 {quarantine.length.toLocaleString()}건</span>
        <span>실행 이력 {maintenanceRuns.length.toLocaleString()}건</span>
        <span>최근 {maintenanceRuns[0] ? `${maintenanceRuns[0].kind} · ${maintenanceRuns[0].status}` : "-"}</span>
      </div>
      {quarantine.length > 0 && <div className="job-quarantine-list">{quarantine.slice(0, 5).map((item) => <div key={`${item.partition}:${item.offset}`}><code>{item.partition}:{item.offset}</code><span>{item.stage === "schema" ? "스키마" : item.ruleId ? `${item.stage ?? "rule"} · ${item.ruleId}` : "규칙"} · {item.reason}</span><span>{item.replayStatus}</span><span>{item.rawPayload}</span></div>)}</div>}
    </article>
  );
}

type JobRunsPageProps = {
  catalogDatasetId?: string;
  catalogRowCount?: string;
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
};

const activeContinuousSessionStatuses = new Set<KafkaContinuousSessionStatus>(["starting", "running", "stopping"]);

const continuousSessionStatusMeta: Record<KafkaContinuousSessionStatus, { label: string; tone: StatusBadgeTone }> = {
  failed: { label: "실패", tone: "danger" },
  running: { label: "실행 중", tone: "success" },
  starting: { label: "시작 중", tone: "default" },
  stopped: { label: "종료", tone: "muted" },
  stopping: { label: "종료 중", tone: "default" },
};

const continuousBatchStatusMeta: Record<KafkaContinuousBatch["status"], { label: string; tone: StatusBadgeTone }> = {
  failed: { label: "실패", tone: "danger" },
  running: { label: "진행", tone: "default" },
  success: { label: "성공", tone: "success" },
};

type ContinuousDagSelection =
  | { id: string; kind: "session" }
  | { id: number; kind: "batch" };

export function JobRunsPage(props: JobRunsPageProps) {
  if (props.job.executionMode === "continuous") {
    return <ContinuousJobRunsPage {...props} />;
  }
  return <SnapshotJobRunsPage {...props} />;
}

function ContinuousJobRunsPage({
  catalogDatasetId,
  catalogRowCount,
  job,
  onAction,
  onBack,
  onCommand,
}: JobRunsPageProps) {
  const [sessions, setSessions] = useState<KafkaContinuousSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<KafkaContinuousSession | null>(null);
  const [batches, setBatches] = useState<KafkaContinuousBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [currentCatalogRowCount, setCurrentCatalogRowCount] = useState(catalogRowCount);
  const [sessionPollingActive, setSessionPollingActive] = useState(false);
  const [dagSelection, setDagSelection] = useState<ContinuousDagSelection | null>(null);
  const inFlightRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const activeSessionsRef = useRef(false);
  const hasLoadedRef = useRef(false);

  const loadSessions = useCallback(async () => {
    if (inFlightRef.current) return { active: activeSessionsRef.current, ok: true };
    inFlightRef.current = true;
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const [nextSessions, nextCatalogDataset] = await Promise.all([
        getContinuousSessions(job.id),
        catalogDatasetId ? getCatalogDataset(catalogDatasetId).catch(() => null) : Promise.resolve(null),
      ]);
      const nextSelectedId = nextSessions.some((session) => session.sessionId === selectedSessionId)
        ? selectedSessionId
        : nextSessions[0]?.sessionId ?? null;
      const nextSelectedSession = nextSessions.find((session) => session.sessionId === nextSelectedId) ?? null;
      const nextBatches = nextSelectedId
        ? await getContinuousSessionBatches(job.id, nextSelectedId, 100)
        : [];
      if (requestSequence !== requestSequenceRef.current) return { active: false, ok: true };
      setSessions(nextSessions);
      setSelectedSessionId(nextSelectedId);
      setSelectedSession(nextSelectedSession);
      setBatches(nextBatches);
      setCurrentCatalogRowCount(nextCatalogDataset?.rows ?? catalogRowCount);
      setRefreshError(null);
      setLastRefreshedAt(new Date().toISOString());
      activeSessionsRef.current = nextSessions.some((session) => activeContinuousSessionStatuses.has(session.status));
      setSessionPollingActive(activeSessionsRef.current);
      return { active: activeSessionsRef.current, ok: true };
    } catch {
      if (requestSequence === requestSequenceRef.current) {
        setRefreshError("실시간 실행 이력을 갱신하지 못했습니다. 마지막으로 확인한 값을 유지합니다.");
      }
      return { active: true, ok: false };
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        hasLoadedRef.current = true;
        setLoading(false);
      }
      inFlightRef.current = false;
    }
  }, [catalogDatasetId, catalogRowCount, job.id, selectedSessionId]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    inFlightRef.current = false;
    hasLoadedRef.current = false;
    activeSessionsRef.current = false;
    setSessions([]);
    setSelectedSessionId(null);
    setSelectedSession(null);
    setBatches([]);
    setSessionPollingActive(false);
    setLoading(true);
    setRefreshError(null);
    setDagSelection(null);
  }, [job.id]);

  const runtimeActive = job.continuousRuntime
    ? ["starting", "running", "pausing", "stopping"].includes(job.continuousRuntime.status)
    : false;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;

    const schedule = (delay: number) => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule(5000);
        return;
      }
      const result = await loadSessions();
      if (cancelled) return;
      failures = result.ok ? 0 : Math.min(failures + 1, 3);
      if (result.active || runtimeActive || sessionPollingActive || !result.ok) {
        schedule(result.ok ? 3000 : 3000 * (2 ** failures));
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) window.clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadSessions, runtimeActive, sessionPollingActive]);

  const selectSession = (session: KafkaContinuousSession) => {
    setSelectedSessionId(session.sessionId);
    setSelectedSession(session);
    setBatches([]);
    setDagSelection(null);
    onAction("etl.continuous.session_opened", `/api/etl/jobs/${job.id}/continuous/sessions/${session.sessionId}`, session.sessionId);
  };

  const refreshNow = async () => {
    setManualRefreshing(true);
    try {
      const result = await loadSessions();
      onAction("etl.continuous.sessions_refreshed", `/api/etl/jobs/${job.id}/continuous/sessions`, job.id, result.ok ? "success" : "failed");
    } finally {
      setManualRefreshing(false);
    }
  };

  const latestSession = sessions[0] ?? null;
  const metricSession = selectedSession ?? latestSession;
  const activeDagTarget = dagSelection?.kind === "session"
    ? sessions.find((session) => session.sessionId === dagSelection.id) ?? null
    : dagSelection?.kind === "batch"
      ? batches.find((batch) => batch.batchId === dagSelection.id) ?? null
      : null;
  const openSessionDag = (session: KafkaContinuousSession) => {
    setDagSelection({ id: session.sessionId, kind: "session" });
    onAction("etl.continuous.session_dag_opened", `/api/etl/jobs/${job.id}/continuous/sessions/${session.sessionId}`, session.sessionId);
  };
  const openBatchDag = (batch: KafkaContinuousBatch) => {
    setDagSelection({ id: batch.batchId, kind: "batch" });
    onAction("etl.continuous.batch_dag_opened", `/api/etl/jobs/${job.id}/continuous/sessions/${batch.sessionId}/batches`, `${batch.sessionId}:${batch.batchId}`);
  };
  const sessionColumns: ColumnDef<KafkaContinuousSession>[] = [
    {
      accessorKey: "sessionId",
      header: "세션 ID",
      cell: ({ row }) => (
        <Button className="h-auto max-w-[210px] justify-start truncate px-0 text-left font-semibold" size="content" type="button" variant="link" onClick={() => selectSession(row.original)}>
          {row.original.sessionId}
        </Button>
      ),
      meta: { widthClassName: "w-[220px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => <ContinuousSessionStatus status={row.original.status} />,
      meta: { align: "center", widthClassName: "w-[100px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "period",
      header: "실행 구간",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary>{formatCompactDateTime(row.original.startedAt)}</DataTableCellPrimary>
          <DataTableCellSecondary>{row.original.endedAt ? `${formatCompactDateTime(row.original.endedAt)} · ${formatContinuousDuration(row.original.startedAt, row.original.endedAt)}` : "진행 중"}</DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { widthClassName: "w-[210px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "counts",
      header: "세션 처리량",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary>소비 {row.original.consumedCount.toLocaleString()}건</DataTableCellPrimary>
          <DataTableCellSecondary>적재 {row.original.storedCount.toLocaleString()} · 격리 {row.original.quarantinedCount.toLocaleString()}</DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { widthClassName: "w-[190px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "lag",
      header: "Kafka Lag",
      cell: ({ row }) => row.original.lag == null ? "-" : `${row.original.lag.toLocaleString()}건`,
      meta: { align: "right", widthClassName: "w-[110px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "lastFlushAt",
      header: "최근 적재",
      cell: ({ row }) => row.original.lastFlushAt ? formatCompactDateTime(row.original.lastFlushAt) : "-",
      meta: { widthClassName: "w-[160px]" } satisfies DataTableColumnMeta,
    },
  ];
  const batchColumns: ColumnDef<KafkaContinuousBatch>[] = [
    {
      accessorKey: "batchId",
      header: "Batch",
      cell: ({ row }) => <strong className="tabular-nums">#{row.original.batchId}</strong>,
      meta: { widthClassName: "w-[90px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => <ContinuousBatchStatus status={row.original.status} />,
      meta: { align: "center", widthClassName: "w-[90px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "publishedAt",
      header: "적재 시각",
      cell: ({ row }) => row.original.publishedAt ? formatCompactDateTime(row.original.publishedAt) : "-",
      meta: { widthClassName: "w-[170px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "counts",
      header: "처리 건수",
      cell: ({ row }) => `소비 ${row.original.consumedCount.toLocaleString()} · 적재 ${row.original.storedCount.toLocaleString()} · 격리 ${row.original.quarantinedCount.toLocaleString()}`,
      meta: { widthClassName: "w-[270px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "durationMs",
      header: "소요 시간",
      cell: ({ row }) => row.original.durationMs == null ? "-" : `${row.original.durationMs.toLocaleString()}ms`,
      meta: { align: "right", widthClassName: "w-[110px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "offsets",
      header: "Kafka Offset 범위",
      cell: ({ row }) => formatSourceRanges(row.original.sourceRanges),
      meta: { widthClassName: "w-[260px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "paths",
      header: "저장 경로",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary className="max-w-[260px] truncate" title={row.original.dataPath ?? row.original.quarantinePath ?? undefined}>
            {row.original.dataPath ?? row.original.quarantinePath ?? "-"}
          </DataTableCellPrimary>
          <DataTableCellSecondary className="max-w-[260px] truncate" title={row.original.manifestPath ?? undefined}>
            {row.original.manifestPath ? `manifest ${row.original.manifestPath}` : "manifest -"}
          </DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { widthClassName: "w-[280px]" } satisfies DataTableColumnMeta,
    },
  ];

  return (
    <TooltipProvider delayDuration={250}>
      <div className="job-detail-page job-runs-page">
        <JobDetailHeader backLabel="작업 상세로 돌아가기" job={job} onBack={onBack} onCommand={onCommand} />
        <section className="runs-body-content">
          {refreshError && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>자동 갱신 지연</AlertTitle>
              <AlertDescription>{refreshError}</AlertDescription>
            </Alert>
          )}
          <Panel overflow="visible">
            <PanelHeader icon={<Activity aria-hidden="true" size={18} />} title="실시간 실행 요약" />
            <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard detail={metricSession?.lastFlushAt ? formatCompactDateTime(metricSession.lastFlushAt) : "세션 기록 없음"} icon={<Activity aria-hidden="true" />} label="세션 상태" size="default" tone={metricSession?.status === "failed" ? "failed" : metricSession?.status === "running" ? "running" : "scheduled"} value={metricSession ? continuousSessionStatusMeta[metricSession.status].label : "-"} />
              <MetricCard detail="선택 세션 기준" icon={<Database aria-hidden="true" />} label="세션 누적 적재" size="default" tone="running" value={`${(metricSession?.storedCount ?? 0).toLocaleString()}건`} />
              <MetricCard detail="Catalog 현재 행 수" icon={<Table2 aria-hidden="true" />} label="현재 데이터셋" size="default" value={currentCatalogRowCount ?? "미등록"} />
              <MetricCard detail={metricSession?.lastBatchId ? `최근 batch ${metricSession.lastBatchId}` : "batch 기록 없음"} icon={<Zap aria-hidden="true" />} label="Kafka Lag" size="default" tone={(metricSession?.lag ?? 0) > 0 ? "scheduled" : "total"} value={metricSession?.lag == null ? "-" : `${metricSession.lag.toLocaleString()}건`} />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              actions={(
                <Button disabled={loading || manualRefreshing} size="sm" type="button" variant="outline" onClick={() => void refreshNow()}>
                  <RefreshCw aria-hidden="true" className={loading || manualRefreshing ? "animate-spin" : undefined} />
                  새로고침
                </Button>
              )}
              icon={<History aria-hidden="true" size={18} />}
              meta={<Badge shape="compact" size="lg" variant="muted">{sessions.length}개 세션</Badge>}
              title="스트림 세션 이력"
            />
            <DataTable
              columns={sessionColumns}
              data={sessions}
              emptyState={{ title: loading ? "세션 이력을 불러오는 중입니다." : "아직 실시간 실행 세션이 없습니다." }}
              getRowClassName={(row) => row.original.sessionId === selectedSessionId ? "bg-blue-50/70" : row.original.status === "failed" ? "bg-red-50/45" : undefined}
              pagination={{ label: "스트림 세션", pageSize: 5, showSummary: false }}
              renderRowActions={(row) => (
                <IconButton label={`${row.original.sessionId} 세션 DAG 보기`} size="xs" variant="outline" onClick={() => openSessionDag(row.original)}>
                  <Workflow aria-hidden="true" />
                </IconButton>
              )}
              resetPaginationKey={`${sessions.length}-${selectedSessionId ?? "none"}`}
              rowActionsAlign="center"
              rowActionsClassName="w-[70px]"
              rowActionsHeader="DAG"
              tableClassName="min-w-[960px] table-fixed"
              viewportClassName="rounded-none border-0 bg-transparent"
            />
            {lastRefreshedAt && <p className="px-5 pb-4 text-right text-xs text-slate-500">최근 갱신 {formatCompactDateTime(lastRefreshedAt)}</p>}
          </Panel>

          <Panel>
            <PanelHeader
              icon={<Workflow aria-hidden="true" size={18} />}
              meta={<Badge shape="compact" size="lg" variant="muted">{batches.length}개 batch</Badge>}
              title="세션 Batch 상세"
            />
            {selectedSession && (
              <div className="grid gap-3 border-b border-slate-200 px-5 py-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                <Field label="종료 사유" value={formatContinuousEndReason(selectedSession.endReason)} />
                <Field label="실패 건수" value={`${selectedSession.failedCount.toLocaleString()}건`} />
                <Field label="Checkpoint" value={selectedSession.checkpointPath} />
                <Field label="최근 오류" value={selectedSession.lastError ?? "-"} />
              </div>
            )}
            <DataTable
              columns={batchColumns}
              data={batches}
              emptyState={{ title: selectedSession ? "이 세션에 기록된 micro-batch가 없습니다." : "확인할 세션을 선택해 주세요." }}
              pagination={{ label: "micro-batch", pageSize: 10, showSummary: false }}
              renderRowActions={(row) => (
                <IconButton label={`Batch ${row.original.batchId} DAG 보기`} size="xs" variant="outline" onClick={() => openBatchDag(row.original)}>
                  <Workflow aria-hidden="true" />
                </IconButton>
              )}
              resetPaginationKey={`${selectedSessionId ?? "none"}-${batches.length}`}
              rowActionsAlign="center"
              rowActionsClassName="w-[70px]"
              rowActionsHeader="DAG"
              tableClassName="min-w-[1280px] table-fixed"
              viewportClassName="rounded-none border-0 bg-transparent"
            />
          </Panel>
        </section>
        {dagSelection && activeDagTarget && (
          <ContinuousDagModal
            job={job}
            onAction={onAction}
            onClose={() => setDagSelection(null)}
            target={activeDagTarget}
            targetKind={dagSelection.kind}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

function ContinuousSessionStatus({ status }: { status: KafkaContinuousSessionStatus }) {
  const meta = continuousSessionStatusMeta[status];
  return <StatusBadge className="min-w-[76px] justify-center" shape="compact" size="lg" tone={meta.tone}>{meta.label}</StatusBadge>;
}

function ContinuousBatchStatus({ status }: { status: KafkaContinuousBatch["status"] }) {
  const meta = continuousBatchStatusMeta[status];
  return <StatusBadge className="min-w-[58px] justify-center" shape="compact" tone={meta.tone}>{meta.label}</StatusBadge>;
}

function ContinuousDagModal({
  job,
  onAction,
  onClose,
  target,
  targetKind,
}: {
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onClose: () => void;
  target: KafkaContinuousSession | KafkaContinuousBatch;
  targetKind: ContinuousDagSelection["kind"];
}) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const session = targetKind === "session" ? target as KafkaContinuousSession : null;
  const batch = targetKind === "batch" ? target as KafkaContinuousBatch : null;
  const dagSteps = target.dagSteps ?? [];
  const selectedStep = getSelectedDagStep(dagSteps, selectedStepId);
  const selectedStepIndex = Math.max(dagSteps.findIndex((step) => step.id === selectedStep?.id), 0);
  const completedSteps = dagSteps.filter((step) => step.status === "success").length;
  const contextId = session?.sessionId ?? `${batch?.sessionId}:batch:${batch?.batchId}`;
  const title = session?.sessionId ?? `Batch #${batch?.batchId}`;
  const statusLabel = session
    ? continuousSessionStatusMeta[session.status].label
    : batch ? continuousBatchStatusMeta[batch.status].label : "-";
  const statusTone = session?.status === "failed" || batch?.status === "failed"
    ? "failed"
    : session?.status === "running" || batch?.status === "running"
      ? "running"
      : "total";
  const consumedCount = session?.consumedCount ?? batch?.consumedCount ?? 0;
  const storedCount = session?.storedCount ?? batch?.storedCount ?? 0;
  const duration = session
    ? formatContinuousDuration(session.startedAt, session.endedAt)
    : batch?.durationMs == null ? "-" : `${batch.durationMs.toLocaleString()}ms`;
  const observedAt = session?.startedAt ?? batch?.publishedAt ?? undefined;

  return (
    <DialogShell
      aria-label={`${title} Streaming DAG`}
      bodyClassName="run-dag-modal-body"
      contentClassName="run-dag-modal-panel"
      description={`${job.target} · ${observedAt ? formatCompactDateTime(observedAt) : "시각 미수집"}`}
      eyebrow={session ? "Streaming session" : "Streaming micro-batch"}
      headerActions={<Button size="sm" type="button" variant="outline" aria-label="닫기" onClick={onClose}><X size={16} />닫기</Button>}
      headerClassName="run-dag-modal-header"
      onClose={onClose}
      showCloseButton={false}
      size="wide"
      title={title}
    >
      <section className="dag-body-content">
        <div className="dag-summary-grid">
          <MetricCard detail={session ? "세션 누적 상태" : "micro-batch 처리 상태"} icon={<Activity aria-hidden="true" />} label="상태" size="compact" tone={statusTone} value={statusLabel} />
          <MetricCard detail={observedAt ? formatCompactDateTime(observedAt) : "시각 미수집"} icon={<Clock3 aria-hidden="true" />} label="소요 시간" size="compact" value={duration} />
          <MetricCard detail="성공한 단계 / 전체 단계" icon={<Workflow aria-hidden="true" />} label="완료 단계" size="compact" tone="total" value={`${completedSteps}/${dagSteps.length}`} />
          <MetricCard detail={`출력 ${storedCount.toLocaleString()}건`} icon={<Table2 aria-hidden="true" />} label="입력 행" size="compact" value={`${consumedCount.toLocaleString()}건`} />
        </div>

        <article className="dag-workbench">
          <section className="dag-timeline-panel" aria-label="Streaming DAG">
            <PanelHeader className="min-h-16" description="실제 worker·manifest·Catalog 증적을 단계별로 확인합니다." icon={<Workflow aria-hidden="true" size={18} />} title="Streaming DAG" />
            <ScrollArea className="h-[430px]">
              {dagSteps.length ? (
                <Timeline aria-label="Streaming 실행 단계 목록" className="px-5 py-4" role="list" value={selectedStepIndex + 1}>
                  {dagSteps.map((step, index) => (
                    <DagTimelineItem
                      active={selectedStep?.id === step.id}
                      index={index}
                      key={step.id}
                      onSelect={() => {
                        setSelectedStepId(step.id);
                        onAction("etl.continuous.dag_node_selected", `/api/etl/jobs/${job.id}/continuous/sessions/${session?.sessionId ?? batch?.sessionId}/steps/${step.id}`, `${contextId}:${step.id}`);
                      }}
                      step={step}
                    />
                  ))}
                </Timeline>
              ) : (
                <div className="grid min-h-[280px] place-items-center px-6 text-center text-sm font-bold text-slate-500">수집된 Streaming 단계 증적이 없습니다.</div>
              )}
            </ScrollArea>
          </section>
          <DagStepInspector contextId={contextId} key={selectedStep?.id ?? "empty"} step={selectedStep} />
        </article>
      </section>
    </DialogShell>
  );
}

function formatContinuousDuration(startedAt: string, endedAt?: string | null) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt ?? new Date().toISOString());
  if (Number.isNaN(start) || Number.isNaN(end)) return "-";
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}시간 ${minutes}분` : minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

function formatContinuousEndReason(reason?: string | null) {
  const labels: Record<string, string> = {
    paused: "일시정지",
    start_failed: "시작 실패",
    stopped: "사용자 중지",
    worker_failed: "Worker 실패",
    worker_stopped: "Worker 종료",
  };
  return reason ? labels[reason] ?? reason : "-";
}

function formatSourceRanges(ranges: KafkaContinuousBatch["sourceRanges"]) {
  if (!ranges.length) return "-";
  return ranges.map((range) => `${range.partition ?? 0}:${range.startOffset ?? 0}-${range.endOffset ?? 0}`).join(", ");
}

function SnapshotJobRunsPage({
  evidence,
  job,
  onAction,
  onBack,
  onCommand,
}: JobRunsPageProps) {
  const [activeRun, setActiveRun] = useState<JobRunSummary | null>(null);
  const [activeLogRun, setActiveLogRun] = useState<JobRunSummary | null>(null);
  const [runStatusFilter, setRunStatusFilter] = useState<"all" | JobRunStatus>("all");
  const jobRuns = job.runHistory ?? [];
  const evidenceRuns = evidence?.runs ?? [];
  const runs = jobRuns.length
    ? [...jobRuns, ...evidenceRuns.filter((run) => !jobRuns.some((jobRun) => jobRun.runId === run.runId))]
    : evidenceRuns;
  const runStatusCounts = useMemo(() => {
    const counts: Record<JobRunStatus, number> = { canceled: 0, failed: 0, queued: 0, running: 0, success: 0 };
    runs.forEach((run) => { counts[run.status] += 1; });
    return counts;
  }, [runs]);
  const availableRunStatuses = runStatusFilterOrder.filter((status) => runStatusCounts[status] > 0);
  const filteredRuns = runStatusFilter === "all" ? runs : runs.filter((run) => run.status === runStatusFilter);
  const latestRun = runs[0];
  const activeRunDetail = activeRun
    ? runs.find((run) => run.runId === activeRun.runId) ?? activeRun
    : null;
  const activeLogRunDetail = activeLogRun
    ? runs.find((run) => run.runId === activeLogRun.runId) ?? activeLogRun
    : null;
  const totalRunsValue = job.stats?.totalRuns
    ? job.stats.totalRuns.endsWith("회") ? job.stats.totalRuns : `${job.stats.totalRuns}회`
    : `${runs.length}회`;
  const openRunDetail = (run: JobRunSummary) => {
    onAction("etl.run.detail_opened", `/api/etl/jobs/${job.id}/runs/${run.runId}`, run.runId);
    setActiveRun(run);
  };
  const openRunLog = (run: JobRunSummary) => {
    onAction("etl.run.log_opened", `/api/etl/jobs/${job.id}/runs/${run.runId}/logs`, run.runId);
    setActiveLogRun(run);
  };
  const changeRunStatusFilter = (nextValue: "all" | JobRunStatus) => {
    setRunStatusFilter(nextValue);
    onAction("etl.runs.status_filtered", `/api/etl/jobs/${job.id}/runs?status=${nextValue}`, job.id);
  };
  const runColumns: ColumnDef<JobRunSummary>[] = [
    {
      accessorKey: "runId",
      header: "실행 ID",
      cell: ({ row }) => (
        <DataTableCellPrimary className="max-w-[155px] text-base font-bold" title={row.original.runId}>
          {row.original.runId}
        </DataTableCellPrimary>
      ),
      meta: { headerClassName: "text-base", widthClassName: "w-[160px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "status",
      header: () => (
        <RunStatusFilter
          counts={runStatusCounts}
          onValueChange={changeRunStatusFilter}
          statuses={availableRunStatuses}
          value={runStatusFilter}
        />
      ),
      cell: ({ row }) => <RunStatusPill status={row.original.status} />,
      enableSorting: false,
      meta: { align: "center", cellClassName: "h-px p-0", headerClassName: "text-base", widthClassName: "w-[90px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorFn: (run) => run.status === "running" ? Number.MAX_SAFE_INTEGER : getRunStartedAtSortValue(run.startedAt),
      id: "executionTime",
      header: "실행 시간",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary className="whitespace-nowrap text-lg font-semibold tabular-nums">
            {formatCompactDateTime(row.original.startedAt)}
          </DataTableCellPrimary>
          <DataTableCellSecondary className="whitespace-nowrap text-base tabular-nums">
            종료 {formatCompactDateTime(row.original.endedAt)} · {row.original.duration}
          </DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { headerClassName: "text-base", widthClassName: "w-[190px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "throughput",
      header: "처리 행",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary className="text-lg font-semibold tabular-nums">입력 {row.original.inputRows}</DataTableCellPrimary>
          <DataTableCellSecondary className="text-base tabular-nums">출력 {row.original.outputRows}</DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { headerClassName: "text-base", widthClassName: "w-[175px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "resultSummary",
      header: "결과 요약",
      cell: ({ row }) => {
        const result = getRunResultSummary(row.original);
        return (
          <DataTableStackedCell>
            <DataTableCellPrimary className={row.original.status === "failed" ? "text-lg font-bold text-red-700" : "text-lg font-semibold"}>{result.title}</DataTableCellPrimary>
            {row.original.status !== "success" && (
              <DataTableCellSecondary className="max-w-[145px] text-sm" title={result.detail}>{result.detail}</DataTableCellSecondary>
            )}
          </DataTableStackedCell>
        );
      },
      meta: { headerClassName: "text-base", widthClassName: "w-[150px]" } satisfies DataTableColumnMeta,
    },
  ];

  return (
    <TooltipProvider delayDuration={250}>
      <div className="job-detail-page job-runs-page">
        <JobDetailHeader backLabel="작업 상세로 돌아가기" job={job} onBack={onBack} onCommand={onCommand} />

        <section className="runs-body-content">
          <Panel overflow="visible">
            <PanelHeader icon={<BarChart3 aria-hidden="true" size={18} />} title="실행 통계 요약" />
            <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard detail="집계된 종료 Run 기준" icon={<Check aria-hidden="true" />} label="실행 성공률" size="default" tone="running" value={job.stats?.successRate ?? "-"} />
              <MetricCard detail="집계된 종료 Run 기준" icon={<Clock3 aria-hidden="true" />} label="평균 실행 시간" size="default" value={job.stats?.averageDuration ?? "-"} />
              <MetricCard detail="누적 실행 횟수" icon={<History aria-hidden="true" />} label="누적 실행" size="default" tone="total" value={totalRunsValue} />
              <MetricCard
                detail={latestRun ? formatCompactDateTime(latestRun.endedAt || latestRun.startedAt) : "실행 기록 없음"}
                icon={<Activity aria-hidden="true" />}
                label="최근 실행 결과"
                size="default"
                tone={latestRun?.status === "failed" ? "failed" : latestRun?.status === "success" ? "running" : latestRun?.status === "canceled" ? "default" : "scheduled"}
                value={latestRun ? runStatusMeta[latestRun.status].label : "-"}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              actions={(
                <Button size="sm" type="button" variant="outline" onClick={() => onAction("etl.runs.refreshed", `/api/etl/jobs/${job.id}/runs`, job.id)}>
                  <RefreshCw aria-hidden="true" />
                  새로고침
                </Button>
              )}
              icon={<Workflow aria-hidden="true" size={18} />}
              meta={<Badge shape="compact" size="lg" variant="muted">{filteredRuns.length}건</Badge>}
              title="실행 이력"
            />
            <DataTable
            bodyRowClassName="[&_td]:py-3"
            className="gap-0 [&>div:last-child]:min-h-14 [&>div:last-child]:rounded-none [&>div:last-child]:border-x-0 [&>div:last-child]:border-b-0"
            columns={runColumns}
            data={filteredRuns}
            emptyState={{ title: runStatusFilter === "all" ? "아직 실행 이력이 없습니다." : "선택한 상태의 실행 이력이 없습니다." }}
            enableSorting
            getRowClassName={(row) => row.original.status === "failed" ? "bg-red-50/45 hover:bg-red-50/70" : row.original.status === "canceled" ? "bg-slate-50/80" : undefined}
            initialSorting={[{ desc: true, id: "executionTime" }]}
            pagination={{ label: "실행 이력", pageSize: 5, showSummary: false }}
            renderRowActions={(row) => (
              <div className="grid w-full justify-items-center gap-1.5 text-center">
                <Button className="h-auto w-full justify-center px-0 py-0 text-base font-bold" size="content" type="button" variant="link" onClick={() => openRunLog(row.original)}>
                  로그 보기
                </Button>
                <Button className="h-auto w-full justify-center px-0 py-0 text-base font-bold" size="content" type="button" variant="link" onClick={() => openRunDetail(row.original)}>
                  실행 단계 보기
                </Button>
              </div>
            )}
            resetPaginationKey={`${runStatusFilter}-${filteredRuns.length}`}
            rowActionsAlign="center"
            rowActionsClassName="w-[125px] text-base"
            rowActionsHeader="액션"
            headerRowClassName="[&_th]:h-12 [&_th]:py-2.5 [&_th]:text-slate-600 [&_th_button]:text-slate-600 [&_th_svg]:text-slate-600"
            tableClassName="min-w-[860px] table-fixed [&_td]:h-24 [&_thead_th_button]:gap-1.5 [&_thead_th_button_svg]:size-4"
            viewportClassName="rounded-none border-0 bg-transparent"
            />
          </Panel>
        </section>
        {activeRunDetail && <RunDagModal evidence={evidence} job={job} onAction={onAction} onClose={() => setActiveRun(null)} run={activeRunDetail} />}
        {activeLogRunDetail && <RunLogModal job={job} onClose={() => setActiveLogRun(null)} run={activeLogRunDetail} />}
      </div>
    </TooltipProvider>
  );
}

function RunStatusPill({ status }: { status: JobRunStatus }) {
  const statusMeta = runStatusMeta[status];

  return (
    <StatusBadge className="min-w-[74px] justify-center rounded-md text-base" shape="compact" size="lg" tone={getRunStatusTone(status)}>
      {status === "running" && <Spinner className="size-3.5" aria-label="실행 중" />}
      {statusMeta.label}
    </StatusBadge>
  );
}

function getRunResultSummary(run: JobRunSummary) {
  if (run.status === "failed") {
    return {
      detail: normalizeWhitespace(run.errorSummary) && run.errorSummary !== "-" ? truncateText(normalizeWhitespace(run.errorSummary), 96) : "실패 원인 로그를 확인하세요.",
      title: run.failedStage && run.failedStage !== "-" ? run.failedStage : "실행 실패",
    };
  }
  if (run.status === "canceled") return { detail: "실행이 완료되기 전에 취소되었습니다.", title: "실행 취소" };
  if (run.status === "running") return { detail: "현재 단계 정보를 실행 단계에서 확인할 수 있습니다.", title: run.failedStage !== "-" ? run.failedStage : "진행 중" };
  if (run.status === "queued") return { detail: "실행 리소스 할당을 기다리고 있습니다.", title: "실행 대기" };
  return { detail: "모든 실행 단계가 정상적으로 완료되었습니다.", title: "정상 완료" };
}

function getRunStartedAtSortValue(startedAt: string) {
  const normalized = startedAt.includes("T") ? startedAt : startedAt.replace(" ", "T");
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function RunLogModal({ job, onClose, run }: { job: JobRowData; onClose: () => void; run: JobRunSummary }) {
  const logBody = normalizeWhitespace(run.errorSummary) || "표시할 로그가 없습니다.";

  return (
    <DialogShell
      bodyClassName="p-0"
      contentClassName="w-[min(920px,calc(100vw-2rem))] max-h-[min(720px,calc(100vh-2rem))] overflow-hidden"
      description={`${run.failedStage} · ${formatCompactDateTime(run.startedAt)} - ${formatCompactDateTime(run.endedAt)}`}
      eyebrow={`${run.runId} · ${runStatusMeta[run.status].label}`}
      headerActions={(
        <Button size="sm" type="button" variant="outline" aria-label="닫기" onClick={onClose}><X size={16} />닫기</Button>
      )}
      headerClassName="job-log-modal-header"
      onClose={onClose}
      title={job.name}
    >
      <pre className="m-0 min-h-0 overflow-auto whitespace-pre-wrap break-words bg-slate-900 px-5 py-4 font-mono text-xs leading-6 text-blue-100">{logBody}</pre>
    </DialogShell>
  );
}

function RunDagModal({
  evidence,
  job,
  onAction,
  onClose,
  run,
}: {
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onClose: () => void;
  run: JobRunSummary;
}) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const evidenceRun = evidence?.runs.find((candidate) => candidate.runId === run.runId);
  const currentRun = job.runHistory?.find((candidate) => candidate.runId === run.runId) ?? evidenceRun ?? run;
  const evidenceMatchesRun = evidence?.runs[0]?.runId === currentRun.runId;
  const dagSteps = evidenceMatchesRun && evidence?.dagSteps.length
    ? evidence.dagSteps
    : job.dagStepsByRunId?.[currentRun.runId] ?? job.dagSteps ?? [];
  const completedSteps = dagSteps.filter((step) => step.status === "success").length;
  const activeOrFailedStep = dagSteps.find((step) => step.status === "running" || step.status === "failed" || step.status === "blocked");
  const selectedStep = getSelectedDagStep(dagSteps, selectedStepId);
  const selectedStepIndex = Math.max(dagSteps.findIndex((step) => step.id === selectedStep?.id), 0);
  const currentPoint = currentRun.failedStage !== "-"
    ? currentRun.failedStage
    : activeOrFailedStep?.title ?? (currentRun.status === "success" ? "전체 단계 완료" : "단계 정보 대기");

  return (
    <DialogShell
      aria-label={`${currentRun.runId} 실행 상세`}
      bodyClassName="run-dag-modal-body"
      closeLabel="닫기"
      contentClassName="run-dag-modal-panel"
      description={`${job.target} · ${formatCompactDateTime(currentRun.startedAt)}`}
      eyebrow="실행 관측"
      headerActions={<Button size="sm" type="button" variant="outline" aria-label="닫기" onClick={onClose}><X size={16} />닫기</Button>}
      headerClassName="run-dag-modal-header"
      onClose={onClose}
      showCloseButton={false}
      size="wide"
      title={currentRun.runId}
    >
      <section className="dag-body-content">
        <div className="dag-summary-grid">
          <MetricCard
            detail={formatDagStepTitle(currentPoint)}
            icon={<Activity aria-hidden="true" />}
            label="이 Run의 상태"
            size="compact"
            tone={currentRun.status === "failed" ? "failed" : currentRun.status === "success" ? "running" : "scheduled"}
            value={runStatusMeta[currentRun.status].label}
          />
          <MetricCard
            detail={`${formatCompactDateTime(currentRun.startedAt)} - ${formatCompactDateTime(currentRun.endedAt)}`}
            icon={<Clock3 aria-hidden="true" />}
            label="이 Run의 소요 시간"
            size="compact"
            value={currentRun.duration}
          />
          <MetricCard
            detail="성공한 단계 / 전체 단계"
            icon={<Workflow aria-hidden="true" />}
            label="완료 단계"
            size="compact"
            tone="total"
            value={`${completedSteps}/${dagSteps.length}`}
          />
          <MetricCard
            detail={`출력 ${currentRun.outputRows}`}
            icon={<Table2 aria-hidden="true" />}
            label="이 Run의 입력 행"
            size="compact"
            value={currentRun.inputRows}
          />
        </div>

        <article className="dag-workbench">
          <section className="dag-timeline-panel" aria-label="실행 타임라인">
            <PanelHeader
              className="min-h-16"
              description="단계를 선택하면 수집된 상태와 진단 메시지를 확인할 수 있습니다."
              icon={<Workflow aria-hidden="true" size={18} />}
              title="실행 단계"
            />
            <ScrollArea className="h-[430px]">
              {dagSteps.length ? (
                <Timeline
                  aria-label="실행 단계 목록"
                  className="px-5 py-4"
                  role="list"
                  value={selectedStepIndex + 1}
                >
                  {dagSteps.map((step, index) => (
                    <DagTimelineItem
                      active={selectedStep?.id === step.id}
                      index={index}
                      key={step.id}
                      onSelect={() => {
                        setSelectedStepId(step.id);
                        onAction("etl.dag.node_selected", `/api/etl/jobs/${job.id}/runs/${currentRun.runId}/steps/${step.id}`, step.id);
                      }}
                      step={step}
                    />
                  ))}
                </Timeline>
              ) : (
                <div className="grid min-h-[280px] place-items-center px-6 text-center text-sm font-bold text-slate-500">
                  이 Run에 수집된 실행 단계가 없습니다.
                </div>
              )}
            </ScrollArea>
          </section>

          <DagStepInspector contextId={currentRun.runId} key={selectedStep?.id ?? "empty"} step={selectedStep} />
        </article>
      </section>
    </DialogShell>
  );
}

function DagStatePill({ status }: { status: JobDagStepStatus }) {
  const statusMeta = dagStepStatusMeta[status];
  return <StatusBadge className="min-w-[58px] justify-center rounded-md" shape="compact" tone={getDagStatusTone(status)}>{statusMeta.label}</StatusBadge>;
}

function DagTimelineItem({
  active,
  index,
  onSelect,
  step,
}: {
  active: boolean;
  index: number;
  onSelect: () => void;
  step: JobDagStep;
}) {
  const timing = getDagStepTimingLabel(step);

  return (
    <TimelineItem className="group-data-[orientation=vertical]/timeline:ms-10 group-data-[orientation=vertical]/timeline:not-last:pb-5" role="listitem" step={index + 1}>
      <TimelineSeparator className={getDagTimelineSeparatorClassName(step.status)} />
      <TimelineIndicator className={getDagTimelineIndicatorClassName(step.status, active)}>
        {getDagStepStatusIcon(step.status)}
      </TimelineIndicator>
      <button
        aria-current={active ? "step" : undefined}
        className={cn(
          "group w-full py-0.5 text-left transition-transform duration-200 ease-out hover:translate-x-0.5 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-4",
          active && "translate-x-1",
        )}
        type="button"
        onClick={onSelect}
      >
        <TimelineHeader>
          <span className="flex flex-wrap items-center gap-2">
            <TimelineTitle className={cn("text-lg font-extrabold leading-6 text-slate-950 transition-colors", active && "text-blue-700")}>
              {formatDagStepTitle(step.title)}
            </TimelineTitle>
            <DagStatePill status={step.status} />
          </span>
        </TimelineHeader>
        <TimelineContent className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-slate-500">
          <span>{step.meta}</span>
          <span aria-hidden="true">·</span>
          <span>{timing.duration}</span>
        </TimelineContent>
        <TimelineDate className="mt-1 mb-0 text-sm font-semibold text-slate-500" dateTime={step.completedAt}>
          {timing.completedAt}
        </TimelineDate>
      </button>
    </TimelineItem>
  );
}

function DagStepInspector({ contextId, step }: { contextId: string; step?: JobDagStep }) {
  if (!step) {
    return (
      <aside className="dag-step-inspector dag-step-inspector-empty">
        <TerminalSquare aria-hidden="true" size={24} />
        <strong>표시할 실행 단계가 없습니다.</strong>
        <p>이 Run의 단계 정보가 수집되면 여기에서 상세 상태를 확인할 수 있습니다.</p>
      </aside>
    );
  }

  const details = [["단계 상태", dagStepStatusMeta[step.status].label], ...(step.details ?? [])];
  const messages = (step.logs ?? []).filter(Boolean);

  return (
    <aside className="dag-step-inspector" aria-label={`${step.title} 상세`}>
      <header>
        <span>선택한 단계</span>
        <div>
          <h3>{formatDagStepTitle(step.title)}</h3>
          <DagStatePill status={step.status} />
        </div>
        <p>{step.meta}</p>
      </header>

      <dl className="dag-step-detail-list">
        {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "-"}</dd></div>)}
      </dl>

      <section className="dag-step-message">
        <div>
          <span>진단 메시지</span>
          {messages.length > 1 && <em>{messages.length}개</em>}
        </div>
        {messages.length ? (
          <ul>{messages.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>
        ) : (
          <p>{step.note || `${contextId}의 단계 메시지가 아직 수집되지 않았습니다.`}</p>
        )}
      </section>
    </aside>
  );
}

function getSelectedDagStep(steps: JobDagStep[], selectedStepId: string | null) {
  if (selectedStepId) {
    const selectedStep = steps.find((step) => step.id === selectedStepId);
    if (selectedStep) return selectedStep;
  }

  return steps.find((step) => step.status === "failed" || step.status === "running" || step.status === "blocked") ?? steps[0];
}

function getDagStepStatusIcon(status: JobDagStepStatus) {
  if (status === "success") return <Check aria-hidden="true" className="size-4" strokeWidth={2.5} />;
  if (status === "failed") return <X aria-hidden="true" className="size-4" strokeWidth={2.5} />;
  if (status === "running") return <Spinner aria-label="진행 중" className="size-4" />;
  if (status === "blocked") return <TerminalSquare aria-hidden="true" className="size-4" />;
  return <Clock3 aria-hidden="true" className="size-4" />;
}

function getDagTimelineIndicatorClassName(status: JobDagStepStatus, active: boolean) {
  const baseClassName = cn(
    "flex size-7 items-center justify-center border-none shadow-sm transition-[box-shadow,transform] duration-200 group-data-[orientation=vertical]/timeline:-left-7",
    active && "scale-105 ring-4 ring-blue-100",
  );

  if (status === "success") return `${baseClassName} border-emerald-500 bg-emerald-500 text-white`;
  if (status === "failed") return `${baseClassName} border-red-500 bg-red-500 text-white`;
  if (status === "running") return `${baseClassName} border-blue-500 bg-white text-blue-600 shadow-[0_0_0_5px_rgba(59,130,246,0.12)]`;
  if (status === "blocked") return `${baseClassName} border-slate-400 bg-slate-100 text-slate-600`;
  return `${baseClassName} border-slate-300 bg-white text-slate-500`;
}

function getDagTimelineSeparatorClassName(status: JobDagStepStatus) {
  const baseClassName = "transition-colors duration-200 group-data-[orientation=vertical]/timeline:-left-7 group-data-[orientation=vertical]/timeline:h-[calc(100%-1.75rem-0.25rem)] group-data-[orientation=vertical]/timeline:translate-y-7";

  if (status === "success") return `${baseClassName} bg-emerald-300!`;
  if (status === "failed") return `${baseClassName} bg-red-300!`;
  if (status === "running") return `${baseClassName} bg-blue-300!`;
  return `${baseClassName} bg-slate-200!`;
}

function getDagStepTimingLabel(step: JobDagStep) {
  const duration = step.duration
    ?? (step.status === "running" ? "진행 중" : step.status === "pending" || step.status === "blocked" ? "미실행" : "소요시간 미수집");
  const completedAt = step.completedAt
    ? `${formatCompactDateTime(step.completedAt)} 완료`
    : step.status === "running"
      ? "현재 실행 중"
      : step.status === "blocked"
        ? "이전 단계 완료 대기"
        : step.status === "pending"
          ? "실행 대기"
          : "완료 시각 미수집";

  return { completedAt, duration };
}

function formatDagStepTitle(title: string) {
  return title.replace(/^\d+\.\s*/, "");
}
