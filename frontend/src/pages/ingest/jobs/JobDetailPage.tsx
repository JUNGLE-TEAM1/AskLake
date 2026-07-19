import { useCallback, useEffect, useState } from "react";

import { Activity, BarChart3, ArrowLeft, ArrowRight, Calendar, Copy, Database, HardDrive, RefreshCw, Repeat2, Settings, ShieldCheck, Table2, TerminalSquare } from "lucide-react";
import { Field } from "../../../components/common";
import { getSourceBrandMeta } from "../../../components/source/SourceBrand";

import { compactContinuousTarget, getContinuousMaintenanceRuns, getContinuousQuarantine, getContinuousWorkerLogs, replayContinuousQuarantine } from "../../../services/pipelineApi";
import type { ContinuousMaintenanceRun, ContinuousQuarantineRecord } from "../../../types";
import { permissionDeniedMessage } from "../../../utils/permissions";
import { ActionGroup } from "@/components/ui/action-group";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

import { Button } from "@/components/ui/button";

import { DataTable } from "@/components/ui/data-table";

import { DetailTableSection } from "@/components/ui/detail-table-section";

import { KeyValueList } from "@/components/ui/key-value-list";

import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";

import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";

import type { JobCommand, JobRowData } from "../../../types";
import { jobStatusMeta } from "../../../utils/statusMeta";
import { JobEndpointCard, JobEndpointItem, OperationSummaryItem, OutputSchemaRow, OwnerIdentity, PipelineFlowNode, QualityRuleRow, TransformRuleRow, compactSourceConfigItems, detailKeyValueListClassName, fallbackJobStats, formatOperationalDelay, formatOperationalRate, getJobExecutionDisplay, getRuleActionLabel, outputSchemaColumns, qualityRuleColumns, transformRuleColumns, validationTypeLabelMap } from "./jobDetailModel";
import { JobDetailActionIcon, continuousEngineLabel, continuousRuntimeLabel, continuousSchemaStatusLabels, formatCompactDateTime, formatJobSchedule, formatNextScheduledRun, getJobDetailActionClassName, getJobDetailActions, getJobScheduleKind, getJobStatusTone, isContinuousKafkaJob, isRealtimeJob, jobActionDisabled, realtimeHealthMeta, runStatusMeta } from "./jobShared";

export function JobDetailHeader({
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
              {getJobDetailActions(job).map((action) => {
                const disabled = jobActionDisabled(job, action.kind);
                return (
                  <Button
                    className={getJobDetailActionClassName(action)}
                    disabled={disabled}
                    key={action.label}
                    size="sm"
                    title={disabled ? permissionDeniedMessage("작업", action.label) : undefined}
                    type="button"
                    variant="outline"
                    onClick={() => runAction(action.kind)}
                  >
                    <JobDetailActionIcon action={action} job={job} />
                    {action.label}
                  </Button>
                );
              })}
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
              <span className="text-base font-[850] leading-tight text-slate-900">소스 / 타겟</span>
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
              <span className="text-base font-[850] leading-tight text-slate-900">스키마 / 변환 / 품질</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="grid gap-5 border-t border-slate-100 p-4">
            <DetailTableSection
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
              headerClassName="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200 px-5 [&_h3]:text-base [&_h3]:font-extrabold [&_h3]:text-slate-950"
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
              <span className="text-base font-[850] leading-tight text-slate-900">스케줄 / 권한</span>
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
                  { label: "실행 유형", value: isRealtimeJob(job) ? continuousEngineLabel(job) : getJobScheduleKind(job) === "none" ? "수동 실행 · Spark" : "반복 스케줄 · Spark" },
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

function ContinuousRuntimeErrorFields({ runtime }: { runtime: JobRowData["continuousRuntime"] }) {
  const diagnosticId = runtime?.errorDetail?.diagnosticId
    ?? (typeof runtime?.errorDetail?.context?.correlationId === "string" ? runtime.errorDetail.context.correlationId : null);
  const message = runtime?.errorDetail?.userMessage ?? runtime?.errorDetail?.message ?? runtime?.lastError;
  const [copied, setCopied] = useState(false);
  const copyDiagnostic = async () => {
    if (!diagnosticId || !navigator.clipboard) return;
    await navigator.clipboard.writeText(diagnosticId);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <>
      {message && <Field label="최근 오류" value={message} />}
      {diagnosticId && (
        <div className="grid content-start gap-1 text-sm">
          <span className="font-semibold text-slate-500">진단 ID</span>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 truncate text-slate-700" data-testid="continuous-diagnostic-id">{diagnosticId}</code>
            <Button aria-label="진단 ID 복사" size="content" type="button" variant="ghost" onClick={() => void copyDiagnostic()}>
              <Copy aria-hidden="true" className="size-3.5" />
              {copied ? "복사됨" : "복사"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export function ContinuousRuntimeCard({ job }: { job: JobRowData }) {
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
        setMaintenanceMessage(`격리 재처리 ${runStatusMeta[run.status].label} · 적재 ${stored.toLocaleString()} · 정책 거부 ${failed.toLocaleString()} · 이미 처리 ${skipped.toLocaleString()}`);
      } else {
        setMaintenanceMessage(`파일 컴팩션 ${runStatusMeta[run.status].label}`);
      }
      await refreshMaintenance();
    } catch (error) {
      setMaintenanceMessage(error instanceof Error ? error.message : "Maintenance 실행에 실패했습니다.");
    } finally {
      setMaintenanceBusy(false);
    }
  };
  return (
    <div className="job-continuous-runtime" data-testid="continuous-runtime-card">
      <Panel>
        <PanelHeader icon={<Activity aria-hidden="true" size={18} />} title="연속 수집 런타임" />
        <div className="job-runtime-panel-body">
          <div className="detail-kv-grid">
            <Field label="상태" value={continuousRuntimeLabel(job)} />
            <Field label="마지막 배치" value={runtime?.lastBatchId ?? "-"} />
            <Field label="소비 / 적재" value={`${runtime?.consumedCount?.toLocaleString() ?? "0"} / ${runtime?.storedCount?.toLocaleString() ?? "0"}`} />
            <Field label="격리 / 재처리" value={`${runtime?.quarantinedCount?.toLocaleString() ?? "0"} / ${runtime?.replayedCount?.toLocaleString() ?? "0"}`} />
            <Field label="실패" value={runtime?.failedCount?.toLocaleString() ?? "0"} />
            <Field label="Kafka 지연" value={runtime?.lagAvailable ? `${runtime.lag?.toLocaleString() ?? 0}건 · 최대 ${runtime.maxPartitionLag?.toLocaleString() ?? 0}` : "측정 대기"} />
            <Field label="처리량" value={runtime?.throughputRowsPerSecond != null ? `${runtime.throughputRowsPerSecond.toLocaleString()}행/초` : "-"} />
            <Field label="최근 배치" value={runtime?.lastBatchDurationMs != null ? `${runtime.lastBatchInputRows.toLocaleString()}건 · ${runtime.lastBatchDurationMs.toLocaleString()}ms` : "-"} />
            <Field label="스키마" value={`v${runtime?.schemaVersion ?? 1} · ${continuousSchemaStatusLabels[runtime?.schemaStatus ?? "stable"] ?? runtime?.schemaStatus ?? "정상"}`} />
            <Field label="규칙 계약" value={`v${runtime?.ruleContractVersion ?? "1.0"} · ${runtime?.ruleFingerprint?.slice(0, 10) ?? "대기"}`} />
            <Field label="규칙 처리" value={`경고 ${(Number(ruleMetrics.transformWarnCount ?? 0) + Number(ruleMetrics.qualityWarnCount ?? 0)).toLocaleString()} · 격리 ${(Number(ruleMetrics.transformQuarantinedCount ?? 0) + Number(ruleMetrics.qualityQuarantinedCount ?? 0)).toLocaleString()} · 실패 배치 ${Number(ruleMetrics.failedBatchCount ?? 0).toLocaleString()}`} />
            <Field label="하트비트" value={runtime?.heartbeatAt ? formatCompactDateTime(runtime.heartbeatAt) : "-"} />
            <Field label="체크포인트" value={runtime?.checkpointPath ?? "-"} />
            <ContinuousRuntimeErrorFields runtime={runtime} />
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          actions={<button className="job-action-button" disabled={loadingLogs} onClick={() => void loadLogs()} type="button"><RefreshCw size={15} />새로고침</button>}
          icon={<TerminalSquare aria-hidden="true" size={18} />}
          title="워커 로그"
        />
        <div className="job-runtime-panel-body">
          {logError ? <p className="job-inline-error">{logError}</p> : <pre className="job-runtime-log">{logs.length ? logs.join("\n") : loadingLogs ? "로그 불러오는 중..." : "표시할 로그가 없습니다."}</pre>}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          actions={(
            <div className="job-runtime-actions">
              <button className="job-action-button" disabled={maintenanceBlocked || maintenanceBusy || !quarantine.some((item) => item.replayStatus !== "replayed")} onClick={() => void runMaintenance("replay")} title={maintenanceBlocked ? "스트림을 중지한 뒤 실행할 수 있습니다." : undefined} type="button"><Repeat2 size={15} />전체 재처리</button>
              <button className="job-action-button" disabled={maintenanceBlocked || maintenanceBusy || (runtime?.storedCount ?? 0) === 0} onClick={() => void runMaintenance("compact")} title={maintenanceBlocked ? "스트림을 중지한 뒤 실행할 수 있습니다." : undefined} type="button"><HardDrive size={15} />파일 컴팩션</button>
            </div>
          )}
          icon={<HardDrive aria-hidden="true" size={18} />}
          title="격리 · 유지보수"
        />
        <div className="job-runtime-panel-body">
          {maintenanceMessage && <p className="panel-note">{maintenanceMessage}</p>}
          <div className="job-maintenance-summary">
            <span>격리 샘플 {quarantine.length.toLocaleString()}건</span>
            <span>실행 이력 {maintenanceRuns.length.toLocaleString()}건</span>
            <span>최근 {maintenanceRuns[0] ? `${maintenanceRuns[0].kind === "quarantine_replay" ? "격리 재처리" : "파일 컴팩션"} · ${runStatusMeta[maintenanceRuns[0].status].label}` : "-"}</span>
          </div>
          {quarantine.length > 0 && <div className="job-quarantine-list">{quarantine.slice(0, 5).map((item) => <div key={`${item.partition}:${item.offset}`}><code>{item.partition}:{item.offset}</code><span>{item.stage === "schema" ? "스키마" : item.ruleId ? `${item.stage ?? "rule"} · ${item.ruleId}` : "규칙"} · {item.reason}</span><span>{item.replayStatus}</span><span>{item.rawPayload}</span></div>)}</div>}
        </div>
      </Panel>
    </div>
  );
}
