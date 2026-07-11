import { useCallback, useMemo, useState } from "react";
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
import { ActionGroup } from "@/components/ui/action-group";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import {
  DataTableCellPrimary,
  DataTableCellSecondary,
  DataTableStackedCell,
} from "@/components/ui/data-table-stacked-cell";
import { DetailTableSection } from "@/components/ui/detail-table-section";
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
  onRuns,
}: {
  jobListFacets: JobListFacets;
  jobsLoading: boolean;
  jobs: JobRowData[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => Promise<JobRowData | undefined>;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onFilter: (query: JobListQuery) => Promise<void> | void;
  onRuns: (job: JobRowData) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [jobQuery, setJobQuery] = useState<JobListQuery>({});
  const [excludedJobIds, setExcludedJobIds] = useState<Set<string>>(() => new Set());
  const metrics = getJobMetrics(jobListFacets);
  const failureFilterActive = jobQuery.lastRunOutcome === "failed";
  const failedRunCount = jobListFacets.latestRunOutcomeCounts.failed;
  const filteredJobs = useMemo(
    () => filterJobsBySearch(jobs, searchQuery).filter((job) => !excludedJobIds.has(job.id)),
    [excludedJobIds, jobs, searchQuery],
  );
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
        descriptionClassName="text-xl leading-8"
        description="데이터 소스를 연결하고 ETL 작업의 상태, 실행, 로그를 관리합니다."
        icon={<Database size={30} />}
        iconClassName="mt-0 size-16 rounded-xl"
        size="lg"
        title="수집/처리"
        titleClassName="text-4xl"
      />
      <div className="content-main jobs-panel-stack">
        <Panel className="jobs-metrics-card">
          <PanelHeader
            className="min-h-[68px] [&_h2]:text-xl"
            icon={<BarChart3 size={16} />}
            iconClassName="size-11 [&_svg]:size-[22px]"
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
          onRuns={onRuns}
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
    onCommand(job, action);
  }, [onCommand, onDetail]);
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

        return (
          <DataTableStackedCell className="gap-1.5">
            <DataTableCellPrimary className="text-xl leading-7">{job.target}</DataTableCellPrimary>
            <DataTableCellSecondary className="text-base" title={job.source}>{job.source}</DataTableCellSecondary>
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
      cell: ({ row }) => <DataTableCellPrimary className="text-lg">{row.original.job.schedule}</DataTableCellPrimary>,
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
      accessorFn: (row) => row.job.nextRun,
      cell: ({ row }) => (
        <div className="flex min-h-[76px] items-center">
          <DataTableCellPrimary className="text-lg leading-7">{formatCompactDateTime(row.original.job.nextRun)}</DataTableCellPrimary>
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
            <Button className="absolute left-0 top-[calc(50%+18px)] h-auto px-0 py-0 text-base" size="sm" type="button" variant="link" onClick={() => onRuns(job)}>
              실행 이력
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
          icon={<Table2 size={16} />}
          iconClassName="size-11 [&_svg]:size-[22px]"
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

type JobListActionKind = Exclude<JobCommand, "delete"> | "detail";

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
  const showScheduledBatchProgress = job.status === "running"
    && hasAutomaticSchedule(job)
    && !isRealtimeJob(job)
    && job.progress !== undefined;

  return (
    <div className={`grid h-full min-w-[184px] content-center justify-items-center gap-3 px-3 py-3 ${showScheduledBatchProgress ? "min-h-[116px]" : "min-h-[100px]"}`}>
      <StatusBadge
        className="min-w-[160px] justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2.5 text-base font-semibold"
        tone={getJobStatusTone(job.status)}
      >
        {job.status === "running" && <Spinner className="size-4" aria-label="실행 중" />}
        {jobStatusMeta[job.status].label}
      </StatusBadge>
      {showScheduledBatchProgress && job.progress ? (
        <div className="w-full text-left">
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
              {getOwnerInitials(job.owner)}
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
    <div className="flex min-w-0 items-center gap-2.5 text-left">
      <Avatar size="lg">
        {job.ownerAvatarUrl && <AvatarImage alt={`${job.owner} 프로필`} src={job.ownerAvatarUrl} />}
        <AvatarFallback className="bg-slate-100 font-semibold text-slate-700 ring-1 ring-slate-200">
          {getOwnerInitials(job.owner)}
        </AvatarFallback>
      </Avatar>
      <div className="grid min-w-0 gap-1">
        <span className="truncate text-lg font-semibold text-slate-800" title={job.owner}>{job.owner}</span>
        {timestamp && (
          <span className="truncate text-base font-medium text-slate-500" title={`${timestampLabel} ${timestamp}`}>
            {timestampLabel} {formatCompactDateTime(timestamp)}
          </span>
        )}
      </div>
    </div>
  );
}

function getOwnerInitials(owner: string) {
  const words = owner.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
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
  Aggregation: "집계 주기",
  "Bootstrap Server": "부트스트랩 서버",
  Bucket: "버킷",
  "Consumer Group": "컨슈머 그룹",
  Database: "데이터베이스",
  Dataset: "데이터셋",
  Format: "파일 형식",
  Header: "헤더 포함",
  Host: "호스트",
  "Incremental Key": "증분 기준 키",
  Offset: "시작 오프셋",
  Prefix: "경로 접두사",
  Table: "테이블",
  Topic: "토픽",
  Window: "집계 범위",
};

function getJobDetailFieldLabel(label: string) {
  return jobDetailFieldLabelMap[label] ?? label;
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

const transformRuleColumns: ColumnDef<TransformRuleRow>[] = [
  {
    accessorKey: "index",
    header: "순서",
    meta: { align: "center", widthClassName: "w-[80px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "label",
    header: "변환 규칙",
    cell: ({ row }) => (
      <DataTableStackedCell className="gap-1">
        <DataTableCellPrimary className="text-base font-bold">{row.original.label}</DataTableCellPrimary>
        <DataTableCellSecondary className="text-[13px] font-semibold">{row.original.operation}</DataTableCellSecondary>
      </DataTableStackedCell>
    ),
  },
  {
    id: "mapping",
    header: "입력 → 출력",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-semibold">{row.original.input} → {row.original.output}</DataTableCellPrimary>,
  },
  {
    accessorKey: "params",
    header: "설정",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-medium text-slate-700">{row.original.params || "-"}</DataTableCellPrimary>,
  },
  {
    accessorKey: "onError",
    header: "오류 처리",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-medium text-slate-700">{row.original.onError}</DataTableCellPrimary>,
  },
  {
    accessorKey: "enabled",
    header: "상태",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.enabled ? "success" : "muted"}>{row.original.enabled ? "활성" : "비활성"}</Badge>,
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
  const sourceType = job.source.split(" / ")[0] ?? job.source;
  const sourcePath = job.source.split(" / ")[1] ?? job.source;
  const stats = job.stats ?? fallbackJobStats(job);
  const realtime = isRealtimeJob(job);
  const totalRunsLabel = stats.totalRuns === "-" || stats.totalRuns.endsWith("회") ? stats.totalRuns : `${stats.totalRuns}회`;
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
              detail={realtime ? job.scheduleSummary ?? job.schedule : job.schedule}
              label={realtime ? "수집 방식" : "다음 실행"}
              tone="scheduled"
              value={realtime ? "실시간" : formatCompactDateTime(job.nextRun)}
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
              badge={job.sourceType ?? sourceType}
              icon={<Database aria-hidden="true" className="size-5" />}
              items={[
                { label: "소스 경로", value: job.sourceLabel ?? sourcePath },
                ...(job.sourceConfig ?? []).map(([label, value]) => ({ label: getJobDetailFieldLabel(label), value })),
              ]}
              title="소스"
              tone="source"
            />

            <JobEndpointCard
              badge={job.targetFormat ?? "데이터셋"}
              icon={<Table2 aria-hidden="true" className="size-5" />}
              items={[
                { label: "데이터셋", value: job.target },
                { label: "저장소", value: job.storageType ?? "설정 없음" },
                { label: "저장 경로", value: job.storagePath ?? physicalOutputPath },
                { label: "압축", value: job.compression ?? "사용 안 함" },
                { label: "파티션", value: job.partition ?? "사용 안 함" },
              ]}
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
                pagination={false}
                tableClassName="min-w-[980px]"
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
                <span className="text-sm font-semibold text-slate-500">{job.schedule} · 역할별 접근 권한</span>
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
                  { label: "실행 유형", value: isRealtimeJob(job) ? "실시간 수집" : "반복 스케줄" },
                  { label: "주기", value: job.schedule },
                  { label: "다음 실행", value: formatCompactDateTime(job.nextRun) },
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

export function JobRunsPage({
  evidence,
  job,
  onAction,
  onBack,
  onCommand,
}: {
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
}) {
  const [activeRun, setActiveRun] = useState<JobRunSummary | null>(null);
  const [activeLogRun, setActiveLogRun] = useState<JobRunSummary | null>(null);
  const [runStatusFilter, setRunStatusFilter] = useState<"all" | JobRunStatus>("all");
  const runs = evidence?.runs.length ? evidence.runs : job.runHistory ?? [];
  const runStatusCounts = useMemo(() => {
    const counts: Record<JobRunStatus, number> = { canceled: 0, failed: 0, queued: 0, running: 0, success: 0 };
    runs.forEach((run) => { counts[run.status] += 1; });
    return counts;
  }, [runs]);
  const availableRunStatuses = runStatusFilterOrder.filter((status) => runStatusCounts[status] > 0);
  const filteredRuns = runStatusFilter === "all" ? runs : runs.filter((run) => run.status === runStatusFilter);
  const latestRun = runs[0];
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
        {activeRun && <RunDagModal evidence={evidence} job={job} onAction={onAction} onClose={() => setActiveRun(null)} run={activeRun} />}
        {activeLogRun && <RunLogModal job={job} onClose={() => setActiveLogRun(null)} run={activeLogRun} />}
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
  const dagSteps = job.dagStepsByRunId?.[run.runId]
    ?? (evidence?.dagSteps.length ? evidence.dagSteps : job.dagSteps ?? []);
  const currentRun = run;
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

          <DagStepInspector currentRun={currentRun} key={selectedStep?.id ?? "empty"} step={selectedStep} />
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

function DagStepInspector({ currentRun, step }: { currentRun: JobRunSummary; step?: JobDagStep }) {
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
          <p>{step.note || `${currentRun.runId}의 단계 메시지가 아직 수집되지 않았습니다.`}</p>
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
    ? `${step.completedAt} 완료`
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
