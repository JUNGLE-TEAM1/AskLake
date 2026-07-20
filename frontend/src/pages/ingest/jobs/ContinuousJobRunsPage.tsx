import { useCallback, useEffect, useRef, useState } from "react";

import type { ColumnDef } from "@tanstack/react-table";
import { Timeline } from "@/components/reui/timeline";
import { Activity, AlertCircle, Clock3, Database, History, RefreshCw, Table2, Workflow, X, Zap } from "lucide-react";
import { Field } from "../../../components/common";

import { getCatalogDataset } from "../../../services/catalogApi";

import { getContinuousSessionBatches, getContinuousSessions } from "../../../services/pipelineApi";
import type { KafkaContinuousBatch, KafkaContinuousSession, KafkaContinuousSessionStatus } from "../../../types";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { DataTableCellPrimary, DataTableCellSecondary, DataTableStackedCell } from "@/components/ui/data-table-stacked-cell";

import { DialogShell } from "@/components/ui/dialog-shell";

import { IconButton } from "@/components/ui/icon-button";

import { MetricCard } from "@/components/ui/metric-card";

import { Panel, PanelHeader } from "@/components/ui/panel";

import { ScrollArea } from "@/components/ui/scroll-area";

import { StatusBadge } from "@/components/ui/status-badge";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { AuditResult, JobRowData } from "../../../types";

import { JobDetailHeader } from "./JobDetailPage";
import { retainedContinuousSessionId } from "./continuousSessionSelection";
import { ContinuousDagSelection, JobRunsPageProps, activeContinuousSessionStatuses, continuousBatchStatusMeta, continuousSessionStatusMeta } from "./jobRunsModel";
import { formatCompactDateTime } from "./jobShared";
import { DagStepInspector, DagTimelineItem, getSelectedDagStep } from "./SnapshotJobRunsPage";

export function ContinuousJobRunsPage({
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
  const selectionRequestSequenceRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(null);
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
      const nextSelectedId = retainedContinuousSessionId(nextSessions, selectedSessionIdRef.current);
      const nextSelectedSession = nextSessions.find((session) => session.sessionId === nextSelectedId) ?? null;
      const nextBatches = nextSelectedId
        ? await getContinuousSessionBatches(job.id, nextSelectedId, 100)
        : [];
      if (requestSequence !== requestSequenceRef.current) return { active: false, ok: true };
      setSessions(nextSessions);
      selectedSessionIdRef.current = nextSelectedId;
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
  }, [catalogDatasetId, catalogRowCount, job.id]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    inFlightRef.current = false;
    hasLoadedRef.current = false;
    activeSessionsRef.current = false;
    setSessions([]);
    selectedSessionIdRef.current = null;
    selectionRequestSequenceRef.current += 1;
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

  const selectSession = async (session: KafkaContinuousSession) => {
    const selectionRequestSequence = selectionRequestSequenceRef.current + 1;
    selectionRequestSequenceRef.current = selectionRequestSequence;
    selectedSessionIdRef.current = session.sessionId;
    setSelectedSessionId(session.sessionId);
    setSelectedSession(session);
    setBatches([]);
    setDagSelection(null);
    onAction("etl.continuous.session_opened", `/api/etl/jobs/${job.id}/continuous/sessions/${session.sessionId}`, session.sessionId);
    try {
      const nextBatches = await getContinuousSessionBatches(job.id, session.sessionId, 100);
      if (
        selectionRequestSequence === selectionRequestSequenceRef.current
        && selectedSessionIdRef.current === session.sessionId
      ) {
        setBatches(nextBatches);
        setRefreshError(null);
      }
    } catch {
      if (
        selectionRequestSequence === selectionRequestSequenceRef.current
        && selectedSessionIdRef.current === session.sessionId
      ) {
        setRefreshError("선택한 세션의 micro-batch를 불러오지 못했습니다. 다시 선택하거나 새로고침해 주세요.");
      }
    }
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
        <Button className="h-auto max-w-[210px] justify-start truncate px-0 text-left font-semibold" size="content" type="button" variant="link" onClick={(event) => {
          event.stopPropagation();
          void selectSession(row.original);
        }}>
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
              onRowClick={(row) => void selectSession(row.original)}
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

export function ContinuousSessionStatus({ status }: { status: KafkaContinuousSessionStatus }) {
  const meta = continuousSessionStatusMeta[status];
  return <StatusBadge className="min-w-[76px] justify-center" shape="compact" size="lg" tone={meta.tone}>{meta.label}</StatusBadge>;
}

export function ContinuousBatchStatus({ status }: { status: KafkaContinuousBatch["status"] }) {
  const meta = continuousBatchStatusMeta[status];
  return <StatusBadge className="min-w-[58px] justify-center" shape="compact" tone={meta.tone}>{meta.label}</StatusBadge>;
}

export function ContinuousDagModal({
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

export function formatContinuousDuration(startedAt: string, endedAt?: string | null) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt ?? new Date().toISOString());
  if (Number.isNaN(start) || Number.isNaN(end)) return "-";
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}시간 ${minutes}분` : minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export function formatContinuousEndReason(reason?: string | null) {
  const labels: Record<string, string> = {
    paused: "일시정지",
    start_failed: "시작 실패",
    stopped: "사용자 중지",
    worker_failed: "Worker 실패",
    worker_stopped: "Worker 종료",
  };
  return reason ? labels[reason] ?? reason : "-";
}

export function formatSourceRanges(ranges: KafkaContinuousBatch["sourceRanges"]) {
  if (!ranges.length) return "-";
  return ranges.map((range) => `${range.partition ?? 0}:${range.startOffset ?? 0}-${range.endOffset ?? 0}`).join(", ");
}
