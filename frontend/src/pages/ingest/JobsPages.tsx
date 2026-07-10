import { useCallback, useMemo, useState } from "react";
import type React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  AlertCircle,
  Calendar,
  CalendarOff,
  Check,
  CircleUser,
  Clock3,
  Database,
  Download,
  FileText,
  Filter,
  HardDrive,
  History,
  Info,
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
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { ActionGroup } from "@/components/ui/action-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { KeyValueList } from "@/components/ui/key-value-list";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, type StatusBadgeTone } from "@/components/ui/status-badge";
import { TagList } from "@/components/ui/tag-list";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Field } from "../../components/common";
import type { AuditResult, JobCommand, JobDagStep, JobDagStepStatus, JobExecutionEvidence, JobListFacets, JobListQuery, JobRowData, JobRunStatus, JobRunSummary, JobScheduleKind, JobStats, JobStatus } from "../../types";
import { jobStatusMeta } from "../../utils/statusMeta";

const runStatusMeta: Record<JobRunStatus, { className: string; label: string }> = {
  queued: { className: "scheduled", label: "대기 중" },
  running: { className: "running", label: "실행 중" },
  failed: { className: "failed", label: "실패" },
  success: { className: "success", label: "성공" },
  canceled: { className: "canceled", label: "취소됨" },
};

const dagStepStatusMeta: Record<JobDagStepStatus, { className: string; label: string }> = {
  pending: { className: "paused", label: "대기" },
  running: { className: "running", label: "진행" },
  success: { className: "success", label: "성공" },
  failed: { className: "failed", label: "실패" },
  blocked: { className: "paused", label: "중단" },
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
          emptyBody={hasSearchQuery ? "검색어와 일치하는 수집/처리 작업이 없습니다. 검색어를 지우거나 다른 작업명, 소스명, 타깃 데이터셋명을 입력해 보세요." : "소스 연결과 스키마 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다."}
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
          placeholder="작업명, 소스명, 타깃 데이터셋명 검색"
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
      cell: ({ row }) => <DataTableCellPrimary className="text-lg">{formatCompactDateTime(row.original.job.nextRun)}</DataTableCellPrimary>,
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
          <DataTableStackedCell className="gap-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
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
            <Button className="h-auto justify-self-start px-0 py-0 text-base" size="sm" type="button" variant="link" onClick={() => onRuns(job)}>
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

function getJobListActionButtonClassName(action: JobListAction) {
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
      { className: "job-action-button primary", kind: "retry", label: "다시 실행" },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }

  if (job.status === "stopped") {
    if (isRealtimeJob(job)) {
      return [
        {
          className: "job-action-button primary realtime-start",
          kind: getLatestRunOutcome(job) === "failed" ? "retry" : "run",
          label: "실행",
        },
        { className: "job-action-button", kind: "edit", label: "수정" },
        { className: "job-action-button danger", kind: "delete", label: "삭제" },
      ];
    }
    return [
      {
        className: "job-action-button primary",
        kind: "resumeSchedule",
        label: "스케줄 재개",
      },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }

  const executionAction = getIdleExecutionAction(job);
  const detailActions: JobDetailAction[] = [
    { className: "job-action-button", kind: "edit", label: "수정" },
  ];
  const scheduleAction = getActiveScheduleAction(job);
  if (scheduleAction) detailActions.push(scheduleAction);
  detailActions.push({ ...executionAction, className: "job-action-button primary" });
  detailActions.push({ className: "job-action-button danger", kind: "delete", label: "삭제" });
  return detailActions;
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
  return (
    <StatusBadge className="min-w-[160px] justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2.5 text-base font-semibold" tone={getJobStatusTone(job.status)}>
      {job.status === "running" && <Spinner className="size-4" aria-label="실행 중" />}
      {jobStatusMeta[job.status].label}
    </StatusBadge>
  );
}

function OwnerIdentity({ job }: { job: JobRowData }) {
  const timestamp = job.updatedAt ?? job.createdAt;
  const timestampLabel = job.updatedAt ? "최근 수정" : "생성";

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

type SchemaDetailRow = [string, string, string, string, string, string];
type RuleDetailRow = [string, string, string, string];

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

function schemaRowsForJob(job: JobRowData, stats: JobStats): SchemaDetailRow[] {
  const sourcePath = job.source.split(" / ")[1] ?? job.source;
  const run = job.runHistory?.[0];
  const issue = job.status === "failed" ? getJobExecutionDisplay(job).summary : job.status === "running" ? "처리 중" : "정상";

  return [
    ["1", "source", sourcePath, "raw_payload", "String", issue],
    ["2", "schema columns", stats.schemaColumns, "inferred_schema", "JSON", issue],
    ["3", "input rows", stats.inputRows, "source_rows", "Integer", run?.status === "failed" ? "실패 run 기준" : "최근 run 기준"],
    ["4", "output rows", stats.outputRows, "target_rows", "Integer", run?.status === "failed" ? "실패 run 기준" : "최근 run 기준"],
    ["5", "sample scope", stats.sampleScope, "sample_window", "String", "생성 시점 metadata"],
  ];
}

function ruleRowsForJob(job: JobRowData): RuleDetailRow[] {
  const steps = job.dagSteps ?? [];
  if (steps.length > 0) {
    return steps.map((step) => [
      step.title,
      step.meta,
      step.note ?? "-",
      step.status.toUpperCase(),
    ]);
  }

  const stage = job.progress?.label ?? jobStatusMeta[job.status].summaryLabel;
  const state = job.status === "failed" ? "FAILED" : job.status === "running" ? "RUNNING" : job.status === "canceled" ? "CANCELED" : "PENDING";

  return [
    ["소스 검증", job.source, "백엔드 커넥터 결과", state],
    ["스키마 추론", stage, "추론된 메타데이터", state],
    ["Create handoff", job.target, "job/dataset response", state],
  ];
}

function DetailSummaryStat({ label, tone, value }: { label: string; tone?: "danger" | "running" | "scheduled" | "canceled"; value: string }) {
  return (
    <div className={tone ? `detail-summary-stat ${tone}` : "detail-summary-stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type JobNextAction = {
  kind: "resumeSchedule" | "run" | "retry";
  label: string;
};

function getJobNextAction(job: JobRowData): JobNextAction {
  if (isRealtimeJob(job)) {
    return {
      kind: getLatestRunOutcome(job) === "failed" ? "retry" : "run",
      label: "실행",
    };
  }
  if (job.status === "failed" || job.status === "canceled") return { kind: "retry", label: "재실행 요청" };
  if (job.status === "paused") return { kind: "retry", label: "다시 실행" };
  if (job.status === "stopped") {
    return {
      kind: "resumeSchedule",
      label: isRealtimeJob(job) ? "실행" : "스케줄 재개",
    };
  }
  return { kind: "run", label: "즉시 실행" };
}

function JobDetailHeader({
  activeTab,
  job,
  onAction,
  onCommand,
  onDetail,
  onEdit,
  onRuns,
}: {
  activeTab: "detail" | "runs";
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onDetail: () => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  const runAction = (action: JobCommand) => {
    onCommand(job, action);
  };

  return (
    <header className="job-detail-header">
      <button className="job-detail-breadcrumb" type="button" onClick={onDetail}>수집/처리 &gt; 작업 목록</button>
      <div className="job-detail-title-row">
        <div>
          <h1>{job.name}</h1>
          <TagList className="job-detail-meta" density="compact">
            <StatusPill job={job} />
            <Chip className="owner-chip" tone="outline">Owner: {job.owner}</Chip>
            <Chip className="tag-chip" tone="secondary">{job.tag.replace("[", "").replace("]", "")}</Chip>
          </TagList>
        </div>
        <ActionGroup className="job-detail-actions" density="compact">
          {getJobDetailActions(job).map((action) => (
            <Button className={action.className} key={action.label} size="sm" type="button" variant={getJobActionButtonVariant(action.className)} onClick={() => runAction(action.kind)}>{action.label}</Button>
          ))}
        </ActionGroup>
      </div>
      <SegmentedTabs
        ariaLabel="작업 상세 탭"
        className="job-detail-tabs"
        items={[
          { label: "작업 상세 정보", value: "detail" },
          { label: "실행 이력", value: "runs" },
        ]}
        value={activeTab}
        onValueChange={(value) => {
          if (value === "detail") onDetail();
          else onRuns();
        }}
      />
    </header>
  );
}

export function JobDetailPage({
  job,
  onAction,
  onBack,
  onCommand,
  onEdit,
  onRuns,
}: {
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  const sourceType = job.source.split(" / ")[0] ?? job.source;
  const sourcePath = job.source.split(" / ")[1] ?? job.source;
  const stats = job.stats ?? fallbackJobStats(job);
  const physicalOutputPath = job.targetPath ?? stats.outputPath ?? `lake/${job.target}`;
  const executionDisplay = getJobExecutionDisplay(job);
  const latestRunId = job.runHistory?.[0]?.runId ?? "-";
  const primaryAction = getJobNextAction(job);
  const showPrimaryAction = job.status !== "running";
  const stripTone = job.status === "failed" ? "danger" : job.status === "running" ? "running" : job.status === "canceled" ? "canceled" : "scheduled";
  const stripTitle = job.status === "failed"
    ? "최근 실행 실패"
    : job.status === "running"
      ? "현재 실행 중"
      : job.status === "paused"
        ? "작업 일시정지"
        : job.status === "canceled"
          ? "최근 실행 취소"
          : job.status === "stopped"
            ? isRealtimeJob(job) ? "실시간 수집 중지" : "스케줄 일시중지"
            : "스케줄 정상";
  const schemaRows = schemaRowsForJob(job, stats);
  const ruleRows = ruleRowsForJob(job);

  return (
    <div className="job-detail-page">
      <JobDetailHeader activeTab="detail" job={job} onAction={onAction} onCommand={onCommand} onDetail={onBack} onEdit={onEdit} onRuns={onRuns} />

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>작업 핵심 정보</h2>
        </div>
        <div className="job-detail-overview-grid">
          <article className={`job-ops-summary-card ${stripTone}`}>
            <div className="job-ops-main">
              <span className="job-ops-kicker">{stripTitle}</span>
              <h3>{executionDisplay.summary}</h3>
            </div>
            {showPrimaryAction && (
              <div className="job-next-actions">
                <Button className="job-action-button primary" size="sm" type="button" onClick={() => onCommand(job, primaryAction.kind)}>{primaryAction.label}</Button>
              </div>
            )}
            <div className="job-summary-stat-grid">
              <DetailSummaryStat label="최근 Run" value={latestRunId} />
              <DetailSummaryStat label="마지막 실행" value={formatCompactDateTime(job.lastRun)} />
              <DetailSummaryStat label="다음 실행" value={job.nextRun} />
            </div>
          </article>
          <article className="job-detail-card metadata-card">
            <h3>기본 메타</h3>
            <KeyValueList
              className="detail-plain-kv-grid"
              items={[
                { label: "Job ID", value: job.id },
                { label: "Target", value: job.target },
                { className: "wide", label: "소스", value: job.source },
                { className: "wide", label: "운영 조직", value: job.owner === "admin" ? "Data Platform" : "Analytics Ops" },
              ]}
            />
          </article>
        </div>
      </section>

      <details className="job-detail-disclosure">
        <summary>
          <div>
            <h2>소스 / 타겟 설정</h2>
          </div>
          <span className="disclosure-indicator">펼치기</span>
        </summary>
        <div className="job-detail-disclosure-body">
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>소스 연결 설정</h3>
            <div className="detail-kv-grid">
              <Field label="소스 유형" value={sourceType} />
              <Field label="소스 경로" value={sourcePath} />
              <Field label="연결 상태" value={job.status === "failed" ? "생성 시 검증됨 · 처리 실패" : "생성 시 소스 검증 완료"} />
              <Field label="인증 방식" value={sourceType.includes("S3") || sourceType.includes("File") ? "S3 호환 access key" : sourceType.includes("Kafka") ? "Backend Kafka connector" : "Backend source connector"} />
              <Field label="읽기 방식" value={job.status === "running" ? "Streaming" : "Batch Scan"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Target 저장 설정</h3>
            <div className="detail-kv-grid">
              <Field label="타깃 데이터셋" value={job.target} />
              <Field label="Lake 경로" value={physicalOutputPath} />
              <Field label="저장 포맷" value="Parquet" />
              <Field label="쓰기 모드" value={job.status === "running" ? "Append Stream" : "Append + compact"} />
              <Field label="품질 체크" value={job.status === "failed" ? "변환 전 중단" : "행 수 / 스키마 검사"} />
            </div>
            <div className="detail-meta-line">
              <span>Downstream: SQL · Dashboard · Catalog</span>
            </div>
          </article>
        </div>
        </div>
      </details>

      <details className="job-detail-disclosure">
        <summary>
          <div>
            <h2>스키마 / 변환</h2>
          </div>
          <span className="disclosure-indicator">펼치기</span>
        </summary>
        <div className="job-detail-disclosure-body">
        <DetailTableSection
          className="detail-table-card"
          headerClassName="detail-table-header"
          meta={<span>5 컬럼</span>}
          title="스키마 매핑"
        >
          <table className="schema-table detail-table">
            <thead>
              <tr>
                <th>순서</th>
                <th>소스 필드</th>
                <th>타깃 필드</th>
                <th>추론 타입</th>
                <th>Nullable</th>
                <th>이슈</th>
              </tr>
            </thead>
            <tbody>
              {schemaRows.map((row) => (
                <tr className={row[5].includes("실패") ? "detail-row-danger" : row[5].includes("처리") || row[5].includes("대기") ? "detail-row-running" : ""} key={row[0]}>{row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </DetailTableSection>
        <DetailTableSection
          className="detail-table-card"
          headerClassName="detail-table-header"
          meta={<span>{ruleRows.length} rules</span>}
          title="변환 규칙"
        >
          <table className="schema-table detail-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>대상 필드</th>
                <th>Config</th>
                <th>오류 시</th>
              </tr>
            </thead>
            <tbody>
              {ruleRows.map((row) => (
                <tr className={row[3] === "FAILED" ? "detail-row-danger" : row[3] === "RUNNING" || row[3] === "PENDING" ? "detail-row-running" : ""} key={row[0]}>{row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </DetailTableSection>
        </div>
      </details>

      <details className="job-detail-disclosure">
        <summary>
          <div>
            <h2>Schedule / Permission</h2>
          </div>
          <span className="disclosure-indicator">펼치기</span>
        </summary>
        <div className="job-detail-disclosure-body">
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>Schedule</h3>
            <div className="detail-kv-grid">
              <Field label="실행 유형" value={job.status === "running" ? "실시간 수집" : "반복 스케줄"} />
              <Field label="주기" value={job.schedule} />
              <Field label="다음 실행" value={job.nextRun} />
              <Field label="재시도 정책" value={job.status === "failed" ? "3회 · backoff 10m" : "3회 · backoff 5m"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Permission</h3>
            <div className="detail-kv-grid">
              <Field label="Owner" value={job.owner} />
              <Field label="접근 그룹" value="Data Platform, Analytics" />
              <Field label="canRun" value={job.status === "failed" ? "Owner 승인 후 가능" : "true"} />
              <Field label="승인 상태" value={job.status === "failed" ? "재실행 승인 필요" : "승인됨"} />
            </div>
          </article>
        </div>
        </div>
      </details>
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
  const runColumns: ColumnDef<JobRunSummary>[] = [
    {
      accessorKey: "runId",
      header: "Run ID",
      cell: ({ row }) => (
        <DataTableCellPrimary className="max-w-[180px] text-base font-bold" title={row.original.runId}>
          {row.original.runId}
        </DataTableCellPrimary>
      ),
      meta: { widthClassName: "w-[180px]" } satisfies DataTableColumnMeta,
    },
    {
      accessorKey: "status",
      header: "상태",
      cell: ({ row }) => <RunStatusPill status={row.original.status} />,
      meta: { widthClassName: "w-[90px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "executionTime",
      header: "실행 시간",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary className="whitespace-nowrap text-base font-semibold tabular-nums">
            {formatCompactDateTime(row.original.startedAt)}
          </DataTableCellPrimary>
          <DataTableCellSecondary className="whitespace-nowrap text-sm tabular-nums">
            종료 {formatCompactDateTime(row.original.endedAt)} · {row.original.duration}
          </DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { widthClassName: "w-[245px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "throughput",
      header: "처리 행",
      cell: ({ row }) => (
        <DataTableStackedCell>
          <DataTableCellPrimary className="text-base font-semibold tabular-nums">{row.original.inputRows} → {row.original.outputRows}</DataTableCellPrimary>
          <DataTableCellSecondary className="text-sm">입력 → 출력</DataTableCellSecondary>
        </DataTableStackedCell>
      ),
      meta: { widthClassName: "w-[205px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "resultSummary",
      header: "결과 요약",
      cell: ({ row }) => {
        const result = getRunResultSummary(row.original);
        return (
          <DataTableStackedCell>
            <DataTableCellPrimary className={row.original.status === "failed" ? "text-base font-bold text-red-700" : "text-base font-semibold"}>{result.title}</DataTableCellPrimary>
            <DataTableCellSecondary className="max-w-[280px] text-sm" title={result.detail}>{result.detail}</DataTableCellSecondary>
          </DataTableStackedCell>
        );
      },
      meta: { widthClassName: "w-[250px]" } satisfies DataTableColumnMeta,
    },
    {
      id: "actions",
      header: "액션",
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-4">
          <Button className="text-base font-bold" size="content" type="button" variant="link" onClick={() => openRunLog(row.original)}>
            <FileText aria-hidden="true" />
            로그
          </Button>
          <Button className="text-base font-bold" size="content" type="button" variant="link" onClick={() => openRunDetail(row.original)}>
            <Workflow aria-hidden="true" />
            실행 단계
          </Button>
        </div>
      ),
      meta: { widthClassName: "w-[190px]" } satisfies DataTableColumnMeta,
    },
  ];

  const statusFilterLabels: Record<"all" | JobRunStatus, string> = {
    all: "전체 상태",
    queued: "대기 중",
    running: "실행 중",
    success: "성공",
    failed: "실패",
    canceled: "취소됨",
  };

  return (
    <div className="job-detail-page job-runs-page">
      <JobDetailHeader activeTab="runs" job={job} onAction={onAction} onCommand={onCommand} onDetail={onBack} onEdit={onBack} onRuns={() => undefined} />

      <section className="runs-body-content">
        <Panel overflow="visible">
          <PanelHeader icon={<BarChart3 aria-hidden="true" size={18} />} title="실행 통계 요약" />
          <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard detail="종료된 Run 기준" icon={<Check aria-hidden="true" />} label="성공률" tone="running" value={job.stats?.successRate ?? "-"} />
            <MetricCard detail="최근 집계 기준" icon={<Clock3 aria-hidden="true" />} label="평균 소요시간" value={job.stats?.averageDuration ?? "-"} />
            <MetricCard detail="누적 실행 횟수" icon={<History aria-hidden="true" />} label="총 실행" tone="total" value={totalRunsValue} />
            <MetricCard
              detail={latestRun ? formatCompactDateTime(latestRun.endedAt || latestRun.startedAt) : "실행 기록 없음"}
              icon={<Activity aria-hidden="true" />}
              label="최근 실행"
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
          <div className="flex min-w-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50/60 px-5 py-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline">
                  {statusFilterLabels[runStatusFilter]}
                  <Filter aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>실행 상태</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={runStatusFilter}
                  onValueChange={(value) => {
                    const nextValue = value as "all" | JobRunStatus;
                    setRunStatusFilter(nextValue);
                    onAction("etl.runs.status_filtered", `/api/etl/jobs/${job.id}/runs?status=${nextValue}`, job.id);
                  }}
                >
                  {(Object.entries(statusFilterLabels) as Array<["all" | JobRunStatus, string]>).map(([value, label]) => (
                    <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <DataTable
            bodyRowClassName="[&_td]:py-4"
            className="gap-0 [&_th]:text-sm [&_td]:text-base"
            columns={runColumns}
            data={filteredRuns}
            emptyState={{ title: runStatusFilter === "all" ? "아직 실행 이력이 없습니다." : "선택한 상태의 실행 이력이 없습니다." }}
            enableSorting={false}
            getRowClassName={(row) => row.original.status === "failed" ? "bg-red-50/45 hover:bg-red-50/70" : row.original.status === "canceled" ? "bg-slate-50/80" : undefined}
            pagination={{ label: "실행 이력", pageSize: 5, showSummary: true }}
            tableClassName="min-w-[1160px]"
            viewportClassName="rounded-none border-0"
          />
        </Panel>
      </section>
      {activeRun && <RunDagModal evidence={evidence} job={job} onAction={onAction} onClose={() => setActiveRun(null)} run={activeRun} />}
      {activeLogRun && <RunLogModal job={job} onClose={() => setActiveLogRun(null)} run={activeLogRun} />}
    </div>
  );
}

function RunStatusPill({ status }: { status: JobRunStatus }) {
  const statusMeta = runStatusMeta[status];

  return (
    <StatusBadge className="min-w-[74px] justify-center rounded-md text-sm" shape="compact" size="lg" tone={getRunStatusTone(status)}>
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
            className="min-h-[104px] gap-2.5"
            detail={formatDagStepTitle(currentPoint)}
            icon={<Activity aria-hidden="true" />}
            label="실행 상태"
            tone={currentRun.status === "failed" ? "failed" : currentRun.status === "success" ? "running" : "scheduled"}
            value={runStatusMeta[currentRun.status].label}
          />
          <MetricCard
            className="min-h-[104px] gap-2.5"
            detail={`${formatCompactDateTime(currentRun.startedAt)} - ${formatCompactDateTime(currentRun.endedAt)}`}
            icon={<Clock3 aria-hidden="true" />}
            label="소요 시간"
            value={currentRun.duration}
          />
          <MetricCard
            className="min-h-[104px] gap-2.5"
            detail="성공한 단계 / 전체 단계"
            icon={<Workflow aria-hidden="true" />}
            label="진행 단계"
            tone="total"
            value={`${completedSteps}/${dagSteps.length}`}
          />
          <MetricCard
            className="min-h-[104px] gap-2.5"
            detail={`출력 ${currentRun.outputRows}`}
            icon={<Table2 aria-hidden="true" />}
            label="입력 행"
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
            <div className="dag-timeline" role="list">
              {dagSteps.length ? dagSteps.map((step, index) => (
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
              )) : (
                <div className="dag-timeline-empty">이 Run에 수집된 실행 단계가 없습니다.</div>
              )}
            </div>
          </section>

          <DagStepInspector currentRun={currentRun} step={selectedStep} />
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
  const tone = dagStepStatusMeta[step.status].className;

  return (
    <div className="dag-timeline-entry" role="listitem">
      <button
        aria-current={active ? "step" : undefined}
        className={active ? `dag-timeline-item ${tone} active` : `dag-timeline-item ${tone}`}
        type="button"
        onClick={onSelect}
      >
        <span className="dag-timeline-marker">{getDagStepStatusIcon(step.status)}</span>
        <span className="dag-timeline-content">
          <span className="dag-timeline-kicker">단계 {index + 1}</span>
          <strong>{formatDagStepTitle(step.title)}</strong>
          <span className="dag-step-meta">{step.meta}</span>
        </span>
        <span className="dag-timeline-status"><DagStatePill status={step.status} /></span>
      </button>
    </div>
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
  if (status === "success") return <Check aria-hidden="true" size={14} />;
  if (status === "failed") return <X aria-hidden="true" size={14} />;
  if (status === "running") return <Spinner aria-label="진행 중" className="size-3.5" />;
  if (status === "blocked") return <TerminalSquare aria-hidden="true" size={13} />;
  return <Clock3 aria-hidden="true" size={14} />;
}

function formatDagStepTitle(title: string) {
  return title.replace(/^\d+\.\s*/, "");
}
