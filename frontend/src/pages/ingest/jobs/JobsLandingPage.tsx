import { useCallback, useMemo, useState } from "react";
import type React from "react";
import type { ColumnDef } from "@tanstack/react-table";

import { Activity, AlertCircle, Check, Database, Filter, ListChecks, Plus, Search, X } from "lucide-react";

import { SourceBrandIcon } from "../../../components/source/SourceBrand";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { Button } from "@/components/ui/button";

import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { DataTableCellPrimary, DataTableStackedCell } from "@/components/ui/data-table-stacked-cell";

import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { FilterToolbar, FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { IconButton } from "@/components/ui/icon-button";

import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AuditResult, JobCommand, JobListFacets, JobListQuery, JobRowData, JobRunStatus, JobScheduleKind, JobStatus } from "../../../types";

import { OwnerIdentity, StatusPill, getJobListSourceDisplay, hasLatestSuccessfulRun } from "./jobDetailModel";
import { JobListActionIcon, JobListActionKind, JobMetric, JobMetricTone, JobsTableRow, LatestRunModalSelection, filterJobsBySearch, formatJobLastRun, formatJobSchedule, formatNextScheduledRun, getJobActionButtonVariant, getJobListActionButtonClassName, getJobListActions, getJobMetrics, getJobTableRowClassName, getJobsQueryPath, getLatestRunOutcome, getNextScheduledRunDate, getRunStatusFilterDotClassName, hasSameStatuses, matchesJobListQuery, runStatusMeta } from "./jobShared";
import { RunDagModal } from "./SnapshotJobRunsPage";

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
            icon={<Activity size={16} />}
            iconClassName="size-11 border border-blue-100 bg-white text-blue-700 shadow-sm [&_svg]:size-[22px]"
            size="section"
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

export function JobStatusFilterCard({
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

export function JobFailureAlert({
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

export function JobsToolbar({
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

export type JobsTableSectionProps = {
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

export function JobStatusFilter({
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

export function RunStatusFilter({
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

export function JobOwnerFilter({
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

export function ScheduleKindFilter({
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

export function JobsTableSection({
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
          icon={<ListChecks size={16} />}
          iconClassName="size-11 border border-blue-100 bg-white text-blue-700 shadow-sm [&_svg]:size-[22px]"
          size="section"
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
