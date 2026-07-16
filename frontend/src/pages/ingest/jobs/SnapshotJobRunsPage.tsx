import { useMemo, useState } from "react";

import type { ColumnDef } from "@tanstack/react-table";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "@/components/reui/timeline";
import { Activity, BarChart3, Check, Clock3, History, RefreshCw, Table2, TerminalSquare, Workflow, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { DataTableCellPrimary, DataTableCellSecondary, DataTableStackedCell } from "@/components/ui/data-table-stacked-cell";

import { DialogShell } from "@/components/ui/dialog-shell";

import { MetricCard } from "@/components/ui/metric-card";

import { Panel, PanelHeader } from "@/components/ui/panel";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AuditResult, JobDagStep, JobDagStepStatus, JobExecutionEvidence, JobRowData, JobRunStatus, JobRunSummary } from "../../../types";

import { normalizeWhitespace, truncateText } from "./jobDetailModel";
import { JobDetailHeader } from "./JobDetailPage";
import { RunStatusFilter } from "./JobsLandingPage";
import { JobRunsPageProps } from "./jobRunsModel";
import { dagStepStatusMeta, formatCompactDateTime, getDagStatusTone, getRunStatusTone, runStatusFilterOrder, runStatusMeta } from "./jobShared";

export function SnapshotJobRunsPage({
  evidence,
  job,
  onAction,
  onBack,
  onCommand,
  onRefresh,
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
                <Button size="sm" type="button" variant="outline" onClick={() => {
                  onAction("etl.runs.refreshed", `/api/etl/jobs/${job.id}/runs`, job.id);
                  onRefresh?.();
                }}>
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

export function RunStatusPill({ status }: { status: JobRunStatus }) {
  const statusMeta = runStatusMeta[status];

  return (
    <StatusBadge className="min-w-[74px] justify-center rounded-md text-base" shape="compact" size="lg" tone={getRunStatusTone(status)}>
      {status === "running" && <Spinner className="size-3.5" aria-label="실행 중" />}
      {statusMeta.label}
    </StatusBadge>
  );
}

export function getRunResultSummary(run: JobRunSummary) {
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

export function getRunStartedAtSortValue(startedAt: string) {
  const normalized = startedAt.includes("T") ? startedAt : startedAt.replace(" ", "T");
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function RunLogModal({ job, onClose, run }: { job: JobRowData; onClose: () => void; run: JobRunSummary }) {
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

export function RunDagModal({
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

export function DagStatePill({ status }: { status: JobDagStepStatus }) {
  const statusMeta = dagStepStatusMeta[status];
  return <StatusBadge className="min-w-[58px] justify-center rounded-md" shape="compact" tone={getDagStatusTone(status)}>{statusMeta.label}</StatusBadge>;
}

export function DagTimelineItem({
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

export function DagStepInspector({ contextId, step }: { contextId: string; step?: JobDagStep }) {
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

export function getSelectedDagStep(steps: JobDagStep[], selectedStepId: string | null) {
  if (selectedStepId) {
    const selectedStep = steps.find((step) => step.id === selectedStepId);
    if (selectedStep) return selectedStep;
  }

  return steps.find((step) => step.status === "failed" || step.status === "running" || step.status === "blocked") ?? steps[0];
}

export function getDagStepStatusIcon(status: JobDagStepStatus) {
  if (status === "success") return <Check aria-hidden="true" className="size-4" strokeWidth={2.5} />;
  if (status === "failed") return <X aria-hidden="true" className="size-4" strokeWidth={2.5} />;
  if (status === "running") return <Spinner aria-label="진행 중" className="size-4" />;
  if (status === "blocked") return <TerminalSquare aria-hidden="true" className="size-4" />;
  return <Clock3 aria-hidden="true" className="size-4" />;
}

export function getDagTimelineIndicatorClassName(status: JobDagStepStatus, active: boolean) {
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

export function getDagTimelineSeparatorClassName(status: JobDagStepStatus) {
  const baseClassName = "transition-colors duration-200 group-data-[orientation=vertical]/timeline:-left-7 group-data-[orientation=vertical]/timeline:h-[calc(100%-1.75rem-0.25rem)] group-data-[orientation=vertical]/timeline:translate-y-7";

  if (status === "success") return `${baseClassName} bg-emerald-300!`;
  if (status === "failed") return `${baseClassName} bg-red-300!`;
  if (status === "running") return `${baseClassName} bg-blue-300!`;
  return `${baseClassName} bg-slate-200!`;
}

export function getDagStepTimingLabel(step: JobDagStep) {
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

export function formatDagStepTitle(title: string) {
  return title.replace(/^\d+\.\s*/, "");
}
