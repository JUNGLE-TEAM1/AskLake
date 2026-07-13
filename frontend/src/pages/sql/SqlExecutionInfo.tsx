import type { ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  CircleGauge,
  Loader2,
  RotateCcw,
  Square,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import type { CatalogDataset, TrinoQueryEstimate, TrinoQueryRun } from "../../types";
import { formatDuration } from "./sqlResultFormatting";
import {
  buildTrinoExecutionTimelineModel,
  type TrinoExecutionStageStatus,
} from "./trinoExecutionTimeline";
import styles from "./SqlExecutionInfo.module.css";

const LARGE_RESULT_ROW_THRESHOLD = 100_000;

export type SqlExecutionInfoProps = {
  cancelPending?: boolean;
  estimate: TrinoQueryEstimate | null;
  estimateError?: string | null;
  estimatePending: boolean;
  firstPageDisplayMs?: number | null;
  firstPageRowCount?: number | null;
  onCancel?: () => void;
  onRetryResult?: () => void;
  queryEngineStatus?: CatalogDataset["queryEngineStatus"];
  resultPageError?: string | null;
  run: TrinoQueryRun | null;
  statusPollError?: string | null;
  submissionError?: string | null;
  submissionPending: boolean;
  validationError?: string | null;
  validationPending: boolean;
};

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "추정 불가";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatMetric(value: number | null | undefined) {
  return value == null ? "-" : new Intl.NumberFormat("ko-KR").format(value);
}

function estimateSourceLabel(estimate: TrinoQueryEstimate) {
  if (estimate.estimateSource === "iceberg_metadata") return "Iceberg 메타데이터 기준";
  if (estimate.estimateSource === "conservative_bound") return "보수적 추정";
  if (estimate.estimateSource === "trino_plan") return "Trino plan 기준";
  return "Catalog 기준";
}

function engineStatusMessage(status: CatalogDataset["queryEngineStatus"]) {
  if (status === "pending") return "데이터셋을 SQL 엔진에 등록하고 있습니다.";
  if (status === "registration_failed") return "SQL 엔진 등록 검증에 실패했습니다.";
  if (status === "unavailable") return "현재 SQL 엔진에서 사용할 수 없는 데이터셋입니다.";
  return null;
}

function Stage({
  actions,
  badge,
  children,
  status,
  summary,
  title,
}: {
  actions?: ReactNode;
  badge?: string;
  children?: ReactNode;
  status: TrinoExecutionStageStatus | "expired";
  summary?: string;
  title: string;
}) {
  const StageIcon = status === "completed"
    ? CheckCircle2
    : status === "active" ? Loader2 : status === "expired" ? Clock3 : AlertCircle;

  return (
    <div
      aria-current={status === "active" ? "step" : undefined}
      className={`${styles.stage} ${styles[status]}`}
      role="listitem"
    >
      <div className={styles.stageHeader}>
        <span className={styles.stageTitle}>
          <StageIcon className={status === "active" ? styles.spinner : undefined} size={16} />
          <strong>{title}</strong>
        </span>
        <span className={styles.stageMeta}>
          {badge ? <Badge size="sm" variant="outline">{badge}</Badge> : null}
          {summary ? <span className={styles.stageSummary}>{summary}</span> : null}
          {actions}
        </span>
      </div>
      {status === "active" && children ? <div className={styles.stageBody}>{children}</div> : null}
    </div>
  );
}

function QueryEvaluation({
  estimate,
  estimateError,
  estimatePending,
  queryEngineStatus,
  validationError,
  validationPending,
}: Pick<SqlExecutionInfoProps, "estimate" | "estimateError" | "estimatePending" | "queryEngineStatus" | "validationError" | "validationPending">) {
  const registrationMessage = engineStatusMessage(queryEngineStatus);
  const evaluationStatus = registrationMessage
    ?? (validationPending
      ? "Trino SQL 검증 중"
      : validationError
        ? "Trino SQL 검증 실패"
        : estimatePending
          ? "실행 규모 계산 중"
          : estimate
            ? estimateSourceLabel(estimate)
            : "실행 전 평가 대기");
  const tone = validationError || registrationMessage || estimateError
    ? "error"
    : estimate?.riskLevel ?? "idle";

  return (
    <section aria-label="실행 평가" className={`${styles.evaluation} ${styles[tone]}`}>
      <div className={styles.sectionHeading}>
        <span><CircleGauge size={16} /> 실행 평가</span>
        <strong>{evaluationStatus}</strong>
      </div>
      {estimate ? (
        <div className={styles.evaluationMetrics}>
          <div><span>예상 스캔량</span><strong>{formatBytes(estimate.estimatedBytes)}</strong></div>
          <div><span>예상 실행 시간</span><strong>{estimate.estimatedDurationSeconds == null ? "추정 불가" : formatDuration(estimate.estimatedDurationSeconds * 1000)}</strong></div>
          <div><span>실행 위험도</span><strong>{estimate.riskLevel === "high" ? "높음" : estimate.riskLevel === "medium" ? "보통" : "낮음"}</strong></div>
        </div>
      ) : null}
      {registrationMessage || validationError || estimateError ? (
        <div className={styles.alert} role="alert">
          <AlertCircle size={15} />
          <span>{registrationMessage ?? validationError ?? estimateError}</span>
        </div>
      ) : null}
      {estimate?.warnings.map((warning) => (
        <div className={styles.warning} key={warning}><AlertCircle size={14} /><span>{warning}</span></div>
      ))}
    </section>
  );
}

function ExecutionTimeline({
  cancelPending,
  firstPageDisplayMs,
  firstPageRowCount,
  onCancel,
  run,
  submissionError,
  submissionPending,
}: Pick<SqlExecutionInfoProps, "cancelPending" | "firstPageDisplayMs" | "firstPageRowCount" | "onCancel" | "run" | "submissionError" | "submissionPending">) {
  if (!run && !submissionPending && !submissionError) {
    return (
      <section aria-label="실행 과정" className={styles.timeline}>
        <div className={styles.timelineHeading}><span><Activity size={16} /> 실행 과정</span></div>
        <div className={styles.idleState}>
          <Activity size={18} />
          <strong>아직 실행 전입니다.</strong>
          <span>SQL을 실행하면 Trino 처리 단계와 소요 시간이 여기에 표시됩니다.</span>
        </div>
      </section>
    );
  }

  if (submissionPending || submissionError || !run) {
    return (
      <section aria-label="실행 과정" aria-live="polite" className={styles.timeline}>
        <div className={styles.timelineHeading}><span><Activity size={16} /> 실행 과정</span></div>
        <div className={styles.stageList} role="list">
          <Stage
            status={submissionError ? "failed" : "active"}
            summary={submissionError ?? "요청 접수 중"}
            title="쿼리 실행"
          />
        </div>
      </section>
    );
  }

  const timeline = buildTrinoExecutionTimelineModel(run, run.estimate?.estimatedDurationSeconds);
  const terminalSummary = run.error?.message ?? (run.status === "cancelled" ? "실행 취소됨" : "실행 실패");
  const completedQuerySummary = [
    run.stats?.queuedMs != null ? `대기 ${formatDuration(run.stats.queuedMs)}` : null,
    run.stats?.elapsedMs != null ? formatDuration(run.stats.elapsedMs) : null,
    run.stats?.processedBytes != null ? formatBytes(run.stats.processedBytes) : null,
    run.stats?.peakMemoryBytes != null ? `피크 ${formatBytes(run.stats.peakMemoryBytes)}` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ") || "완료";
  const firstResultSummary = timeline.firstResultReady
    ? [
        timeline.firstResultElapsedMs != null ? `제출 후 ${formatDuration(timeline.firstResultElapsedMs)}` : "첫 결과 준비",
        firstPageDisplayMs != null ? `화면 ${formatDuration(firstPageDisplayMs)}` : null,
        firstPageRowCount != null ? `${firstPageRowCount.toLocaleString()}행 표시` : null,
      ].filter((value): value is string => Boolean(value)).join(" · ")
    : undefined;
  const collectionRows = timeline.expectedRows ?? timeline.collectedRows;
  const collectionSummary = timeline.collectionStageStatus === "completed"
    ? [
        collectionRows == null ? "수집 완료" : `${collectionRows.toLocaleString()}행`,
        timeline.collectionElapsedMs != null ? formatDuration(timeline.collectionElapsedMs) : null,
        run.result?.byteSize != null ? formatBytes(run.result.byteSize) : null,
      ].filter((value): value is string => Boolean(value)).join(" · ")
    : timeline.storageFailed ? run.error?.message ?? "결과 저장 실패" : undefined;
  const timelineSummary = [
    run.stats?.elapsedMs != null ? `Trino ${formatDuration(run.stats.elapsedMs)}` : null,
    timeline.firstResultElapsedMs != null ? `첫 결과 ${formatDuration(timeline.firstResultElapsedMs)}` : null,
    timeline.totalReadyMs != null ? `전체 준비 ${formatDuration(timeline.totalReadyMs)}` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");

  return (
    <section aria-label="실행 과정" aria-live="polite" className={styles.timeline}>
      <div className={styles.timelineHeading}>
        <span><Activity size={16} /> 실행 과정</span>
        {timelineSummary ? <strong>{timelineSummary}</strong> : null}
      </div>
      <div className={styles.stageList} role="list">
        <Stage
          actions={onCancel && ["queued", "running"].includes(run.status) ? (
            <Button aria-label="실행 취소" disabled={cancelPending} onClick={onCancel} size="sm" type="button" variant="outline">
              <Square data-icon="inline-start" /> 취소
            </Button>
          ) : undefined}
          status={timeline.queryStageStatus}
          summary={timeline.queryStageStatus === "completed"
            ? completedQuerySummary
            : timeline.terminalStageStatus ? terminalSummary : timeline.queryPhaseLabel}
          title="쿼리 실행"
        >
          {timeline.queryProgressVisible ? (
            <Progress aria-label="쿼리 실행 진행률" value={timeline.runProgressPercentage ?? 0}>
              <ProgressLabel>Trino 작업</ProgressLabel>
              <ProgressValue />
            </Progress>
          ) : null}
          {!timeline.queryProgressVisible && (timeline.queryElapsedMs ?? 0) >= 2_000 && timeline.runProgressPercentage == null ? (
            <span className={styles.stageState}>Trino 진행률 정보를 확인하고 있습니다.</span>
          ) : null}
          <div className={styles.stageMetrics}>
            <span>상태 <strong>{timeline.queryPhaseLabel}</strong></span>
            <span>대기 <strong>{run.stats?.queuedMs != null ? formatDuration(run.stats.queuedMs) : "-"}</strong></span>
            <span><Clock3 size={14} /> 실행 <strong>{timeline.queryElapsedMs != null ? formatDuration(timeline.queryElapsedMs) : "-"}</strong></span>
            <span>처리량 <strong>{formatBytes(run.stats?.processedBytes)}</strong></span>
            <span>처리 행 <strong>{formatMetric(run.stats?.processedRows)}</strong></span>
            {timeline.completedWork ? <span>작업 <strong>{timeline.completedWork.completed.toLocaleString()} / {timeline.completedWork.total.toLocaleString()}</strong></span> : null}
          </div>
        </Stage>
        {timeline.firstResultStageVisible ? (
          <Stage
            status={timeline.firstResultStageStatus}
            summary={firstResultSummary ?? (timeline.firstResultStageStatus === "failed" || timeline.firstResultStageStatus === "cancelled" ? terminalSummary : undefined)}
            title="첫 결과 준비"
          >
            <div className={styles.stageMetrics}>
              <span><Clock3 size={14} /> 제출 후 경과 <strong>{timeline.firstResultElapsedMs != null ? formatDuration(timeline.firstResultElapsedMs) : "-"}</strong></span>
              <span>저장 페이지 <strong>{run.result?.availablePageCount?.toLocaleString() ?? "0"}</strong></span>
              <span>화면 표시 <strong>{firstPageDisplayMs != null ? formatDuration(firstPageDisplayMs) : "불러오는 중"}</strong></span>
            </div>
          </Stage>
        ) : null}
        {timeline.collectionStageVisible ? (
          <Stage
            badge={timeline.collectionActive && (timeline.expectedRows ?? 0) >= LARGE_RESULT_ROW_THRESHOLD ? "대용량 결과 수집" : undefined}
            status={run.result?.storageStatus === "expired" ? "expired" : timeline.collectionStageStatus}
            summary={run.result?.storageStatus === "expired" ? "보관 기간 종료" : collectionSummary}
            title={timeline.collectionStateUnknown ? "전체 결과 상태 확인 중" : "전체 결과 수집"}
          >
            {timeline.collectionProgressVisible ? (
              <Progress aria-label="전체 결과 수집 진행률" value={timeline.collectionProgressPercentage ?? 0}>
                <ProgressLabel>{timeline.collectionFinalizing ? "수집 데이터 확인 완료" : "수집 진행률"}</ProgressLabel>
                <ProgressValue />
              </Progress>
            ) : null}
            {timeline.collectionFinalizing ? <span className={styles.stageState}>결과 저장을 마무리하고 있습니다.</span> : null}
            <div className={styles.stageMetrics}>
              <span><Clock3 size={14} /> 수집 경과 <strong>{timeline.collectionElapsedMs != null ? formatDuration(timeline.collectionElapsedMs) : "-"}</strong></span>
              <span>수집 행 <strong>{formatMetric(timeline.collectedRows)}</strong></span>
              <span>전체 행 <strong>{timeline.expectedRows == null ? "확인 중" : timeline.expectedRows.toLocaleString()}</strong></span>
              <span>저장량 <strong>{formatBytes(run.result?.byteSize)}</strong></span>
            </div>
          </Stage>
        ) : null}
      </div>
    </section>
  );
}

export function SqlExecutionInfo(props: SqlExecutionInfoProps) {
  return (
    <div className={styles.root}>
      <QueryEvaluation
        estimate={props.estimate}
        estimateError={props.estimateError}
        estimatePending={props.estimatePending}
        queryEngineStatus={props.queryEngineStatus}
        validationError={props.validationError}
        validationPending={props.validationPending}
      />
      <ExecutionTimeline
        cancelPending={props.cancelPending}
        firstPageDisplayMs={props.firstPageDisplayMs}
        firstPageRowCount={props.firstPageRowCount}
        onCancel={props.onCancel}
        run={props.run}
        submissionError={props.submissionError}
        submissionPending={props.submissionPending}
      />
      {props.statusPollError ? (
        <div className={styles.alert} role="status"><AlertCircle size={15} /><span>{props.statusPollError} 자동으로 다시 확인합니다.</span></div>
      ) : null}
      {props.resultPageError ? (
        <div className={styles.resultError} role="alert">
          <span><AlertCircle size={15} /> {props.resultPageError}</span>
          {props.onRetryResult ? <Button onClick={props.onRetryResult} size="sm" type="button" variant="outline"><RotateCcw data-icon="inline-start" /> 다시 시도</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
