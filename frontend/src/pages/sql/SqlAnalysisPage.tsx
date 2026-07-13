import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Download,
  History,
  Loader2,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RotateCcw,
  Search,
  Square,
  Table2,
  Workflow,
} from "lucide-react";
import { ActionGroup } from "@/components/ui/action-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldLabel, FieldTitle } from "@/components/ui/field";
import { FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { PageHeader } from "@/components/ui/page-header";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { apiConfig } from "../../services/apiClient";
import { executeQueryPreview } from "../../services/mockApi";
import { cancelTrinoQueryRun, estimateSqlQueryRun, getTrinoQueryRun, getTrinoQueryRunResultPage, isTrinoQueryRun, listTrinoQueryRuns, submitSqlQueryRun, validateSqlQueryRun } from "../../services/pipelineApi";
import {
  generateQueryAiSuggestion,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, CreateTrinoSqlJobRequest, CurrentUserResponse, SqlResultDraft, TrinoQueryEstimate, TrinoQueryRun, TrinoQueryRunHistoryItem, TrinoQueryRunResultPage } from "../../types";
import { canQueryDatasetAs, datasetQueryBlockedMessage } from "../../utils/permissions";
import { SqlAiWriterDialog } from "./SqlAiWriterDialog";
import { SqlChartConfigurator } from "./SqlChartConfigurator";
import { SqlDatasetTree } from "./SqlDatasetRow";
import {
  formatSqlJobWizardScheduleLabel,
  formatSqlJobWizardScheduleSummary,
  SqlJobWizardDialog,
  type SqlJobWizardCreateRequest,
} from "./SqlJobWizardDialog";
import { SqlPreviewTable } from "./SqlPreviewTable";
import {
  buildSqlChartSources,
  SqlResultChart,
  type SqlChartConfig,
} from "./SqlResultChart";
import {
  PREVIEW_ROW_LIMIT,
  buildAutocompleteCandidates,
  buildDefaultDerivedDatasetDescription,
  buildDefaultDerivedDatasetName,
  buildDefaultDerivedDatasetTags,
  buildDefaultQuery,
  escapeCsvCell,
  formatDuration,
  formatResultTimestamp,
  getAutocompleteContext,
  getPreflightSummary,
  parseDerivedDatasetTags,
  runSqlPreflight,
  type AutocompleteCandidate,
  type SqlPreflightResult,
} from "./sqlLogic";
import {
  buildTrinoExecutionTimelineModel,
  isTrinoQueryExecutionComplete,
  isTrinoResultCollectionActive,
  shouldShowTrinoSubmissionTimeline,
  type TrinoExecutionStageStatus,
} from "./trinoExecutionTimeline";

function createClientRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `query-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
function isSqlCandidateDataset(dataset: CatalogDataset) {
  const normalizedName = dataset.name.toLowerCase();
  const normalizedTags = dataset.tags.map((tag) => tag.toLowerCase());

  return dataset.permissions?.canQuery !== false
    && !normalizedName.includes("legacy")
    && !normalizedTags.includes("#legacy");
}

function getTrinoResultStatusLabel(run: TrinoQueryRun | null) {
  if (!run) return "대기 중";
  if (isTrinoResultCollectionActive(run)) return "결과 수집 중";
  if (run.result?.storageStatus === "available") return "결과 준비됨";
  if (run.result?.storageStatus === "expired") return "보관 기간 만료";
  if (run.result?.storageStatus === "unavailable") return "결과 저장 실패";
  if (isTrinoQueryExecutionComplete(run) && !run.result?.storageStatus) return "결과 상태 확인 중";
  if (run.status === "failed") return "실행 실패";
  if (run.status === "cancelled") return "실행 취소됨";
  return run.status === "queued" ? "실행 대기 중" : "실행 중";
}

const LARGE_RESULT_ROW_THRESHOLD = 100_000;

function TrinoExecutionStage({
  badge,
  children,
  status,
  summary,
  title,
}: {
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
      className={`sql-run-stage ${status}`}
      role="listitem"
    >
      <div className="sql-run-stage-header">
        <span className="sql-run-stage-title">
          <StageIcon className={status === "active" ? "sql-run-stage-spinner" : undefined} size={16} />
          <strong>{title}</strong>
        </span>
        <span className="sql-run-stage-header-meta">
          {badge && <Badge size="sm" variant="outline">{badge}</Badge>}
          {summary && <span className="sql-run-stage-summary">{summary}</span>}
        </span>
      </div>
      {status === "active" && children ? <div className="sql-run-stage-body">{children}</div> : null}
    </div>
  );
}

function TrinoExecutionTimeline({
  firstPageError,
  firstPageDisplayMs,
  firstPageRowCount,
  run,
  submissionError,
  submissionPending,
}: {
  firstPageError?: string | null;
  firstPageDisplayMs?: number | null;
  firstPageRowCount?: number | null;
  run: TrinoQueryRun | null;
  submissionError?: string | null;
  submissionPending: boolean;
}) {
  if (!run && !submissionPending && !submissionError) return null;

  if (submissionPending || submissionError) {
    return (
      <section aria-label="실행 과정" aria-live="polite" className="sql-run-timeline">
        <div className="sql-run-timeline-heading"><Activity size={15} /> 실행 과정</div>
        <div className="sql-run-stage-list" role="list">
          <TrinoExecutionStage
            status={submissionError ? "failed" : "active"}
            summary={submissionError ?? "요청 접수 중"}
            title="쿼리 실행"
          />
        </div>
      </section>
    );
  }

  if (!run) return null;

  const timeline = buildTrinoExecutionTimelineModel(run);
  const {
    collectedRows,
    collectionActive,
    collectionElapsedMs,
    collectionFinalizing,
    collectionProgressPercentage,
    collectionProgressVisible,
    collectionStageStatus,
    collectionStageVisible,
    collectionStateUnknown,
    completedWork,
    expectedRows,
    firstResultElapsedMs,
    firstResultReady,
    firstResultStageStatus,
    firstResultStageVisible,
    queryElapsedMs,
    queryPhaseLabel,
    queryProgressVisible,
    queryStageStatus,
    runProgressPercentage,
    storageFailed,
    terminalStageStatus,
    totalReadyMs,
  } = timeline;
  const largeResult = expectedRows != null && expectedRows >= LARGE_RESULT_ROW_THRESHOLD;
  const terminalSummary = run.error?.message ?? (run.status === "cancelled" ? "실행 취소됨" : "실행 실패");
  const collectionFailureSummary = run.error?.message ?? (storageFailed ? "결과 저장 실패" : terminalSummary);
  const collectionCompletedRows = expectedRows ?? collectedRows;
  const collectionSummary = collectionStageStatus === "completed"
    ? [
        collectionCompletedRows == null ? "수집 완료" : `${collectionCompletedRows.toLocaleString()}행`,
        collectionElapsedMs != null ? formatDuration(collectionElapsedMs) : null,
        run.result?.byteSize != null ? formatEstimateBytes(run.result.byteSize) : null,
      ].filter((value): value is string => Boolean(value)).join(" · ")
    : collectionStageStatus === "active"
      ? collectionStateUnknown ? "저장 상태 확인 중" : undefined
      : collectionFailureSummary;
  const completedQuerySummary = [
    run.stats?.queuedMs != null ? `대기 ${formatDuration(run.stats.queuedMs)}` : null,
    run.stats?.elapsedMs != null ? formatDuration(run.stats.elapsedMs) : null,
    run.stats?.processedBytes != null ? formatEstimateBytes(run.stats.processedBytes) : null,
    run.stats?.peakMemoryBytes != null ? `피크 ${formatEstimateBytes(run.stats.peakMemoryBytes)}` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ") || "완료";
  const firstResultPageUnavailable = ["expired", "unavailable"].includes(run.result?.storageStatus ?? "");
  const firstResultDisplayed = firstResultReady && (
    firstPageDisplayMs != null
    || (run.result?.availablePageCount ?? 0) === 0
    || firstResultPageUnavailable
  );
  const firstResultDisplayFailed = firstResultReady && !firstResultDisplayed && Boolean(firstPageError);
  const visibleFirstResultStatus = firstResultDisplayFailed
    ? "failed"
    : firstResultReady && !firstResultDisplayed && firstResultStageStatus === "completed"
      ? "active"
      : firstResultStageStatus;
  const firstResultSummary = firstResultDisplayed
    ? [
        firstResultElapsedMs != null ? `제출 후 ${formatDuration(firstResultElapsedMs)}` : "첫 결과 준비",
        firstPageDisplayMs != null ? `화면 ${formatDuration(firstPageDisplayMs)}` : null,
        firstPageRowCount != null ? `${firstPageRowCount.toLocaleString()}행 표시` : null,
      ].filter((value): value is string => Boolean(value)).join(" · ")
    : firstResultDisplayFailed
      ? firstPageError ?? "첫 결과를 불러오지 못했습니다."
      : visibleFirstResultStatus === "failed" || visibleFirstResultStatus === "cancelled" ? terminalSummary : undefined;
  const timelineSummary = ["available", "expired"].includes(run.result?.storageStatus ?? "")
    ? [
        run.stats?.elapsedMs != null ? `Trino ${formatDuration(run.stats.elapsedMs)}` : null,
        firstResultElapsedMs != null ? `첫 결과 ${formatDuration(firstResultElapsedMs)}` : null,
        totalReadyMs != null ? `전체 준비 ${formatDuration(totalReadyMs)}` : null,
      ].filter((value): value is string => Boolean(value)).join(" · ")
    : "";

  return (
    <section aria-label="실행 과정" aria-live="polite" className="sql-run-timeline">
      <div className="sql-run-timeline-heading">
        <span><Activity size={15} /> 실행 과정</span>
        {timelineSummary && <strong>{timelineSummary}</strong>}
      </div>
      <div className="sql-run-stage-list" role="list">
        <TrinoExecutionStage
          status={queryStageStatus}
          summary={queryStageStatus === "completed"
            ? completedQuerySummary
            : terminalStageStatus ? terminalSummary : queryPhaseLabel}
          title="쿼리 실행"
        >
          {queryProgressVisible && (
            <Progress
              aria-label="쿼리 실행 진행률"
              className="sql-run-progress-control"
              indicatorClassName="sql-run-progress-indicator"
              trackClassName="sql-run-progress-track"
              value={runProgressPercentage ?? 0}
            >
              <ProgressLabel className="sql-run-progress-label">Trino 작업</ProgressLabel>
              <ProgressValue className="sql-run-progress-value" maximumFractionDigits={1} />
            </Progress>
          )}
          {!queryProgressVisible && (queryElapsedMs ?? 0) >= 2_000 && runProgressPercentage == null && (
            <span className="sql-run-stage-state">Trino 진행률 정보를 확인하고 있습니다.</span>
          )}
          <div className="sql-run-stage-metrics">
            <span>상태 <strong>{queryPhaseLabel}</strong></span>
            <span>대기 <strong>{run.stats?.queuedMs != null ? formatDuration(run.stats.queuedMs) : "-"}</strong></span>
            <span><Clock3 size={14} /> 실행 <strong>{queryElapsedMs != null ? formatDuration(queryElapsedMs) : "-"}</strong></span>
            <span>처리량 <strong>{formatEstimateBytes(run.stats?.processedBytes)}</strong></span>
            <span>처리 행 <strong>{formatMetricNumber(run.stats?.processedRows)}</strong></span>
            {completedWork && <span>작업 <strong>{completedWork.completed.toLocaleString()} / {completedWork.total.toLocaleString()}</strong></span>}
          </div>
        </TrinoExecutionStage>
        {firstResultStageVisible && (
          <TrinoExecutionStage
            status={visibleFirstResultStatus}
            summary={firstResultSummary}
            title="첫 결과 준비"
          >
            <div className="sql-run-stage-metrics">
              <span><Clock3 size={14} /> 제출 후 경과 <strong>{firstResultElapsedMs != null ? formatDuration(firstResultElapsedMs) : "-"}</strong></span>
              <span>저장 페이지 <strong>{run.result?.availablePageCount?.toLocaleString() ?? "0"}</strong></span>
              <span>화면 표시 <strong>{firstPageDisplayMs != null ? formatDuration(firstPageDisplayMs) : "불러오는 중"}</strong></span>
            </div>
          </TrinoExecutionStage>
        )}
        {collectionStageVisible && (
          <TrinoExecutionStage
            badge={collectionActive && largeResult ? "대용량 결과 수집" : undefined}
            status={run.result?.storageStatus === "expired" ? "expired" : collectionStageStatus}
            summary={run.result?.storageStatus === "expired" ? "보관 기간 종료" : collectionSummary}
            title={collectionStateUnknown ? "전체 결과 상태 확인 중" : "전체 결과 수집"}
          >
            {collectionProgressVisible && (
              <Progress
                aria-label="전체 결과 수집 진행률"
                className="sql-run-progress-control"
                indicatorClassName="sql-run-progress-indicator"
                trackClassName="sql-run-progress-track"
                value={collectionProgressPercentage ?? 0}
              >
                <ProgressLabel className="sql-run-progress-label">{collectionFinalizing ? "수집 데이터 확인 완료" : "수집 진행률"}</ProgressLabel>
                <ProgressValue className="sql-run-progress-value" maximumFractionDigits={1} />
              </Progress>
            )}
            {collectionFinalizing && <span className="sql-run-stage-state">결과 저장을 마무리하고 있습니다.</span>}
            {!collectionProgressVisible && (collectionElapsedMs ?? 0) >= 2_000 && collectionProgressPercentage == null && (
              <span className="sql-run-stage-state">{collectionStateUnknown ? "저장 상태 확인 중" : "전체 행을 확인하고 있습니다."}</span>
            )}
            <div className="sql-run-stage-metrics">
              <span><Clock3 size={14} /> 수집 경과 <strong>{collectionElapsedMs != null ? formatDuration(collectionElapsedMs) : "-"}</strong></span>
              <span>수집 행 <strong>{collectedRows == null ? "-" : collectedRows.toLocaleString()}</strong></span>
              <span>전체 행 <strong>{expectedRows == null ? "확인 중" : expectedRows.toLocaleString()}</strong></span>
              <span>저장량 <strong>{formatEstimateBytes(run.result?.byteSize)}</strong></span>
            </div>
          </TrinoExecutionStage>
        )}
      </div>
    </section>
  );
}

function getTrinoHistoryStatusLabel(run: TrinoQueryRunHistoryItem) {
  if (run.result?.storageStatus === "collecting") return "결과 수집 중";
  if (run.result?.storageStatus === "available") return "결과 준비됨";
  if (run.result?.storageStatus === "expired") return "보관 기간 만료";
  if (run.result?.storageStatus === "unavailable") return "결과 저장 실패";
  if (run.status === "failed") return "실행 실패";
  if (run.status === "cancelled") return "실행 취소됨";
  return run.status === "queued" ? "실행 대기 중" : "실행 중";
}

function toTrinoHistoryItem(run: TrinoQueryRun): TrinoQueryRunHistoryItem {
  return {
    baseDatasetId: run.baseDatasetId,
    completedAt: run.completedAt,
    query: run.query,
    result: run.result ? {
      rowCount: run.result.rowCount,
      storageStatus: run.result.storageStatus,
    } : null,
    runId: run.runId,
    stats: run.stats ? { processedBytes: run.stats.processedBytes } : null,
    status: run.status,
    submittedAt: run.submittedAt,
  };
}

function getTrinoResultEmptyTitle(run: TrinoQueryRun | null) {
  if (run?.result?.storageStatus === "expired") return "결과 보관 기간이 만료되었습니다.";
  if (run && isTrinoResultCollectionActive(run)) return "결과를 수집하고 있습니다.";
  if (run && ["queued", "running"].includes(run.status)) return "쿼리를 실행하고 있습니다.";
  if (run?.status === "failed") return "실행에 실패했습니다.";
  if (run?.status === "cancelled") return "실행이 취소되었습니다.";
  return "아직 결과가 없습니다.";
}

function getTrinoResultEmptyMessage(run: TrinoQueryRun | null, hasBaseDataset: boolean) {
  if (run?.result?.storageStatus === "expired") return "보관 기간이 지난 결과는 다시 실행하거나 Iceberg Dataset으로 생성해 주세요.";
  if (run && isTrinoResultCollectionActive(run)) return "서버가 결과 페이지를 저장하는 중입니다. 완료되는 대로 첫 페이지를 표시합니다.";
  if (run && ["queued", "running"].includes(run.status)) return "Trino 실행 통계를 확인하는 중입니다.";
  return hasBaseDataset ? "SQL을 실행하면 실제 실행 결과가 여기에 페이지 단위로 표시됩니다." : "먼저 분석 테이블에서 데이터셋을 선택해 주세요.";
}

function formatEstimateBytes(bytes: number | null | undefined) {
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

function getQueryEstimateSourceLabel(estimate: TrinoQueryEstimate) {
  if (estimate.estimateSource === "iceberg_metadata") return "Iceberg 메타데이터 기준";
  if (estimate.estimateSource === "conservative_bound") return "보수적 추정";
  if (estimate.estimateSource === "trino_plan") return "Trino plan 기준";
  return "Catalog 기준";
}

function getQueryEstimateSourceDetail(estimate: TrinoQueryEstimate) {
  if (estimate.estimateSource === "iceberg_metadata") {
    return `참조 컬럼 ${formatEstimateBytes(estimate.icebergEstimatedBytes)} · Dataset 저장 ${formatEstimateBytes(estimate.knownInputBytes)}`;
  }
  if (estimate.estimateSource !== "conservative_bound") return undefined;
  return `Trino plan ${formatEstimateBytes(estimate.planEstimatedBytes)} · 원본 ${formatEstimateBytes(estimate.knownInputBytes)}`;
}

function formatMetricNumber(value: number | null | undefined) {
  return value == null ? "-" : new Intl.NumberFormat("ko-KR").format(value);
}

function SqlChartEmptyState() {
  return (
    <Empty className="sql-result-view-empty" size="sm" variant="bordered">
      <EmptyHeader>
        <EmptyTitle>아직 생성된 차트가 없습니다.</EmptyTitle>
        <EmptyDescription>왼쪽 차트 생성하기에서 위젯을 설정하고 차트를 생성해 주세요.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function SqlAnalysisPage({
  cachedResult,
  createPending,
  currentUser,
  dataset,
  datasets,
  onAction,
  onNotify,
  onCreateDatasetJob,
  onCreateTrinoSqlJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  createPending: boolean;
  currentUser?: CurrentUserResponse | null;
  dataset: CatalogDataset | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string, tone?: "success" | "info") => void;
  onCreateDatasetJob: (request: CreateDerivedDatasetRequest) => Promise<boolean>;
  onCreateTrinoSqlJob: (request: CreateTrinoSqlJobRequest) => Promise<boolean>;
  onResultChange: (result: SqlResultDraft | null) => void;
}) {
  const [baseDatasetId, setBaseDatasetId] = useState<string | null>(dataset?.id ?? null);
  const baseDataset = useMemo(
    () => baseDatasetId ? datasets.find((item) => item.id === baseDatasetId) ?? (dataset?.id === baseDatasetId ? dataset : null) : null,
    [baseDatasetId, dataset, datasets],
  );
  const defaultQuery = useMemo(() => baseDataset ? buildDefaultQuery(baseDataset) : "", [baseDataset]);
  const [executed, setExecuted] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [contextPanelTab, setContextPanelTab] = useState<"chart" | "tables">("tables");
  const [datasetSearch, setDatasetSearch] = useState("");
  const [contextPage, setContextPage] = useState(1);
  const [contextPageSize, setContextPageSize] = useState(() => Math.max(1, datasets.length));
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [previewRowLimit, setPreviewRowLimit] = useState(PREVIEW_ROW_LIMIT);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [trinoRun, setTrinoRun] = useState<TrinoQueryRun | null>(null);
  const [trinoSubmissionPending, setTrinoSubmissionPending] = useState(false);
  const [trinoStatusPollError, setTrinoStatusPollError] = useState<string | null>(null);
  const [trinoStatusPollRetry, setTrinoStatusPollRetry] = useState(0);
  const [trinoRunHistory, setTrinoRunHistory] = useState<TrinoQueryRunHistoryItem[]>([]);
  const [trinoRunHistoryError, setTrinoRunHistoryError] = useState<string | null>(null);
  const [trinoFirstPageDisplayMs, setTrinoFirstPageDisplayMs] = useState<number | null>(null);
  const [trinoFirstPageRowCount, setTrinoFirstPageRowCount] = useState<number | null>(null);
  const [trinoResultPage, setTrinoResultPage] = useState<TrinoQueryRunResultPage | null>(null);
  const [trinoResultCursors, setTrinoResultCursors] = useState<Array<string | null>>([null]);
  const [trinoResultPageIndex, setTrinoResultPageIndex] = useState(0);
  const [trinoResultPagePending, setTrinoResultPagePending] = useState(false);
  const [trinoResultError, setTrinoResultError] = useState<string | null>(null);
  const [trinoResultRetryCursor, setTrinoResultRetryCursor] = useState<string | null | undefined>(undefined);
  const [trinoResultRetryTargetIndex, setTrinoResultRetryTargetIndex] = useState(0);
  const [queryEstimate, setQueryEstimate] = useState<TrinoQueryEstimate | null>(null);
  const [queryEstimateError, setQueryEstimateError] = useState<string | null>(null);
  const [queryEstimateKey, setQueryEstimateKey] = useState<string | null>(null);
  const [queryEstimatePending, setQueryEstimatePending] = useState(false);
  const [trinoValidationKey, setTrinoValidationKey] = useState<string | null>(null);
  const [trinoValidationError, setTrinoValidationError] = useState<string | null>(null);
  const [trinoValidationPending, setTrinoValidationPending] = useState(false);
  const [trinoSubmissionError, setTrinoSubmissionError] = useState<string | null>(null);
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const [preflightResult, setPreflightResult] = useState<SqlPreflightResult | null>(null);
  const [queryAiPrompt, setQueryAiPrompt] = useState("");
  const [queryAiSuggestion, setQueryAiSuggestion] = useState<QueryAiSuggestion | null>(null);
  const [queryAiPending, setQueryAiPending] = useState(false);
  const [queryAiError, setQueryAiError] = useState<string | null>(null);
  const [queryAiDialogOpen, setQueryAiDialogOpen] = useState(false);
  const [chartConfig, setChartConfig] = useState<SqlChartConfig | null>(null);
  const [resultView, setResultView] = useState<"chart" | "table">("table");
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string | null>(null);
  const contextPanelRef = useRef<HTMLElement | null>(null);
  const contextListRef = useRef<HTMLDivElement | null>(null);
  const contextPaginationRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const queryAiPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const queryClientRequestRef = useRef<{ id: string; key: string } | null>(null);
  const skipNextBaseDatasetResetRef = useRef(false);
  const trinoResultLoadKeyRef = useRef("");
  const referenceDatasetIdSet = useMemo(() => new Set(referenceDatasetIds), [referenceDatasetIds]);
  const queryValidationKey = useMemo(
    () => JSON.stringify({
      baseDatasetId: baseDataset?.id ?? null,
      previewRowLimit,
      query,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
    }),
    [baseDataset?.id, previewRowLimit, query, referenceDatasetIds],
  );
  const selectedContextDatasets = useMemo(
    () => baseDataset
      ? [
          baseDataset,
          ...referenceDatasetIds
            .map((id) => datasets.find((item) => item.id === id))
            .filter((item): item is CatalogDataset => Boolean(item)),
        ]
      : [],
    [baseDataset, datasets, referenceDatasetIds],
  );
  const chartSources = useMemo(
    () => resultDraft ? buildSqlChartSources(resultDraft, selectedContextDatasets) : [],
    [resultDraft, selectedContextDatasets],
  );
  const activeChartSource = useMemo(
    () => chartConfig ? chartSources.find((source) => source.id === chartConfig.sourceId) : undefined,
    [chartConfig, chartSources],
  );
  const selectedDatasetIdSet = useMemo(
    () => new Set(selectedContextDatasets.map((item) => item.id)),
    [selectedContextDatasets],
  );
  const sqlCandidateDatasets = useMemo(
    () => datasets.filter(isSqlCandidateDataset),
    [datasets],
  );
  const selectedReferenceDatasets = useMemo(
    () => datasets.filter((item) => referenceDatasetIdSet.has(item.id)),
    [datasets, referenceDatasetIdSet],
  );
  const hasQueryPermission = Boolean(baseDataset && canQueryDatasetAs(baseDataset, currentUser) && selectedReferenceDatasets.every((item) => canQueryDatasetAs(item, currentUser)));
  const blockedQueryDataset = baseDataset && !canQueryDatasetAs(baseDataset, currentUser)
    ? baseDataset
    : selectedReferenceDatasets.find((item) => !canQueryDatasetAs(item, currentUser));
  const queryPermissionMessage = hasQueryPermission ? "" : datasetQueryBlockedMessage(blockedQueryDataset, "선택 데이터셋");
  const usesTrinoRuntime = Boolean(baseDataset?.queryEngineRequired);
  const canRunPreview = Boolean(
    baseDataset
      && hasQueryPermission
      && preflightResult?.canExecute === true
      && preflightResult.key === queryValidationKey
      && (!usesTrinoRuntime || apiConfig.useMock || trinoValidationKey === queryValidationKey),
  );
  const activeQueryEstimate = queryEstimateKey === queryValidationKey ? queryEstimate : null;
  const activeQueryEstimateError = queryEstimateKey === queryValidationKey ? queryEstimateError : null;
  const lineNumbers = useMemo(() => {
    if (!baseDataset) return "";
    const lineCount = Math.max(query.split("\n").length, 7);
    return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  }, [baseDataset, query]);
  const autocompleteContext = useMemo(() => getAutocompleteContext(query, cursorIndex), [cursorIndex, query]);
  const autocompleteCandidates = useMemo(() => {
    if (!baseDataset) return [];
    if (dismissedAutocompleteKey === autocompleteContext.key) return [];
    return buildAutocompleteCandidates({
      baseDataset,
      context: autocompleteContext,
      datasets: sqlCandidateDatasets,
      referenceDatasetIdSet,
    });
  }, [autocompleteContext, baseDataset, dismissedAutocompleteKey, referenceDatasetIdSet, sqlCandidateDatasets]);
  const filteredDatasets = useMemo(() => {
    const keyword = datasetSearch.trim().toLowerCase();
    const contextDatasets = sqlCandidateDatasets;
    const searchableDatasets = keyword
      ? contextDatasets.filter((item) => {
          const searchableText = [
            item.name,
            item.description,
            item.source,
            item.owner,
            item.layer,
            ...item.tags,
            ...item.schema.map(([name, type]) => `${name} ${type}`),
          ].join(" ").toLowerCase();
          return searchableText.includes(keyword);
        })
      : contextDatasets;

    return searchableDatasets;
  }, [datasetSearch, selectedDatasetIdSet, sqlCandidateDatasets]);
  const totalContextPages = Math.max(1, Math.ceil(filteredDatasets.length / contextPageSize));
  const currentContextPage = Math.min(Math.max(contextPage, 1), totalContextPages);
  const contextPageStartIndex = (currentContextPage - 1) * contextPageSize;
  const paginatedContextDatasets = filteredDatasets.slice(contextPageStartIndex, contextPageStartIndex + contextPageSize);
  const cachedResultBaseDatasetId = cachedResult ? cachedResult.baseDatasetId ?? cachedResult.datasetId : null;
  const canRestoreCachedResult = Boolean(cachedResult && baseDataset && cachedResultBaseDatasetId === baseDataset.id);
  const refreshTrinoRunHistory = async () => {
    if (apiConfig.useMock) return;
    try {
      const response = await listTrinoQueryRuns();
      setTrinoRunHistory(response.items);
      setTrinoRunHistoryError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "최근 실행 목록을 불러오지 못했습니다.";
      setTrinoRunHistoryError(message);
      onNotify(message, "info");
    }
  };

  useEffect(() => {
    void refreshTrinoRunHistory();
  }, []);
  useEffect(() => {
    if (!dataset) {
      setBaseDatasetId(null);
      setReferenceDatasetIds([]);
      setExpandedDatasetId(null);
      return;
    }

    setBaseDatasetId(dataset.id);
    setReferenceDatasetIds([]);
    setExpandedDatasetId(null);
  }, [dataset?.id]);

  useEffect(() => {
    if (skipNextBaseDatasetResetRef.current) {
      skipNextBaseDatasetResetRef.current = false;
      return;
    }

    if (!baseDataset) {
      setQuery("");
      setCursorIndex(0);
      setResultDraft(null);
      setPreflightResult(null);
      setJobDialogOpen(false);
      setQueryAiPrompt("");
      setQueryAiSuggestion(null);
      setQueryAiError(null);
      setQueryAiDialogOpen(false);
      setChartConfig(null);
      setResultView("table");
      setResultDialogOpen(false);
      setReferenceDatasetIds([]);
      onResultChange(null);
      return;
    }

    if (canRestoreCachedResult) return;

    setQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    setResultDraft(null);
    setPreflightResult(null);
    setJobDialogOpen(false);
    setQueryAiPrompt("");
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setQueryAiDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset, canRestoreCachedResult, defaultQuery]);

  useEffect(() => {
    if (!baseDataset || !cachedResult || !canRestoreCachedResult) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);

    setQuery(cachedResult.query);
    setPreviewRowLimit(cachedResult.previewLimit ?? PREVIEW_ROW_LIMIT);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    setResultDraft(cachedResult);
    setJobDialogOpen(false);
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setQueryAiDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
  }, [baseDataset, cachedResult, canRestoreCachedResult]);

  const queryContextPath = (mode: "preflight" | "preview" | "run" = "preview") => {
    const params = new URLSearchParams({ baseDatasetId: baseDataset?.id ?? "" });
    referenceDatasetIds.forEach((id) => params.append("referenceDatasetIds", id));
    params.set("mode", mode);
    if (mode === "preview") params.set("previewLimit", String(previewRowLimit));
    return `/api/query/runs?${params.toString()}`;
  };

  useEffect(() => {
    setAutocompleteIndex(0);
  }, [autocompleteCandidates.length, autocompleteContext.key]);

  useEffect(() => {
    setContextPage(1);
  }, [baseDataset?.id, datasetSearch, selectedDatasetIdSet]);

  useEffect(() => {
    if (contextPage === currentContextPage) return;
    setContextPage(currentContextPage);
  }, [contextPage, currentContextPage]);

  useEffect(() => {
    if (contextCollapsed || contextPanelTab !== "tables") return;
    let frameId = 0;

    const updateContextPageSize = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const panel = contextPanelRef.current;
        const list = contextListRef.current;
        if (!panel || !list) return;

        const firstRow = list.querySelector<HTMLElement>("[data-sql-dataset-row]");
        const rowHeight = Math.max(1, firstRow?.getBoundingClientRect().height ?? 56);
        const panelStyle = window.getComputedStyle(panel);
        const panelBottomPadding = Number.parseFloat(panelStyle.paddingBottom) || 0;
        const panelBottom = panel.getBoundingClientRect().bottom - panelBottomPadding;
        const listTop = list.getBoundingClientRect().top;
        const availableListHeight = Math.max(rowHeight, panelBottom - listTop);
        const rowsWithoutPagination = Math.max(1, Math.floor(availableListHeight / rowHeight));

        const paginationHeight = contextPaginationRef.current?.getBoundingClientRect().height ?? 38;
        const resultStyle = window.getComputedStyle(list.parentElement ?? list);
        const resultGap = Number.parseFloat(resultStyle.rowGap || resultStyle.gap) || 0;
        const rowsWithPagination = Math.max(
          1,
          Math.floor((availableListHeight - paginationHeight - resultGap) / rowHeight),
        );
        const nextPageSize = filteredDatasets.length > rowsWithoutPagination
          ? rowsWithPagination
          : rowsWithoutPagination;

        setContextPageSize((size) => (size === nextPageSize ? size : nextPageSize));
      });
    };

    updateContextPageSize();

    const resizeObserver = new ResizeObserver(updateContextPageSize);
    if (contextPanelRef.current) resizeObserver.observe(contextPanelRef.current);
    window.addEventListener("resize", updateContextPageSize);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateContextPageSize);
    };
  }, [contextCollapsed, contextPanelTab, datasetSearch, expandedDatasetId, filteredDatasets.length, selectedContextDatasets.length]);

  useEffect(() => {
    if (!baseDataset) {
      setPreflightResult(null);
      return;
    }
    if (!hasQueryPermission) {
      setPreflightResult({
        key: queryValidationKey,
        canExecute: false,
        messages: [{ tone: "error", text: queryPermissionMessage }],
      });
      return;
    }
    setPreflightResult(runSqlPreflight(query, baseDataset, selectedReferenceDatasets, queryValidationKey, {
      previewRowLimit,
      trinoRuntime: usesTrinoRuntime,
    }));
  }, [baseDataset, hasQueryPermission, previewRowLimit, query, queryPermissionMessage, queryValidationKey, selectedReferenceDatasets, usesTrinoRuntime]);

  useEffect(() => {
    if (
      !usesTrinoRuntime
      || apiConfig.useMock
      || !baseDataset
      || preflightResult?.key !== queryValidationKey
      || !preflightResult.canExecute
    ) {
      setTrinoValidationPending(false);
      setTrinoValidationKey(null);
      setTrinoValidationError(null);
      return;
    }
    let disposed = false;
    const validationKey = queryValidationKey;
    const timeoutId = window.setTimeout(() => {
      setTrinoValidationPending(true);
      setTrinoValidationError(null);
      void validateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort())
        .then(() => {
          if (!disposed) setTrinoValidationKey(validationKey);
        })
        .catch((error) => {
          if (disposed) return;
          setTrinoValidationKey(null);
          setTrinoValidationError(error instanceof Error ? error.message : "Trino SQL 검증에 실패했습니다.");
        })
        .finally(() => {
          if (!disposed) setTrinoValidationPending(false);
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [baseDataset, preflightResult, query, queryValidationKey, referenceDatasetIds, usesTrinoRuntime]);

  useEffect(() => {
    if (!usesTrinoRuntime || apiConfig.useMock || !baseDataset || !canRunPreview) {
      setQueryEstimatePending(false);
      return;
    }
    let disposed = false;
    const evaluationKey = queryValidationKey;
    const timeoutId = window.setTimeout(() => {
      setQueryEstimatePending(true);
      setQueryEstimateError(null);
      void estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort())
        .then((estimate) => {
          if (disposed) return;
          setQueryEstimate(estimate);
          setQueryEstimateKey(evaluationKey);
        })
        .catch((error) => {
          if (disposed) return;
          setQueryEstimateError(error instanceof Error ? error.message : "실행 평가를 완료하지 못했습니다.");
          setQueryEstimateKey(evaluationKey);
        })
        .finally(() => {
          if (!disposed) setQueryEstimatePending(false);
        });
    }, 500);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [baseDataset, canRunPreview, query, queryValidationKey, referenceDatasetIds, usesTrinoRuntime]);

  const buildPreviewDraft = (): Promise<SqlResultDraft> => {
    if (!baseDataset) return Promise.reject(new Error("No dataset selected"));
    return executeQueryPreview(baseDataset, query, {
      limit: previewRowLimit,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
      validationKey: queryValidationKey,
    });
  };

  useEffect(() => {
    if (!trinoRun || !["queued", "running"].includes(trinoRun.status)) return;
    const timeoutId = window.setTimeout(() => {
      void getTrinoQueryRun(trinoRun.runId)
        .then((nextRun) => {
          setTrinoStatusPollError(null);
          setTrinoStatusPollRetry(0);
          setTrinoRun(nextRun);
          setTrinoRunHistory((items) => [
            toTrinoHistoryItem(nextRun),
            ...items.filter((item) => item.runId !== nextRun.runId),
          ].slice(0, 8));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Trino 실행 상태를 확인하지 못했습니다.";
          setTrinoStatusPollError(message);
          setTrinoStatusPollRetry((attempt) => attempt + 1);
        });
    }, Math.min(5_000, 500 * (trinoStatusPollRetry + 1)));
    return () => window.clearTimeout(timeoutId);
  }, [trinoRun, trinoStatusPollRetry]);

  useEffect(() => {
    const availablePageCount = trinoRun?.result?.availablePageCount ?? 0;
    const storageStatus = trinoRun?.result?.storageStatus;
    if (
      !trinoRun
      || availablePageCount < 1
      || storageStatus !== "available"
      || trinoResultPagePending
      || trinoResultPage
      || trinoResultPageIndex !== 0
    ) return;
    const cursor = trinoResultCursors[trinoResultPageIndex] ?? null;
    const loadKey = [trinoRun.runId, trinoRun.status, availablePageCount, trinoResultPageIndex, cursor ?? "first"].join(":");
    if (trinoResultLoadKeyRef.current === loadKey) return;
    trinoResultLoadKeyRef.current = loadKey;
    const firstPageLoadStartedAt = trinoResultPageIndex === 0 && !trinoResultPage ? performance.now() : null;
    setTrinoResultPagePending(true);
    void getTrinoQueryRunResultPage(trinoRun.runId, cursor)
      .then((page) => {
        if (trinoResultLoadKeyRef.current !== loadKey) return;
        setTrinoResultPage(page);
        if (firstPageLoadStartedAt != null) {
          setTrinoFirstPageRowCount(page.rows.length);
          window.requestAnimationFrame(() => {
            if (trinoResultLoadKeyRef.current === loadKey) {
              setTrinoFirstPageDisplayMs(Math.max(0, Math.round(performance.now() - firstPageLoadStartedAt)));
            }
          });
        }
        setTrinoResultError(null);
        setTrinoResultRetryCursor(undefined);
      })
      .catch((error) => {
        if (trinoResultLoadKeyRef.current !== loadKey) return;
        setTrinoResultError(error instanceof Error ? error.message : "실행 결과를 불러오지 못했습니다.");
        setTrinoResultRetryCursor(cursor);
        setTrinoResultRetryTargetIndex(trinoResultPageIndex);
      })
      .finally(() => {
        if (trinoResultLoadKeyRef.current === loadKey) setTrinoResultPagePending(false);
      });
  }, [trinoResultCursors, trinoResultPage, trinoResultPageIndex, trinoResultPagePending, trinoRun]);

  const resetResultState = () => {
    setResultDraft(null);
    setTrinoRun(null);
    setTrinoStatusPollError(null);
    setTrinoStatusPollRetry(0);
    setTrinoFirstPageDisplayMs(null);
    setTrinoFirstPageRowCount(null);
    setTrinoResultPage(null);
    setTrinoResultCursors([null]);
    setTrinoResultPageIndex(0);
    setTrinoResultPagePending(false);
    setTrinoResultError(null);
    setTrinoResultRetryCursor(undefined);
    setQueryEstimate(null);
    setQueryEstimateError(null);
    setQueryEstimateKey(null);
    setTrinoValidationKey(null);
    setTrinoValidationError(null);
    setTrinoValidationPending(false);
    setTrinoSubmissionPending(false);
    setTrinoSubmissionError(null);
    queryClientRequestRef.current = null;
    setEstimateDialogOpen(false);
    setExecutionMs(null);
    setPreflightResult(null);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setJobDialogOpen(false);
    trinoResultLoadKeyRef.current = "";
    onResultChange(null);
  };

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setPreflightResult(null);
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    resetResultState();
  };

  const updateCursorFromTextarea = (textarea: HTMLTextAreaElement) => {
    setCursorIndex(textarea.selectionStart);
    syncLineNumberScroll();
  };

  const syncLineNumberScroll = () => {
    if (!textareaRef.current || !lineNumberRef.current) return;
    lineNumberRef.current.scrollTop = textareaRef.current.scrollTop;
  };

  const applyAutocompleteCandidate = (candidate: AutocompleteCandidate) => {
    const nextQuery = `${query.slice(0, autocompleteContext.start)}${candidate.insertText}${query.slice(autocompleteContext.end)}`;
    const nextCursorIndex = autocompleteContext.start + candidate.insertText.length;
    updateQuery(nextQuery);
    setCursorIndex(nextCursorIndex);
    setDismissedAutocompleteKey(null);
    if (candidate.type === "table" && candidate.datasetId && candidate.datasetId !== baseDataset?.id) {
      const datasetId = candidate.datasetId;
      setReferenceDatasetIds((ids) => (ids.includes(datasetId) ? ids : [...ids, datasetId]));
    }
    onAction("analysis.autocomplete.inserted", `/api/query/autocomplete/${candidate.type}/${encodeURIComponent(candidate.label)}`, candidate.datasetId ?? baseDataset?.id ?? "sql-empty");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorIndex, nextCursorIndex);
      syncLineNumberScroll();
    });
  };

  const handleQueryKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocompleteCandidates.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAutocompleteIndex((index) => (index + 1) % autocompleteCandidates.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setAutocompleteIndex((index) => (index - 1 + autocompleteCandidates.length) % autocompleteCandidates.length);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      applyAutocompleteCandidate(autocompleteCandidates[autocompleteIndex] ?? autocompleteCandidates[0]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedAutocompleteKey(autocompleteContext.key);
    }
  };

  const executePreview = async (confirmationToken?: string, clientRequestId?: string) => {
    if (!baseDataset || !canRunPreview) {
      onAction("analysis.query.preview_blocked", queryContextPath("preview"), baseDataset?.id ?? "sql-empty", "failed");
      return;
    }
    const startedAt = performance.now();
    const reusableRequest = queryClientRequestRef.current?.key === queryValidationKey
      ? queryClientRequestRef.current
      : null;
    const requestId = clientRequestId ?? reusableRequest?.id ?? createClientRequestId();
    queryClientRequestRef.current = { id: requestId, key: queryValidationKey };
    setTrinoSubmissionError(null);
    setQueryPending(true);
    setTrinoSubmissionPending(shouldShowTrinoSubmissionTimeline(usesTrinoRuntime, apiConfig.useMock));
    try {
      if (!apiConfig.useMock) {
        if (usesTrinoRuntime && !confirmationToken) {
          const estimate = activeQueryEstimate ?? await estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort());
          setQueryEstimate(estimate);
          setQueryEstimateError(null);
          setQueryEstimateKey(queryValidationKey);
          if (estimate.confirmationRequired) {
            setEstimateDialogOpen(true);
            return;
          }
        }
        const response = await submitSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort(), confirmationToken, requestId);
        queryClientRequestRef.current = null;
        if (isTrinoQueryRun(response)) {
          setExecuted(true);
          setExecutionMs(Math.round(performance.now() - startedAt));
          setResultDraft(null);
          setTrinoRun(response);
          setTrinoStatusPollError(null);
          setTrinoStatusPollRetry(0);
          setTrinoFirstPageDisplayMs(null);
          setTrinoFirstPageRowCount(null);
          setTrinoResultPage(null);
          setTrinoResultCursors([null]);
          setTrinoResultPageIndex(0);
          setTrinoResultPagePending(false);
          setTrinoResultError(null);
          setTrinoResultRetryCursor(undefined);
          trinoResultLoadKeyRef.current = "";
          setTrinoRunHistory((items) => [toTrinoHistoryItem(response), ...items.filter((item) => item.runId !== response.runId)].slice(0, 8));
          onResultChange(null);
          onAction("analysis.query.run_submitted", queryContextPath("run"), baseDataset.id);
          return;
        }
        setExecuted(true);
        setExecutionMs(Math.round(performance.now() - startedAt));
        setResultDraft(response);
        onResultChange(response);
        onAction("analysis.query.compatibility_executed", queryContextPath("run"), baseDataset.id);
        return;
      }
      const resultDraft = await buildPreviewDraft();
      queryClientRequestRef.current = null;
      setExecuted(true);
      setExecutionMs(Math.round(performance.now() - startedAt));
      setResultDraft(resultDraft);
      setChartConfig(null);
      setResultView("table");
      onResultChange(resultDraft);
      onAction("analysis.query.preview_executed", queryContextPath("preview"), baseDataset.id);
    } catch (error) {
      if (!apiConfig.useMock && error instanceof ApiError && error.code === "QUERY_CONFIRMATION_REQUIRED") {
        try {
          const estimate = await estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort());
          setQueryEstimate(estimate);
          setQueryEstimateError(null);
          setQueryEstimateKey(queryValidationKey);
          setEstimateDialogOpen(estimate.confirmationRequired);
          return;
        } catch {
          // Fall through to the regular error state when the estimate cannot be refreshed.
        }
      }
      const message = error instanceof Error ? error.message : "실행에 실패했습니다. 쿼리 또는 데이터셋 상태를 확인해 주세요.";
      setTrinoSubmissionError(message);
      onAction("analysis.query.preview_failed", queryContextPath("preview"), baseDataset.id, "failed");
    } finally {
      setTrinoSubmissionPending(false);
      setQueryPending(false);
    }
  };

  const confirmEstimatedQueryRun = () => {
    const confirmationToken = activeQueryEstimate?.confirmationToken;
    if (!confirmationToken) return;
    setEstimateDialogOpen(false);
    const requestId = queryClientRequestRef.current?.key === queryValidationKey
      ? queryClientRequestRef.current.id
      : undefined;
    void executePreview(confirmationToken, requestId);
  };

  const activeTrinoPage = trinoResultPage;
  const trinoResultStatusLabel = getTrinoResultStatusLabel(trinoRun);
  const trinoResultReady = trinoRun?.result?.storageStatus === "available";

  const trinoDisplayResult = useMemo<SqlResultDraft | null>(() => {
    if (!trinoRun || !activeTrinoPage || !baseDataset) return null;
    return {
      baseDatasetId: trinoRun.baseDatasetId,
      columns: activeTrinoPage.columns,
      datasetId: baseDataset.id,
      datasetName: baseDataset.name,
      executedAt: trinoRun.completedAt ?? trinoRun.startedAt ?? trinoRun.submittedAt,
      mode: "run",
      query: trinoRun.query,
      referenceDatasetIds: trinoRun.referenceDatasetIds,
      rowCount: trinoRun.result?.rowCount ?? activeTrinoPage.pageSize,
      rows: activeTrinoPage.rows.map((row) => row.map((cell) => cell == null ? "" : String(cell))),
      runId: trinoRun.runId,
    };
  }, [activeTrinoPage, baseDataset, trinoRun]);
  const visibleResult = resultDraft ?? (trinoResultReady ? trinoDisplayResult : null);
  const trinoJobResultDraft = useMemo<SqlResultDraft | null>(() => {
    if (!trinoRun || trinoRun.status !== "succeeded" || !baseDataset) return null;
    const columns = trinoRun.result?.columns ?? activeTrinoPage?.columns ?? [];
    return {
      baseDatasetId: trinoRun.baseDatasetId,
      columns,
      datasetId: baseDataset.id,
      datasetName: baseDataset.name,
      executedAt: trinoRun.completedAt ?? trinoRun.startedAt ?? trinoRun.submittedAt,
      mode: "run",
      query: trinoRun.query,
      referenceDatasetIds: trinoRun.referenceDatasetIds,
      rowCount: trinoRun.result?.rowCount ?? 0,
      rows: (activeTrinoPage?.rows ?? []).map((row) => row.map((cell) => cell == null ? "" : String(cell))),
      runId: trinoRun.runId,
    };
  }, [activeTrinoPage, baseDataset, trinoRun]);

  const loadNextTrinoResultPage = async () => {
    if (!trinoRun || !activeTrinoPage?.nextCursor || trinoResultPagePending) return;
    const nextCursor = activeTrinoPage.nextCursor;
    const targetIndex = trinoResultPageIndex + 1;
    setTrinoResultPagePending(true);
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(trinoRun.runId, nextCursor);
      setTrinoResultCursors((cursors) => [...cursors.slice(0, targetIndex), nextCursor]);
      setTrinoResultPage(page);
      setTrinoResultPageIndex(targetIndex);
      setTrinoResultRetryCursor(undefined);
      trinoResultLoadKeyRef.current = "";
    } catch (error) {
      setTrinoResultError(error instanceof Error ? error.message : "다음 결과 페이지를 불러오지 못했습니다.");
      setTrinoResultRetryCursor(nextCursor);
      setTrinoResultRetryTargetIndex(targetIndex);
    } finally {
      setTrinoResultPagePending(false);
    }
  };

  const loadPreviousTrinoResultPage = async () => {
    if (!trinoRun || trinoResultPageIndex < 1 || trinoResultPagePending) return;
    const targetIndex = trinoResultPageIndex - 1;
    const cursor = trinoResultCursors[targetIndex] ?? null;
    setTrinoResultPagePending(true);
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(trinoRun.runId, cursor);
      setTrinoResultPage(page);
      setTrinoResultPageIndex(targetIndex);
      setTrinoResultRetryCursor(undefined);
      trinoResultLoadKeyRef.current = "";
    } catch (error) {
      setTrinoResultError(error instanceof Error ? error.message : "이전 결과 페이지를 불러오지 못했습니다.");
      setTrinoResultRetryCursor(cursor);
      setTrinoResultRetryTargetIndex(targetIndex);
    } finally {
      setTrinoResultPagePending(false);
    }
  };

  const retryTrinoResultPage = async () => {
    if (!trinoRun || trinoResultRetryCursor === undefined || trinoResultPagePending) return;
    const retryCursor = trinoResultRetryCursor;
    const retryTargetIndex = trinoResultRetryTargetIndex;
    const retryLoadKey = ["retry", trinoRun.runId, retryTargetIndex, retryCursor ?? "first"].join(":");
    const firstPageRetryStartedAt = retryTargetIndex === 0 && trinoFirstPageDisplayMs == null
      ? performance.now()
      : null;
    trinoResultLoadKeyRef.current = retryLoadKey;
    setTrinoResultPagePending(true);
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(trinoRun.runId, retryCursor);
      if (trinoResultLoadKeyRef.current !== retryLoadKey) return;
      setTrinoResultCursors((cursors) => {
        const next = [...cursors];
        next[retryTargetIndex] = retryCursor;
        return next.slice(0, retryTargetIndex + 1);
      });
      setTrinoResultPage(page);
      setTrinoResultPageIndex(retryTargetIndex);
      setTrinoResultRetryCursor(undefined);
      if (firstPageRetryStartedAt != null) {
        setTrinoFirstPageRowCount(page.rows.length);
        window.requestAnimationFrame(() => {
          if (trinoResultLoadKeyRef.current === retryLoadKey) {
            setTrinoFirstPageDisplayMs(Math.max(0, Math.round(performance.now() - firstPageRetryStartedAt)));
          }
        });
      }
    } catch (error) {
      if (trinoResultLoadKeyRef.current !== retryLoadKey) return;
      setTrinoResultError(error instanceof Error ? error.message : "실행 결과를 다시 불러오지 못했습니다.");
    } finally {
      if (trinoResultLoadKeyRef.current === retryLoadKey) setTrinoResultPagePending(false);
    }
  };

  const cancelActiveTrinoRun = async () => {
    if (!trinoRun) return;
    setQueryPending(true);
    try {
      const cancelledRun = await cancelTrinoQueryRun(trinoRun.runId);
      setTrinoRun(cancelledRun);
      setTrinoFirstPageDisplayMs(null);
      setTrinoFirstPageRowCount(null);
      setTrinoResultPage(null);
      setTrinoResultCursors([null]);
      setTrinoResultPageIndex(0);
      setTrinoResultError(null);
      setTrinoResultRetryCursor(undefined);
      trinoResultLoadKeyRef.current = "";
      setTrinoRunHistory((items) => items.map((item) => item.runId === cancelledRun.runId ? toTrinoHistoryItem(cancelledRun) : item));
      onAction("analysis.query.run_cancelled", `/api/query/runs/${trinoRun.runId}/cancel`, trinoRun.baseDatasetId);
    } catch (error) {
      setTrinoSubmissionError(error instanceof Error ? error.message : "실행을 취소하지 못했습니다.");
    } finally {
      setQueryPending(false);
    }
  };

  const openTrinoRunHistoryItem = async (summary: TrinoQueryRunHistoryItem) => {
    setQueryPending(true);
    try {
      const selectedRun = await getTrinoQueryRun(summary.runId);
      if (baseDatasetId !== selectedRun.baseDatasetId) {
        skipNextBaseDatasetResetRef.current = true;
        setBaseDatasetId(selectedRun.baseDatasetId);
      }
      setReferenceDatasetIds(selectedRun.referenceDatasetIds.filter((id) => id !== selectedRun.baseDatasetId));
      setExpandedDatasetId(null);
      setQuery(selectedRun.query);
      setCursorIndex(selectedRun.query.length);
      setExecuted(true);
      setExecutionMs(null);
      setResultDraft(null);
      setTrinoRun(selectedRun);
      setTrinoStatusPollError(null);
      setTrinoStatusPollRetry(0);
      setTrinoFirstPageDisplayMs(null);
      setTrinoFirstPageRowCount(null);
      setTrinoResultPage(null);
      setTrinoResultCursors([null]);
      setTrinoResultPageIndex(0);
      setTrinoResultPagePending(false);
      setTrinoResultError(null);
      setTrinoResultRetryCursor(undefined);
      setQueryEstimate(null);
      setQueryEstimateError(null);
      setQueryEstimateKey(null);
      queryClientRequestRef.current = null;
      setPreflightResult(null);
      setTrinoSubmissionError(null);
      setHistoryDialogOpen(false);
      trinoResultLoadKeyRef.current = "";
      onResultChange(null);
      onAction("analysis.query.history_opened", `/api/query/runs/${selectedRun.runId}`, selectedRun.baseDatasetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "이전 실행을 열지 못했습니다.";
      setTrinoRunHistoryError(message);
      onNotify(message, "info");
    } finally {
      setQueryPending(false);
    }
  };

  const preflightSummary = getPreflightSummary(preflightResult);
  const visiblePreflightSummary = preflightSummary?.tone === "success" ? null : preflightSummary;

  const requestQueryAiSuggestion = async () => {
    if (queryAiPending) return;

    const prompt = queryAiPrompt.trim();

    if (!baseDataset) {
      setQueryAiSuggestion(null);
      setQueryAiError("왼쪽에서 분석 테이블을 먼저 추가해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    if (prompt.length === 0) {
      setQueryAiSuggestion(null);
      setQueryAiError("만들고 싶은 분석을 자연어로 입력해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    setQueryAiSuggestion(null);
    setQueryAiError(null);

    setQueryAiPending(true);
    try {
      const suggestion = await generateQueryAiSuggestion({
        baseDataset,
        mode: "draft_sql",
        preflightMessages: preflightResult?.messages ?? [],
        prompt,
        query,
        selectedDatasets: selectedContextDatasets,
      });
      setQueryAiSuggestion(suggestion);
      onAction("analysis.ai.suggestion_created", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id);
    } catch {
      const message = "SQL 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
      setQueryAiSuggestion(null);
      setQueryAiError(message);
      onAction("analysis.ai.suggestion_failed", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id, "failed");
    } finally {
      setQueryAiPending(false);
    }
  };

  const applyQueryAiSuggestion = (suggestedSql = queryAiSuggestion?.sql ?? "") => {
    if (!baseDataset || !suggestedSql) return;
    const nextQuery = suggestedSql;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    setQueryAiDialogOpen(false);
    setQueryAiPrompt("");
    setQueryAiSuggestion(null);
    onAction("analysis.ai.suggestion_applied", "/api/query/ai-suggestions?mode=draft_sql/apply", baseDataset.id);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
      syncLineNumberScroll();
    });
  };

  const resetQuery = () => {
    updateQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    onAction("analysis.query.reset", "/api/query/reset", baseDataset?.id ?? "sql-empty");
  };

  const handleSqlAssistantOpenChange = (nextOpen: boolean) => {
    setQueryAiDialogOpen(nextOpen);
    if (!nextOpen) return;

    setQueryAiError(null);
    onAction("analysis.ai.opened", "/api/query/ai-suggestions", baseDataset?.id ?? "sql-empty");
  };

  const toggleContext = () => {
    const nextCollapsed = !contextCollapsed;
    setContextCollapsed(nextCollapsed);
    onAction(nextCollapsed ? "analysis.context.collapsed" : "analysis.context.expanded", "/api/query/context", baseDataset?.id ?? "sql-empty");
  };

  const insertSqlText = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      updateQuery(`${query.replace(/;$/, "")} ${text};`);
      return;
    }
    const shouldUseRememberedCursor = document.activeElement !== textarea
      && textarea.selectionStart === 0
      && textarea.selectionEnd === 0
      && cursorIndex > 0;
    const selectionStart = shouldUseRememberedCursor ? Math.min(cursorIndex, query.length) : textarea.selectionStart;
    const selectionEnd = shouldUseRememberedCursor ? selectionStart : textarea.selectionEnd;
    const nextQuery = `${query.slice(0, selectionStart)}${text}${query.slice(selectionEnd)}`;
    const caret = selectionStart + text.length;
    updateQuery(nextQuery);
    setCursorIndex(caret);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const applyPreflightAutoFix = () => {
    if (!preflightResult?.autoFixQuery) return;
    const nextQuery = preflightResult.autoFixQuery;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
    });
  };

  const addSelectedDataset = (targetDataset: CatalogDataset) => {
    if (targetDataset.id === baseDataset?.id) return;
    if (selectedDatasetIdSet.has(targetDataset.id)) {
      removeSelectedDataset(targetDataset);
      return;
    }
    if (!baseDataset) {
      setBaseDatasetId(targetDataset.id);
      setReferenceDatasetIds([]);
      setExpandedDatasetId(null);
      resetResultState();
      onAction(
        "analysis.context.dataset_selected",
        `/api/query/context/datasets/${targetDataset.id}/select`,
        targetDataset.id,
      );
      return;
    }
    setReferenceDatasetIds((ids) => (ids.includes(targetDataset.id) ? ids : [...ids, targetDataset.id]));
    setExpandedDatasetId(null);
    resetResultState();
    onAction(
      "analysis.context.dataset_selected",
      `/api/query/context/datasets/${targetDataset.id}/select`,
      targetDataset.id,
    );
  };

  const removeSelectedDataset = (targetDataset: CatalogDataset) => {
    const selectedIds = selectedContextDatasets.map((item) => item.id);
    const nextSelectedIds = selectedIds.filter((id) => id !== targetDataset.id);
    const nextBaseDatasetId = targetDataset.id === baseDataset?.id ? nextSelectedIds[0] ?? null : baseDataset?.id ?? null;
    const nextReferenceDatasetIds = nextSelectedIds.filter((id) => id !== nextBaseDatasetId);

    if (targetDataset.id === baseDataset?.id) {
      skipNextBaseDatasetResetRef.current = true;
      setBaseDatasetId(nextBaseDatasetId);
    }

    setReferenceDatasetIds(nextReferenceDatasetIds);
    if (nextSelectedIds.length === 0) {
      setQuery("");
      setCursorIndex(0);
      setPreflightResult(null);
      setQueryAiPrompt("");
      setQueryAiSuggestion(null);
      setQueryAiError(null);
    }
    resetResultState();
    onAction(
      "analysis.context.dataset_removed",
      `/api/query/context/datasets/${targetDataset.id}/remove`,
      targetDataset.id,
    );
  };

  const toggleDatasetPreview = (targetDataset: CatalogDataset) => {
    setExpandedDatasetId((id) => (id === targetDataset.id ? null : targetDataset.id));
    onAction(
      "analysis.context.dataset_schema_previewed",
      `/api/query/context/datasets/${targetDataset.id}/schema-preview`,
      targetDataset.id,
    );
  };

  const downloadCsv = () => {
    if (!resultDraft) return;
    const csv = [
      resultDraft.columns.map(escapeCsvCell).join(","),
      ...resultDraft.rows.map((row) => resultDraft.columns.map((_, index) => escapeCsvCell(row[index] ?? "")).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${resultDraft.datasetName}_${resultDraft.runId}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    onAction("analysis.result.downloaded", `/api/query/runs/${resultDraft.runId}/download`, resultDraft.datasetId);
  };

  const downloadTrinoCsv = (runId: string) => {
    const url = `${apiConfig.baseUrl}/api/query/runs/${encodeURIComponent(runId)}/exports/csv`;
    window.open(url, "_blank", "noopener,noreferrer");
    onAction("analysis.query_run.csv_export.download", `/api/query/runs/${runId}/exports/csv`, runId);
  };

  const createDerivedDatasetJob = async ({ configuration, context }: SqlJobWizardCreateRequest) => {
    if (trinoRun?.runId === context.sourceRunId) {
      const request: CreateTrinoSqlJobRequest = {
        baseDatasetId: context.baseDatasetId,
        dataset: {
          description: configuration.dataset.description.trim(),
          layer: configuration.dataset.layer,
          name: configuration.dataset.name.trim(),
          rag: false,
          refreshPolicy: "manual",
          tags: baseDataset ? parseDerivedDatasetTags(buildDefaultDerivedDatasetTags(baseDataset)) : [],
        },
        governance: {
          accessScope: configuration.governance.accessScope,
          owner: configuration.governance.owner.trim(),
          permissionSummary: configuration.governance.permissionSummary.trim(),
        },
        jobName: `${configuration.dataset.name.trim()} SQL Job`,
        query: context.query,
        referenceDatasetIds: context.referenceDatasetIds,
        schedule: {
          mode: configuration.schedule.mode,
          overlapPolicy: "skip_if_running",
          time: configuration.schedule.time,
          timezone: configuration.schedule.timezone,
          weekday: configuration.schedule.weekday,
        },
        sourceRunId: context.sourceRunId,
        target: {
          partitionColumn: configuration.target.partitionColumn || undefined,
          writeMode: "full_refresh",
        },
      };
      const created = await onCreateTrinoSqlJob(request);
      if (created) setJobDialogOpen(false);
      return created;
    }

    const request: CreateDerivedDatasetRequest = {
      dataset: {
        description: configuration.dataset.description.trim(),
        layer: configuration.dataset.layer,
        name: configuration.dataset.name.trim(),
        rag: false,
        refreshPolicy: "manual",
        tags: [],
      },
      job: {
        accessScope: configuration.governance.accessScope,
        compression: configuration.target.compression,
        owner: configuration.governance.owner.trim(),
        overlapPolicy: configuration.schedule.overlapPolicy,
        partitionColumn: configuration.target.partitionColumn || undefined,
        permissionSummary: configuration.governance.permissionSummary.trim(),
        scheduleLabel: formatSqlJobWizardScheduleLabel(configuration.schedule),
        scheduleMode: configuration.schedule.mode === "manual" ? "manual" : "repeat",
        scheduleSummary: formatSqlJobWizardScheduleSummary(configuration.schedule),
        storagePath: configuration.target.storagePath.trim(),
        timezone: configuration.schedule.timezone,
      },
      previewLimit: context.previewLimit,
      query: context.query,
      referenceDatasetIds: context.referenceDatasetIds,
      sourceDatasetId: context.baseDatasetId,
      sourceRunId: context.sourceRunId,
      validationKey: context.validationKey,
    };

    const created = await onCreateDatasetJob(request);
    if (created) setJobDialogOpen(false);
    return created;
  };

  const applyChartConfig = (nextConfig: SqlChartConfig) => {
    if (!resultDraft) return;
    setChartConfig(nextConfig);
    setResultView("chart");
    onAction("analysis.chart.configured", `/api/query/runs/${resultDraft.runId}/visualization`, resultDraft.datasetId);
  };

  return (
    <div className={cn("sql-page", contextCollapsed && "context-collapsed")}>
      <PageHeader
        className="sql-page-header"
        icon={<Table2 size={18} />}
        leadingAlign="center"
        title="SQL 분석"
      />
      {!contextCollapsed && (
        <Panel asChild>
          <aside className="sql-dataset-panel" ref={contextPanelRef}>
            <Tabs
              className="grid h-full min-h-0 grid-rows-[max-content_minmax(0,1fr)] gap-4"
              onValueChange={(value) => setContextPanelTab(value as "chart" | "tables")}
              value={contextPanelTab}
            >
              <div className="grid gap-4">
                <PanelHeader
                  actions={(
                    <Button type="button" onClick={toggleContext} aria-label="SQL 도구 접기" title="SQL 도구 접기" size="icon" variant="ghost">
                      <PanelLeftClose data-icon="inline-start" />
                    </Button>
                  )}
                  className="min-h-0 p-0"
                  icon={<Table2 size={16} />}
                  title="SQL 도구"
                />
                <TabsList className="grid w-full grid-cols-2" aria-label="SQL 도구 선택">
                  <TabsTrigger value="tables"><Table2 /> 분석 테이블</TabsTrigger>
                  <TabsTrigger value="chart"><BarChart3 /> 차트 생성하기</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent className="mt-0 grid min-h-0 min-w-0 grid-rows-[max-content_minmax(0,1fr)] gap-3 overflow-hidden" value="tables">
                <FilterToolbarSearch icon={<Search size={15} />} size="compact">
                  <FilterToolbarInput
                    aria-label="분석 테이블 검색"
                    className="text-xs font-bold"
                    value={datasetSearch}
                    onChange={(event) => setDatasetSearch(event.target.value)}
                    placeholder="데이터셋, 컬럼, 태그 검색"
                    type="search"
                  />
                </FilterToolbarSearch>
                <section className="grid min-h-0 grid-rows-[max-content_minmax(0,1fr)_max-content] gap-2">
                  <FieldTitle>데이터셋</FieldTitle>
                  <div className="relative min-h-0 overflow-hidden">
                    <Panel asChild>
                      <div className="absolute inset-0 min-h-0 overflow-hidden">
                        <div className="h-full min-w-0 pr-1" ref={contextListRef}>
                          <SqlDatasetTree
                            datasets={paginatedContextDatasets}
                            expandedDatasetId={expandedDatasetId}
                            onSelect={addSelectedDataset}
                            onToggle={toggleDatasetPreview}
                            selectedDatasetIds={selectedDatasetIdSet}
                          />
                          {filteredDatasets.length === 0 && (
                            <Empty size="sm" variant="bordered">
                              <EmptyHeader>
                                <EmptyTitle>{datasetSearch.trim() ? "검색 결과가 없습니다." : "선택 가능한 테이블이 없습니다."}</EmptyTitle>
                                <EmptyDescription>{datasetSearch.trim() ? "다른 검색어를 입력해 주세요." : "SQL에 사용할 테이블이 없습니다."}</EmptyDescription>
                              </EmptyHeader>
                            </Empty>
                          )}
                        </div>
                      </div>
                    </Panel>
                  </div>
                  {filteredDatasets.length > contextPageSize && (
                    <PaginationBar
                      aria-label="테이블 검색 결과 페이지"
                      buttonSize="sm"
                      currentPage={currentContextPage}
                      onNext={() => setContextPage((page) => Math.min(totalContextPages, page + 1))}
                      onPrevious={() => setContextPage((page) => Math.max(1, page - 1))}
                      rangeLabel={`${contextPageStartIndex + 1}-${contextPageStartIndex + paginatedContextDatasets.length} / ${filteredDatasets.length}`}
                      ref={contextPaginationRef}
                      totalPages={totalContextPages}
                    />
                  )}
                </section>
              </TabsContent>
              <TabsContent className="sql-chart-configurator mt-0 min-w-0" value="chart">
                <SqlChartConfigurator
                  initialConfig={chartConfig}
                  onApply={applyChartConfig}
                  sources={chartSources}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </Panel>
      )}

      <main className="sql-workspace grid min-w-0 content-start gap-3">
        {contextCollapsed && (
          <Button className="sql-context-rail-button" type="button" onClick={toggleContext} aria-label="분석 테이블 열기" title="분석 테이블 열기" size="icon" variant="outline">
            <PanelLeftOpen data-icon="inline-start" />
          </Button>
        )}
        <Panel className="sql-query-panel grid gap-4 p-5">
          <PanelHeader
            actions={(
              <ActionGroup density="compact" wrap="wrap">
                <SqlAiWriterDialog
                  disabled={!baseDataset}
                  error={queryAiError}
                  onApply={applyQueryAiSuggestion}
                  onGenerate={requestQueryAiSuggestion}
                  onOpenChange={handleSqlAssistantOpenChange}
                  onPromptChange={(nextPrompt) => {
                    setQueryAiPrompt(nextPrompt);
                    setQueryAiSuggestion(null);
                    setQueryAiError(null);
                  }}
                  open={queryAiDialogOpen}
                  pending={queryAiPending}
                  prompt={queryAiPrompt}
                  promptRef={queryAiPromptRef}
                  suggestion={queryAiSuggestion}
                />
                {!apiConfig.useMock && (
                  <Button type="button" onClick={() => { setHistoryDialogOpen(true); void refreshTrinoRunHistory(); }} size="sm" variant="outline">
                    <History data-icon="inline-start" /> 실행 이력
                  </Button>
                )}
                <Button type="button" onClick={resetQuery} size="sm" variant="outline">
                  <RotateCcw data-icon="inline-start" /> SQL 초기화
                </Button>
                <Button
                  type="button"
                  title={hasQueryPermission ? "선택 데이터셋 전체에 SQL을 실행합니다." : queryPermissionMessage}
                  onClick={() => void executePreview()}
                  disabled={!canRunPreview || queryPending || ["queued", "running"].includes(trinoRun?.status ?? "")}
                  size="sm"
                  variant="primary"
                >
                  <PlayCircle data-icon="inline-start" /> {queryPending ? "실행 중" : "실행"}
                </Button>
              </ActionGroup>
            )}
            bordered={false}
            className="sql-query-panel-header min-h-0 p-0"
            icon={<Table2 size={16} />}
            title="선택 데이터셋 기준 SQL"
          />
          <div className="grid grid-cols-1 gap-4">
            <div className={baseDataset ? "sql-editor-surface" : "sql-editor-surface empty"}>
              <pre ref={lineNumberRef} aria-hidden="true">{lineNumbers}</pre>
              <div className="sql-editor-input-wrap">
                <FieldLabel className="sr-only" htmlFor="sql-query-editor">SQL editor</FieldLabel>
                <Textarea
                  className="focus-visible:ring-0 focus-visible:ring-offset-0"
                  id="sql-query-editor"
                  ref={textareaRef}
                  disabled={!baseDataset}
                  placeholder={baseDataset ? "SQL을 입력하세요." : "왼쪽 분석 테이블에서 데이터셋을 선택하면 SQL을 작성할 수 있습니다."}
                  value={query}
                  onChange={(event) => {
                    updateQuery(event.target.value);
                    setCursorIndex(event.target.selectionStart);
                    setDismissedAutocompleteKey(null);
                  }}
                  onClick={(event) => updateCursorFromTextarea(event.currentTarget)}
                  onBlur={() => setDismissedAutocompleteKey(autocompleteContext.key)}
                  onKeyDown={handleQueryKeyDown}
                  onKeyUp={(event) => {
                    if (["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(event.key)) return;
                    updateCursorFromTextarea(event.currentTarget);
                  }}
                  onScroll={syncLineNumberScroll}
                  spellCheck={false}
                />
                {autocompleteCandidates.length > 0 && (
                  <Panel className="sql-autocomplete-popover">
                    <ScrollArea className="h-[220px]" type="always">
                      <div className="grid gap-1 p-1.5 pr-3">
                        {autocompleteCandidates.map((candidate, index) => (
                          <Button
                            className="grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] gap-2.5 px-2 text-left"
                            key={candidate.id}
                            type="button"
                            size="sm"
                            variant={index === autocompleteIndex ? "subtle" : "ghost"}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => applyAutocompleteCandidate(candidate)}
                          >
                            <strong>{candidate.label}</strong>
                            <Badge size="sm" variant="secondary">{candidate.detail}</Badge>
                          </Button>
                        ))}
                      </div>
                    </ScrollArea>
                  </Panel>
                )}
              </div>
            </div>
          </div>
          {visiblePreflightSummary && <div className="sql-editor-footer">
            <div className="sql-editor-status-line">
              <Badge
                size="sm"
                variant={visiblePreflightSummary.tone === "error" ? "destructive" : "warning"}
              >
                {visiblePreflightSummary.label}
              </Badge>
              {visiblePreflightSummary.detail && (
                <Badge
                  size="sm"
                  variant={visiblePreflightSummary.tone === "error" ? "destructive" : "warning"}
                >
                  {visiblePreflightSummary.detail}
                </Badge>
              )}
            </div>
            {preflightResult?.autoFixQuery && (
              <Button type="button" onClick={applyPreflightAutoFix} size="sm" variant="outline">
                식별자 자동 보정
              </Button>
            )}
          </div>}
          {usesTrinoRuntime && baseDataset && (
            <section className={`sql-query-evaluation ${activeQueryEstimate?.riskLevel ?? "neutral"}`} aria-live="polite">
              <div className="sql-query-evaluation-heading">
                <span><Activity size={14} /> 실행 평가</span>
                <strong
                  aria-label={activeQueryEstimate ? getQueryEstimateSourceDetail(activeQueryEstimate) : undefined}
                  title={activeQueryEstimate ? getQueryEstimateSourceDetail(activeQueryEstimate) : undefined}
                >
                  {trinoValidationPending
                    ? "Trino SQL 검증 중"
                    : trinoValidationError
                      ? "Trino SQL 검증 실패"
                    : queryEstimatePending
                    ? "Iceberg 스캔량 계산 중"
                      : activeQueryEstimateError
                      ? "평가를 완료하지 못했습니다"
                      : activeQueryEstimate
                        ? getQueryEstimateSourceLabel(activeQueryEstimate)
                        : canRunPreview ? "평가 대기 중" : "실행 불가"}
                </strong>
              </div>
              {activeQueryEstimate && (
                <div className="sql-query-evaluation-metrics">
                  <span>
                    {activeQueryEstimate.estimateSource === "conservative_bound" ? "보수적 예상 스캔량" : "예상 스캔량"}{" "}
                    <strong>{formatEstimateBytes(activeQueryEstimate.estimatedBytes)}</strong>
                  </span>
                  {activeQueryEstimate.warnings[0] && <span className="sql-query-evaluation-warning">{activeQueryEstimate.warnings[0]}</span>}
                </div>
              )}
              {activeQueryEstimateError && <span className="sql-query-evaluation-warning">{activeQueryEstimateError}</span>}
              {trinoValidationError && <span className="sql-query-evaluation-warning">{trinoValidationError}</span>}
            </section>
          )}
        </Panel>

        <Panel className={cn("sql-result-panel grid gap-4 p-5", visibleResult && "has-result")}>
          <div className="sql-result-summary">
            <PanelHeader
              actions={(
                <ActionGroup density="compact" wrap="wrap">
                  <Badge size="sm" variant={trinoRun?.status === "failed" || (usesTrinoRuntime && trinoSubmissionError) ? "destructive" : "secondary"}>
                    {trinoSubmissionPending
                      ? "실행 준비 중"
                      : usesTrinoRuntime && trinoSubmissionError
                        ? "실행 실패"
                        : trinoRun ? trinoResultStatusLabel : queryPending ? "실행 중" : executed ? "완료" : "대기 중"}
                  </Badge>
                  {trinoRun && ["queued", "running"].includes(trinoRun.status) && (
                    <Button type="button" onClick={() => void cancelActiveTrinoRun()} disabled={queryPending} size="sm" variant="outline"><Square data-icon="inline-start" /> 취소</Button>
                  )}
                  {executionMs !== null && !trinoRun && <Badge size="sm" variant="outline">{formatDuration(executionMs)}</Badge>}
                </ActionGroup>
              )}
              bordered={false}
              className="min-h-0 p-0"
              icon={<Table2 size={16} />}
              title={trinoSubmissionPending
                ? "실행 준비 중"
                : usesTrinoRuntime && trinoSubmissionError
                  ? "실행 실패"
                  : visibleResult
                    ? `${visibleResult.rowCount.toLocaleString()}행 ${trinoRun?.result?.storageStatus === "collecting" ? "수집됨" : "조회됨"}`
                    : trinoRun && isTrinoResultCollectionActive(trinoRun) ? "전체 결과 수집 중" : trinoRun ? "실행 상태 확인 중" : "결과 대기 중"}
            />
            <TrinoExecutionTimeline
              firstPageError={trinoResultError}
              firstPageDisplayMs={trinoFirstPageDisplayMs}
              firstPageRowCount={trinoFirstPageRowCount}
              run={trinoSubmissionPending || (usesTrinoRuntime && trinoSubmissionError) ? null : trinoRun}
              submissionError={usesTrinoRuntime ? trinoSubmissionError : null}
              submissionPending={trinoSubmissionPending}
            />
            {((!usesTrinoRuntime && trinoSubmissionError) || trinoStatusPollError) && (
              <div className="sql-result-toolbar error" role="alert">
                <span>{!usesTrinoRuntime && trinoSubmissionError ? trinoSubmissionError : `${trinoStatusPollError} 자동으로 다시 확인합니다.`}</span>
              </div>
            )}
            {visibleResult && (
              <>
                <div className="sql-result-toolbar">
                  {!trinoRun ? (
                    <ToggleGroup
                      aria-label="SQL 결과 보기"
                      onValueChange={(value) => value && setResultView(value as "chart" | "table")}
                      type="single"
                      value={resultView}
                    >
                      <ToggleGroupItem aria-label="차트 보기" size="sm" value="chart"><BarChart3 /> 차트 보기</ToggleGroupItem>
                      <ToggleGroupItem aria-label="데이터 미리보기" size="sm" value="table"><Table2 /> 데이터 미리보기</ToggleGroupItem>
                    </ToggleGroup>
                  ) : (
                    <span className="text-xs font-semibold text-slate-500">
                      실행 ID {visibleResult.runId} · {visibleResult.rows.length.toLocaleString()}/{visibleResult.rowCount.toLocaleString()}행 표시 · {formatResultTimestamp(visibleResult.executedAt)}
                    </span>
                  )}
                  <ActionGroup density="compact" wrap="wrap">
                    {!trinoRun && <Button type="button" onClick={downloadCsv} size="sm" variant="outline"><Download data-icon="inline-start" /> CSV 다운로드</Button>}
                    {!trinoRun && <Button type="button" onClick={() => setJobDialogOpen(true)} size="sm" variant="outline"><Workflow data-icon="inline-start" /> 처리 Job 생성</Button>}
                    {trinoRun?.status === "succeeded" && (
                      <>
                        <Button type="button" onClick={() => downloadTrinoCsv(trinoRun.runId)} size="sm" variant="primary"><Download data-icon="inline-start" /> CSV 다운로드</Button>
                        <Button type="button" onClick={() => setJobDialogOpen(true)} size="sm" variant="outline"><Workflow data-icon="inline-start" /> 반복 Job 만들기</Button>
                      </>
                    )}
                    <Button type="button" onClick={() => setResultDialogOpen(true)} size="sm" variant="outline"><Maximize2 data-icon="inline-start" /> 전체 보기</Button>
                  </ActionGroup>
                </div>
                {trinoResultError && (
                  <div className="sql-result-toolbar error" role="alert">
                    <span>{trinoResultError}</span>
                    <Button type="button" onClick={() => void retryTrinoResultPage()} size="sm" variant="outline"><RotateCcw data-icon="inline-start" /> 다시 시도</Button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="sql-result-body">
            {visibleResult ? (
              <ScrollArea className="sql-result-scroll" scrollbars="both" type="always">
                {!trinoRun && resultView === "chart"
                  ? chartConfig && activeChartSource
                    ? <SqlResultChart chartConfig={chartConfig} source={activeChartSource} />
                    : <SqlChartEmptyState />
                  : (
                    <SqlPreviewTable
                      resultDraft={visibleResult}
                      remotePageIndex={trinoRun ? trinoResultPageIndex : undefined}
                      remotePageNumber={activeTrinoPage?.pageNumber}
                      remotePageSize={activeTrinoPage?.pageSize}
                      remoteNextCursor={activeTrinoPage?.nextCursor}
                      remotePending={trinoResultPagePending}
                      remoteRowEnd={activeTrinoPage?.rowEnd}
                      remoteRowStart={activeTrinoPage?.rowStart}
                      remoteTotalPages={activeTrinoPage?.totalPages}
                      remoteTotalRows={activeTrinoPage?.totalRows}
                      onRemoteNext={trinoRun ? () => void loadNextTrinoResultPage() : undefined}
                      onRemotePrevious={trinoRun && trinoResultPageIndex > 0 ? () => void loadPreviousTrinoResultPage() : undefined}
                    />
                  )}
              </ScrollArea>
            ) : (
              <Empty className="sql-result-empty" size="sm" variant="bordered">
                <EmptyHeader>
                  <EmptyTitle>{trinoResultError ? "결과를 불러오지 못했습니다." : getTrinoResultEmptyTitle(trinoRun)}</EmptyTitle>
                  <EmptyDescription>{trinoResultError ?? trinoRun?.error?.message ?? getTrinoResultEmptyMessage(trinoRun, Boolean(baseDataset))}</EmptyDescription>
                </EmptyHeader>
                {trinoResultError ? <Button type="button" onClick={() => void retryTrinoResultPage()} size="sm" variant="outline"><RotateCcw data-icon="inline-start" /> 다시 시도</Button> : null}
              </Empty>
            )}
          </div>
        </Panel>
      </main>
      {visibleResult && (
        <Dialog onOpenChange={setResultDialogOpen} open={resultDialogOpen}>
          <DialogContent className="grid h-[min(900px,calc(100vh-2rem))] w-[min(1440px,calc(100vw-2rem))] max-w-none grid-rows-[max-content_minmax(0,1fr)] overflow-hidden">
            <DialogHeader>
              <DialogTitle>SQL 결과 전체 보기</DialogTitle>
              <DialogDescription>
                {visibleResult.rows.length}/{visibleResult.rowCount}행 · {visibleResult.columns.length}컬럼 · {!trinoRun && resultView === "chart" ? "차트" : "표"} 보기
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0" scrollbars="both" type="always">
              {!trinoRun && resultView === "chart"
                ? chartConfig && activeChartSource
                  ? <SqlResultChart chartConfig={chartConfig} source={activeChartSource} />
                  : <SqlChartEmptyState />
                  : (
                  <div className="min-w-0 px-4 pb-4 pt-6">
                    <SqlPreviewTable
                      resultDraft={visibleResult}
                      remotePageIndex={trinoRun ? trinoResultPageIndex : undefined}
                      remotePageNumber={activeTrinoPage?.pageNumber}
                      remotePageSize={activeTrinoPage?.pageSize}
                      remoteNextCursor={activeTrinoPage?.nextCursor}
                      remotePending={trinoResultPagePending}
                      remoteRowEnd={activeTrinoPage?.rowEnd}
                      remoteRowStart={activeTrinoPage?.rowStart}
                      remoteTotalPages={activeTrinoPage?.totalPages}
                      remoteTotalRows={activeTrinoPage?.totalRows}
                      onRemoteNext={trinoRun ? () => void loadNextTrinoResultPage() : undefined}
                      onRemotePrevious={trinoRun && trinoResultPageIndex > 0 ? () => void loadPreviousTrinoResultPage() : undefined}
                    />
                  </div>
                )}
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}
      {estimateDialogOpen && queryEstimate && (
        <DialogShell
          footer={(
            <>
              <Button type="button" onClick={() => setEstimateDialogOpen(false)} size="sm" variant="ghost">취소</Button>
              <Button type="button" onClick={confirmEstimatedQueryRun} size="sm" variant="primary"><PlayCircle data-icon="inline-start" /> 실행</Button>
            </>
          )}
          onClose={() => setEstimateDialogOpen(false)}
          open
          size="md"
          title="이 쿼리를 실행할까요?"
        >
          <div className="grid gap-3 text-sm text-slate-700">
            <strong>{queryEstimate.estimateSource === "conservative_bound" ? "보수적 예상 스캔량" : "예상 스캔량"} {formatEstimateBytes(queryEstimate.estimatedBytes)}</strong>
            {getQueryEstimateSourceDetail(queryEstimate) && <span>{getQueryEstimateSourceDetail(queryEstimate)}</span>}
            {queryEstimate.warnings.map((warning) => <span className="text-amber-700" key={warning}>{warning}</span>)}
          </div>
        </DialogShell>
      )}
      {historyDialogOpen && (
        <DialogShell
          onClose={() => setHistoryDialogOpen(false)}
          open
          size="lg"
          title="내 실행 이력"
        >
          <div className="sql-run-history-list" aria-label="내 최근 실행">
            {trinoRunHistory.length > 0 ? trinoRunHistory.map((item) => (
              <button
                className={item.runId === trinoRun?.runId ? "active" : ""}
                disabled={queryPending}
                key={item.runId}
                onClick={() => void openTrinoRunHistoryItem(item)}
                type="button"
              >
                <span className={`sql-run-history-status ${item.status}`}>{getTrinoHistoryStatusLabel(item)}</span>
                <strong>{item.query.replace(/\s+/g, " ").trim()}</strong>
                <em>{formatResultTimestamp(item.submittedAt)}</em>
              </button>
            )) : <span className="sql-run-history-empty">{trinoRunHistoryError ?? "최근 실행이 없습니다."}</span>}
          </div>
        </DialogShell>
      )}
      {(trinoJobResultDraft ?? resultDraft) && baseDataset && jobDialogOpen && (
        <SqlJobWizardDialog
          baseDataset={baseDataset}
          defaultMetadata={{
            description: buildDefaultDerivedDatasetDescription(baseDataset),
            name: buildDefaultDerivedDatasetName(baseDataset),
          }}
          engine={trinoJobResultDraft ? "trino" : "compatibility"}
          onClose={() => setJobDialogOpen(false)}
          onCreate={createDerivedDatasetJob}
          open={jobDialogOpen}
          pending={createPending}
          resultDraft={trinoJobResultDraft ?? resultDraft!}
        />
      )}
    </div>
  );
}
