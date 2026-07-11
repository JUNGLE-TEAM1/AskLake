import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Database,
  Download,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Table2,
} from "lucide-react";
import { apiConfig } from "../../services/apiClient";
import { executeQueryPreview } from "../../services/mockApi";
import { cancelTrinoQueryRun, estimateSqlQueryRun, getTrinoMaterialization, getTrinoQueryRun, getTrinoQueryRunResultPage, isTrinoQueryRun, listTrinoQueryRuns, materializeTrinoQueryRun, submitSqlQueryRun } from "../../services/pipelineApi";
import {
  generateQueryAiSuggestion,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, CurrentUserResponse, DashboardEntry, DerivedDatasetLayer, SqlResultDraft, TrinoMaterializationRun, TrinoQueryEstimate, TrinoQueryRun, TrinoQueryRunHistoryItem, TrinoQueryRunResultPage } from "../../types";
import { canQueryDatasetAs, datasetQueryBlockedMessage } from "../../utils/permissions";
import { DashboardPage } from "../dashboard/DashboardPage";
import { SqlDatasetTree } from "./SqlDatasetRow";
import { SqlPreviewTable } from "./SqlPreviewTable";
import { SchemaDetailsPanel } from "./SqlSchemaPanel";
import {
  PREVIEW_ROW_LIMIT,
  buildAutocompleteCandidates,
  buildDefaultDerivedDatasetDescription,
  buildDefaultDerivedDatasetName,
  buildDefaultDerivedDatasetTags,
  buildJoinDraftQuery,
  buildDefaultQuery,
  escapeCsvCell,
  formatDuration,
  formatResultTimestamp,
  getAutocompleteContext,
  getColumnInsertText,
  getPreflightSummary,
  parseDerivedDatasetTags,
  runSqlPreflight,
  type AutocompleteCandidate,
  type SqlPreflightResult,
} from "./sqlLogic";

const QUERY_AI_PROMPT_PLACEHOLDER = "만들고 싶은 분석을 자연어로 입력해 주세요.";

function isSqlCandidateDataset(dataset: CatalogDataset) {
  const normalizedName = dataset.name.toLowerCase();
  const normalizedTags = dataset.tags.map((tag) => tag.toLowerCase());

  return dataset.permissions?.canQuery !== false
    && !normalizedName.includes("legacy")
    && !normalizedTags.includes("#legacy");
}

function getTrinoResultStatusLabel(run: TrinoQueryRun | null) {
  if (!run) return "대기 중";
  if (run.result?.storageStatus === "collecting") return "결과 수집 중";
  if (run.result?.storageStatus === "available") return "결과 준비됨";
  if (run.result?.storageStatus === "expired") return "보관 기간 만료";
  if (run.result?.storageStatus === "unavailable") return "결과 저장 실패";
  if (run.status === "failed") return "실행 실패";
  if (run.status === "cancelled") return "실행 취소됨";
  return run.status === "queued" ? "실행 대기 중" : "실행 중";
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

function getTrinoMaterializationStatusLabel(run: TrinoMaterializationRun) {
  if (run.status === "failed") return "Iceberg Dataset 생성 실패";
  if (run.status === "cancelled") return "Iceberg Dataset 생성 취소됨";
  if (run.queryEngineStatus === "registration_failed") return "테이블 생성 후 SQL 등록 검증 실패";
  if (run.queryEngineStatus === "available") return "Dataset 생성 완료 · SQL 사용 가능";
  if (run.status === "succeeded") return "Trino 테이블 등록 확인 중";
  return run.status === "queued" ? "Dataset 생성 대기 중" : "Dataset 생성 중";
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
  if (run?.result?.storageStatus === "collecting") return "결과를 수집하고 있습니다.";
  if (run?.status === "failed") return "실행에 실패했습니다.";
  if (run?.status === "cancelled") return "실행이 취소되었습니다.";
  return "아직 결과가 없습니다.";
}

function getTrinoResultEmptyMessage(run: TrinoQueryRun | null, hasBaseDataset: boolean) {
  if (run?.result?.storageStatus === "expired") return "보관 기간이 지난 결과는 다시 실행하거나 Iceberg Dataset으로 생성해 주세요.";
  if (run?.result?.storageStatus === "collecting") return "서버가 결과 페이지를 저장하는 중입니다. 완료되는 대로 첫 페이지를 표시합니다.";
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

function formatMetricNumber(value: number | null | undefined) {
  return value == null ? "-" : new Intl.NumberFormat("ko-KR").format(value);
}

export function SqlAnalysisPage({
  cachedResult,
  currentUser,
  dataset,
  datasets,
  onAction,
  onNotify,
  onPrepareDatasetJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  currentUser?: CurrentUserResponse | null;
  dataset: CatalogDataset | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string, tone?: "success" | "info") => void;
  onPrepareDatasetJob: (request: CreateDerivedDatasetRequest) => boolean;
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
  const [contextPanelTab, setContextPanelTab] = useState<"tables" | "queryAi">("tables");
  const [datasetSearch, setDatasetSearch] = useState("");
  const [contextPage, setContextPage] = useState(1);
  const [contextPageSize, setContextPageSize] = useState(() => Math.max(1, datasets.length));
  const [openSchemaDatasetId, setOpenSchemaDatasetId] = useState<string | null>(null);
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [trinoRun, setTrinoRun] = useState<TrinoQueryRun | null>(null);
  const [trinoRunHistory, setTrinoRunHistory] = useState<TrinoQueryRunHistoryItem[]>([]);
  const [trinoRunHistoryError, setTrinoRunHistoryError] = useState<string | null>(null);
  const [trinoResultPages, setTrinoResultPages] = useState<TrinoQueryRunResultPage[]>([]);
  const [trinoResultPageIndex, setTrinoResultPageIndex] = useState(0);
  const [trinoResultError, setTrinoResultError] = useState<string | null>(null);
  const [trinoResultRetryCursor, setTrinoResultRetryCursor] = useState<string | null | undefined>(undefined);
  const [trinoMaterialization, setTrinoMaterialization] = useState<TrinoMaterializationRun | null>(null);
  const [trinoMaterializationError, setTrinoMaterializationError] = useState<string | null>(null);
  const [trinoMaterializationPending, setTrinoMaterializationPending] = useState(false);
  const [queryEstimate, setQueryEstimate] = useState<TrinoQueryEstimate | null>(null);
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const [preflightResult, setPreflightResult] = useState<SqlPreflightResult | null>(null);
  const [queryAiPrompt, setQueryAiPrompt] = useState("");
  const [queryAiSuggestion, setQueryAiSuggestion] = useState<QueryAiSuggestion | null>(null);
  const [queryAiPending, setQueryAiPending] = useState(false);
  const [queryAiError, setQueryAiError] = useState<string | null>(null);
  const [derivedDatasetName, setDerivedDatasetName] = useState(dataset ? buildDefaultDerivedDatasetName(dataset) : "");
  const [derivedDatasetDescription, setDerivedDatasetDescription] = useState(dataset ? buildDefaultDerivedDatasetDescription(dataset) : "");
  const [derivedDatasetTags, setDerivedDatasetTags] = useState(dataset ? buildDefaultDerivedDatasetTags(dataset) : "");
  const [derivedDatasetLayer, setDerivedDatasetLayer] = useState<DerivedDatasetLayer>("GOLD");
  const [derivedDatasetRag, setDerivedDatasetRag] = useState(dataset?.rag ?? false);
  const [materializeDialogOpen, setMaterializeDialogOpen] = useState(false);
  const [dashboardDialogOpen, setDashboardDialogOpen] = useState(false);
  const [dashboardDialogVersion, setDashboardDialogVersion] = useState(0);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string | null>(null);
  const contextPanelRef = useRef<HTMLElement | null>(null);
  const contextListRef = useRef<HTMLDivElement | null>(null);
  const contextPaginationRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const queryAiPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const skipNextBaseDatasetResetRef = useRef(false);
  const referenceDatasetIdSet = useMemo(() => new Set(referenceDatasetIds), [referenceDatasetIds]);
  const queryValidationKey = useMemo(
    () => JSON.stringify({
      baseDatasetId: baseDataset?.id ?? null,
      query,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
    }),
    [baseDataset?.id, query, referenceDatasetIds],
  );
  const derivedDatasetTagList = useMemo(() => parseDerivedDatasetTags(derivedDatasetTags), [derivedDatasetTags]);
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
  const selectedDatasetIdSet = useMemo(
    () => new Set(selectedContextDatasets.map((item) => item.id)),
    [selectedContextDatasets],
  );
  const sqlCandidateDatasets = useMemo(
    () => datasets.filter(isSqlCandidateDataset),
    [datasets],
  );
  const schemaDataset = useMemo(
    () => selectedContextDatasets.find((item) => item.id === openSchemaDatasetId) ?? selectedContextDatasets[0] ?? null,
    [openSchemaDatasetId, selectedContextDatasets],
  );
  const dashboardBaseDataset = useMemo(() => {
    if (baseDataset) return baseDataset;
    if (!resultDraft) return null;
    const candidateIds = [resultDraft.baseDatasetId, resultDraft.datasetId].filter((id): id is string => Boolean(id));
    return candidateIds
      .map((id) => datasets.find((item) => item.id === id) ?? (dataset?.id === id ? dataset : null))
      .find((item): item is CatalogDataset => Boolean(item)) ?? null;
  }, [baseDataset, dataset, datasets, resultDraft]);
  const dashboardDialogEntry = useMemo<DashboardEntry>(() => ({
    baseDatasetId: dashboardBaseDataset?.id,
    dashboardId: resultDraft && dashboardBaseDataset ? `dash_${dashboardBaseDataset.id}_${resultDraft.runId}` : "dash_sql_empty_draft",
    runtimeMode: "draft",
    sqlResultDatasetId: resultDraft?.datasetId,
    sqlRunId: resultDraft?.runId,
    source: "sql",
    view: "runtime",
    version: dashboardDialogVersion,
  }), [dashboardBaseDataset, dashboardDialogVersion, resultDraft]);
  const selectedReferenceDatasets = useMemo(
    () => datasets.filter((item) => referenceDatasetIdSet.has(item.id)),
    [datasets, referenceDatasetIdSet],
  );
  const hasQueryPermission = Boolean(baseDataset && canQueryDatasetAs(baseDataset, currentUser) && selectedReferenceDatasets.every((item) => canQueryDatasetAs(item, currentUser)));
  const blockedQueryDataset = baseDataset && !canQueryDatasetAs(baseDataset, currentUser)
    ? baseDataset
    : selectedReferenceDatasets.find((item) => !canQueryDatasetAs(item, currentUser));
  const queryPermissionMessage = hasQueryPermission ? "" : datasetQueryBlockedMessage(blockedQueryDataset, "선택 데이터셋");
  const canRunPreview = Boolean(baseDataset && hasQueryPermission && preflightResult?.canExecute === true && preflightResult.key === queryValidationKey);
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
    const contextDatasets = sqlCandidateDatasets.filter((item) => !selectedDatasetIdSet.has(item.id));
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
      setOpenSchemaDatasetId(null);
      setExpandedDatasetId(null);
      return;
    }

    setBaseDatasetId(dataset.id);
    setReferenceDatasetIds([]);
    setOpenSchemaDatasetId(dataset.id);
    setExpandedDatasetId(null);
  }, [dataset?.id]);

  useEffect(() => {
    if (skipNextBaseDatasetResetRef.current) {
      skipNextBaseDatasetResetRef.current = false;
      return;
    }

    if (!baseDataset) {
      setExecuted(false);
      setQuery("");
      setCursorIndex(0);
      setResultDraft(null);
      setExecutionMs(null);
      setPreflightResult(null);
      setDerivedDatasetName("");
      setDerivedDatasetDescription("");
      setDerivedDatasetTags("");
      setDerivedDatasetRag(false);
      setMaterializeDialogOpen(false);
      setDashboardDialogOpen(false);
      setQueryAiPrompt("");
      setQueryAiSuggestion(null);
      setQueryAiError(null);
      setOpenSchemaDatasetId(null);
      setReferenceDatasetIds([]);
      onResultChange(null);
      return;
    }

    if (canRestoreCachedResult) return;

    setExecuted(false);
    setQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    setResultDraft(null);
    setExecutionMs(null);
    setPreflightResult(null);
    setDerivedDatasetName(buildDefaultDerivedDatasetName(baseDataset));
    setDerivedDatasetDescription(buildDefaultDerivedDatasetDescription(baseDataset));
    setDerivedDatasetTags(buildDefaultDerivedDatasetTags(baseDataset));
    setDerivedDatasetRag(baseDataset.rag);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
    setQueryAiPrompt("");
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setOpenSchemaDatasetId(baseDataset.id);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset, canRestoreCachedResult, defaultQuery]);

  useEffect(() => {
    if (!baseDataset || !cachedResult || !canRestoreCachedResult) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);

    setExecuted(true);
    setQuery(cachedResult.query);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    setResultDraft(cachedResult);
    setExecutionMs(null);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setOpenSchemaDatasetId(baseDataset.id);
  }, [baseDataset, cachedResult, canRestoreCachedResult]);

  const queryContextPath = (mode: "preflight" | "preview" | "run" = "preview") => {
    const params = new URLSearchParams({ baseDatasetId: baseDataset?.id ?? "" });
    referenceDatasetIds.forEach((id) => params.append("referenceDatasetIds", id));
    params.set("mode", mode);
    if (mode === "preview") params.set("previewLimit", String(PREVIEW_ROW_LIMIT));
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
    if (contextCollapsed) return;
    let frameId = 0;

    const updateContextPageSize = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const panel = contextPanelRef.current;
        const list = contextListRef.current;
        if (!panel || !list) return;

        const firstRow = list.querySelector<HTMLElement>(".sql-tree-table-row-shell");
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
  }, [contextCollapsed, datasetSearch, expandedDatasetId, filteredDatasets.length, selectedContextDatasets.length]);

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
    setPreflightResult(runSqlPreflight(query, baseDataset, selectedReferenceDatasets, queryValidationKey));
  }, [baseDataset, hasQueryPermission, query, queryPermissionMessage, queryValidationKey, selectedReferenceDatasets]);

  const buildPreviewDraft = (): Promise<SqlResultDraft> => {
    if (!baseDataset) return Promise.reject(new Error("No dataset selected"));
    return executeQueryPreview(baseDataset, query, {
      limit: PREVIEW_ROW_LIMIT,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
      validationKey: queryValidationKey,
    });
  };

  useEffect(() => {
    if (!trinoRun || !["queued", "running"].includes(trinoRun.status)) return;
    const timeoutId = window.setTimeout(() => {
      void getTrinoQueryRun(trinoRun.runId)
        .then((nextRun) => setTrinoRun(nextRun))
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Trino 실행 상태를 확인하지 못했습니다.";
          setTrinoRun((current) => current ? {
            ...current,
            error: { code: "STATUS_POLL_FAILED", message },
            status: "failed",
          } : current);
          setPreflightResult({ key: queryValidationKey, canExecute: false, messages: [{ tone: "error", text: message }] });
        });
    }, 800);
    return () => window.clearTimeout(timeoutId);
  }, [queryValidationKey, trinoRun]);

  useEffect(() => {
    if (!trinoRun || trinoResultPages.length > 0 || !trinoRun.result || (trinoRun.result.availablePageCount ?? 0) < 1) return;
    void getTrinoQueryRunResultPage(trinoRun.runId)
      .then((page) => {
        setTrinoResultPages([page]);
        setTrinoResultPageIndex(0);
        setTrinoResultError(null);
        setTrinoResultRetryCursor(undefined);
      })
      .catch((error) => {
        setTrinoResultError(error instanceof Error ? error.message : "실행 결과를 불러오지 못했습니다.");
        setTrinoResultRetryCursor(null);
      });
  }, [trinoResultPages.length, trinoRun]);

  useEffect(() => {
    if (
      !trinoMaterialization
      || (
        !["queued", "running"].includes(trinoMaterialization.status)
        && trinoMaterialization.queryEngineStatus !== "pending"
      )
    ) return;
    const timeoutId = window.setTimeout(() => {
      void getTrinoMaterialization(trinoMaterialization.materializationId)
        .then((nextMaterialization) => {
          setTrinoMaterialization(nextMaterialization);
          setTrinoMaterializationError(null);
        })
        .catch((error) => {
          setTrinoMaterializationError(error instanceof Error ? error.message : "Iceberg Dataset 상태를 확인하지 못했습니다.");
        });
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, [trinoMaterialization]);

  const resetResultState = () => {
    setExecuted(false);
    setResultDraft(null);
    setTrinoRun(null);
    setTrinoResultPages([]);
    setTrinoResultPageIndex(0);
    setTrinoResultError(null);
    setTrinoResultRetryCursor(undefined);
    setTrinoMaterialization(null);
    setTrinoMaterializationError(null);
    setTrinoMaterializationPending(false);
    setQueryEstimate(null);
    setEstimateDialogOpen(false);
    setExecutionMs(null);
    setPreflightResult(null);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
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

  const executePreview = async (confirmationToken?: string) => {
    if (!baseDataset || !canRunPreview) {
      onAction("analysis.query.preview_blocked", queryContextPath("preview"), baseDataset?.id ?? "sql-empty", "failed");
      return;
    }
    const startedAt = performance.now();
    setQueryPending(true);
    try {
      if (!apiConfig.useMock) {
        if (!confirmationToken) {
          const estimate = await estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort());
          setQueryEstimate(estimate);
          if (estimate.confirmationRequired) {
            setEstimateDialogOpen(true);
            return;
          }
        }
        const response = await submitSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort(), confirmationToken);
        if (isTrinoQueryRun(response)) {
          setExecuted(true);
          setExecutionMs(Math.round(performance.now() - startedAt));
          setResultDraft(null);
          setTrinoRun(response);
          setTrinoResultPages([]);
          setTrinoResultPageIndex(0);
          setTrinoResultError(null);
          setTrinoResultRetryCursor(undefined);
          setTrinoMaterialization(null);
          setTrinoMaterializationError(null);
          setTrinoMaterializationPending(false);
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
      setExecuted(true);
      setExecutionMs(Math.round(performance.now() - startedAt));
      setResultDraft(resultDraft);
      onResultChange(resultDraft);
      onAction("analysis.query.preview_executed", queryContextPath("preview"), baseDataset.id);
    } catch (error) {
      if (!apiConfig.useMock && error instanceof ApiError && error.code === "QUERY_CONFIRMATION_REQUIRED") {
        try {
          const estimate = await estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort());
          setQueryEstimate(estimate);
          setEstimateDialogOpen(estimate.confirmationRequired);
          return;
        } catch {
          // Fall through to the regular error state when the estimate cannot be refreshed.
        }
      }
      const message = error instanceof Error ? error.message : "실행에 실패했습니다. 쿼리 또는 데이터셋 상태를 확인해 주세요.";
      setPreflightResult({
        key: queryValidationKey,
        canExecute: false,
        messages: [{ tone: "error", text: message }],
      });
      onAction("analysis.query.preview_failed", queryContextPath("preview"), baseDataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

  const confirmEstimatedQueryRun = () => {
    const confirmationToken = queryEstimate?.confirmationToken;
    if (!confirmationToken) return;
    setEstimateDialogOpen(false);
    void executePreview(confirmationToken);
  };

  const activeTrinoPage = trinoResultPages[trinoResultPageIndex] ?? null;
  const trinoResultStatusLabel = getTrinoResultStatusLabel(trinoRun);
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
  const visibleResult = resultDraft ?? trinoDisplayResult;

  const loadNextTrinoResultPage = async () => {
    if (!trinoRun || !activeTrinoPage?.nextCursor) return;
    const nextCursor = activeTrinoPage.nextCursor;
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(trinoRun.runId, nextCursor);
      setTrinoResultPages((pages) => [...pages, page]);
      setTrinoResultPageIndex((index) => index + 1);
      setTrinoResultRetryCursor(undefined);
    } catch (error) {
      setTrinoResultError(error instanceof Error ? error.message : "다음 결과 페이지를 불러오지 못했습니다.");
      setTrinoResultRetryCursor(nextCursor);
    }
  };

  const retryTrinoResultPage = async () => {
    if (!trinoRun || trinoResultRetryCursor === undefined) return;
    const retryCursor = trinoResultRetryCursor;
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(trinoRun.runId, retryCursor);
      if (retryCursor === null) {
        setTrinoResultPages([page]);
        setTrinoResultPageIndex(0);
      } else {
        setTrinoResultPages((pages) => [...pages, page]);
        setTrinoResultPageIndex((index) => index + 1);
      }
      setTrinoResultRetryCursor(undefined);
    } catch (error) {
      setTrinoResultError(error instanceof Error ? error.message : "실행 결과를 다시 불러오지 못했습니다.");
    }
  };

  const cancelActiveTrinoRun = async () => {
    if (!trinoRun) return;
    setQueryPending(true);
    try {
      const cancelledRun = await cancelTrinoQueryRun(trinoRun.runId);
      setTrinoRun(cancelledRun);
      setTrinoRunHistory((items) => items.map((item) => item.runId === cancelledRun.runId ? toTrinoHistoryItem(cancelledRun) : item));
      onAction("analysis.query.run_cancelled", `/api/query/runs/${trinoRun.runId}/cancel`, trinoRun.baseDatasetId);
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
      setOpenSchemaDatasetId(selectedRun.baseDatasetId);
      setExpandedDatasetId(null);
      setQuery(selectedRun.query);
      setCursorIndex(selectedRun.query.length);
      setExecuted(true);
      setExecutionMs(null);
      setResultDraft(null);
      setTrinoRun(selectedRun);
      setTrinoResultPages([]);
      setTrinoResultPageIndex(0);
      setTrinoResultError(null);
      setTrinoResultRetryCursor(undefined);
      setTrinoMaterialization(null);
      setTrinoMaterializationError(null);
      setTrinoMaterializationPending(false);
      setQueryEstimate(null);
      setPreflightResult(null);
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

  const requestQueryAiSuggestion = async () => {
    if (queryAiPending) return;

    if (!baseDataset) {
      setQueryAiSuggestion(null);
      setQueryAiError("왼쪽에서 분석 테이블을 먼저 추가해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    if (!hasQueryPermission) {
      setQueryAiSuggestion(null);
      setQueryAiError(queryPermissionMessage);
      return;
    }

    if (queryAiPrompt.trim().length === 0) {
      setQueryAiSuggestion(null);
      setQueryAiError("만들고 싶은 분석을 자연어로 입력해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    setQueryAiPending(true);
    setQueryAiError(null);
    try {
      const suggestion = await generateQueryAiSuggestion({
        baseDataset,
        mode: "draft_sql",
        preflightMessages: preflightResult?.messages ?? [],
        prompt: queryAiPrompt,
        query,
        selectedDatasets: selectedContextDatasets,
      });
      setQueryAiSuggestion(suggestion);
      onAction("analysis.ai.suggestion_created", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id);
    } catch (error) {
      setQueryAiError(error instanceof ApiError && error.status === 403 ? queryPermissionMessage : "AI 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
      onAction("analysis.ai.suggestion_failed", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id, "failed");
    } finally {
      setQueryAiPending(false);
    }
  };

  const applyQueryAiSuggestion = () => {
    if (!baseDataset || !queryAiSuggestion?.sql) return;
    const nextQuery = queryAiSuggestion.sql;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    onAction("analysis.ai.suggestion_applied", `/api/query/ai-suggestions?mode=${queryAiSuggestion.mode}/apply`, baseDataset.id);
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

  const addSelectedDataset = (targetDataset: CatalogDataset) => {
    if (selectedDatasetIdSet.has(targetDataset.id)) {
      selectSchemaDataset(targetDataset);
      return;
    }
    if (!baseDataset) {
      setBaseDatasetId(targetDataset.id);
      setReferenceDatasetIds([]);
      setOpenSchemaDatasetId(targetDataset.id);
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
    setOpenSchemaDatasetId(targetDataset.id);
    setExpandedDatasetId(null);
    resetResultState();
    onAction(
      "analysis.context.dataset_selected",
      `/api/query/context/datasets/${targetDataset.id}/select`,
      targetDataset.id,
    );
  };

  const joinSelectedDataset = (targetDataset: CatalogDataset) => {
    if (!baseDataset || targetDataset.id === baseDataset.id) {
      selectSchemaDataset(targetDataset);
      return;
    }
    const joinDraft = buildJoinDraftQuery({
      allDatasets: sqlCandidateDatasets,
      query,
      selectedDatasets: selectedContextDatasets.filter((item) => item.id !== targetDataset.id),
      targetDataset,
    });
    setReferenceDatasetIds((ids) => {
      const nextIds = new Set(ids);
      nextIds.add(targetDataset.id);
      joinDraft.addedDatasetIds.forEach((id) => {
        if (id !== baseDataset.id) nextIds.add(id);
      });
      return Array.from(nextIds);
    });
    updateQuery(joinDraft.query);
    setCursorIndex(joinDraft.query.length);
    setOpenSchemaDatasetId(targetDataset.id);
    setExpandedDatasetId(null);
    onAction(
      joinDraft.joined ? "analysis.context.dataset_joined" : "analysis.context.dataset_selected",
      `/api/query/context/datasets/${targetDataset.id}/join`,
      targetDataset.id,
    );
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(joinDraft.query.length, joinDraft.query.length);
      syncLineNumberScroll();
    });
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
    setOpenSchemaDatasetId(
      openSchemaDatasetId && nextSelectedIds.includes(openSchemaDatasetId) ? openSchemaDatasetId : nextBaseDatasetId,
    );
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

  const selectSchemaDataset = (targetDataset: CatalogDataset) => {
    setOpenSchemaDatasetId(targetDataset.id);
    onAction(
      "analysis.context.schema_opened",
      `/api/query/context/datasets/${targetDataset.id}/schema`,
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

  const insertColumnName = (targetDataset: CatalogDataset, columnName: string) => {
    const insertText = getColumnInsertText(targetDataset, columnName, selectedContextDatasets);
    insertSqlText(insertText);
    onAction("analysis.context.column_inserted", `/api/query/context/datasets/${targetDataset.id}/columns/${columnName}`, targetDataset.id);
  };

  const applyPreflightAutoFix = () => {
    if (!preflightResult?.autoFixQuery) return;
    const nextQuery = preflightResult.autoFixQuery;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    onAction("analysis.query.identifier_autofixed", queryContextPath("preflight"), baseDataset?.id ?? "sql-empty");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
      syncLineNumberScroll();
    });
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

  const prepareDerivedDatasetJob = () => {
    if (!baseDataset || !resultDraft) return;
    const request: CreateDerivedDatasetRequest = {
      dataset: {
        description: derivedDatasetDescription.trim() || buildDefaultDerivedDatasetDescription(baseDataset),
        layer: derivedDatasetLayer,
        name: derivedDatasetName.trim(),
        rag: derivedDatasetRag,
        refreshPolicy: "manual",
        tags: derivedDatasetTagList,
      },
      previewLimit: resultDraft.previewLimit,
      query: resultDraft.query,
      referenceDatasetIds: resultDraft.referenceDatasetIds ?? [],
      sourceDatasetId: baseDataset.id,
      sourceRunId: resultDraft.runId,
      validationKey: resultDraft.validationKey,
    };

    const prepared = onPrepareDatasetJob(request);
    if (prepared) {
      setMaterializeDialogOpen(false);
    }
  };

  const materializeTrinoRun = async () => {
    if (!baseDataset || !trinoRun) return;
    const request: CreateDerivedDatasetRequest = {
      dataset: { description: derivedDatasetDescription.trim() || buildDefaultDerivedDatasetDescription(baseDataset), layer: derivedDatasetLayer, name: derivedDatasetName.trim(), rag: derivedDatasetRag, refreshPolicy: "manual", tags: derivedDatasetTagList },
      query: trinoRun.query,
      referenceDatasetIds: trinoRun.referenceDatasetIds,
      sourceDatasetId: baseDataset.id,
      sourceRunId: trinoRun.runId,
    };
    setTrinoMaterializationError(null);
    setTrinoMaterializationPending(true);
    try {
      setTrinoMaterialization(await materializeTrinoQueryRun(trinoRun.runId, request));
      setMaterializeDialogOpen(false);
      onNotify("Iceberg Dataset 생성 요청을 접수했습니다.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Iceberg Dataset 생성 요청에 실패했습니다.";
      setTrinoMaterializationError(message);
      onNotify(message, "info");
    } finally {
      setTrinoMaterializationPending(false);
    }
  };

  const retryTrinoMaterializationStatus = async () => {
    if (!trinoMaterialization) return;
    setTrinoMaterializationError(null);
    try {
      setTrinoMaterialization(await getTrinoMaterialization(trinoMaterialization.materializationId));
    } catch (error) {
      setTrinoMaterializationError(error instanceof Error ? error.message : "Iceberg Dataset 상태를 다시 확인하지 못했습니다.");
    }
  };

  const openDashboardBuilder = () => {
    if (!dashboardBaseDataset || !resultDraft) return;
    setDashboardDialogVersion((version) => version + 1);
    setDashboardDialogOpen(true);
    onAction("dashboard.builder.modal_opened_from_sql", `/api/dashboards/${dashboardBaseDataset.id}/draft/ensure`, resultDraft.runId);
  };

  const handleDashboardBuilderMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openDashboardBuilder();
  };

  return (
    <div className={[
      "sql-page",
      contextCollapsed ? "context-collapsed" : "",
    ].filter(Boolean).join(" ")}>
      <header className="sql-page-header">
        <div>
          <h1>SQL 분석</h1>
          <p>선택한 데이터셋을 기준으로 SQL을 작성하고 Preview 결과를 처리 Job으로 전환합니다.</p>
        </div>
      </header>
      {contextCollapsed && (
        <button className="sql-context-rail-button" type="button" onClick={toggleContext} aria-label="분석 테이블 열기" title="분석 테이블 열기">
          <PanelLeftOpen size={16} />
        </button>
      )}
      {!contextCollapsed && (
        <aside className="sql-dataset-panel" ref={contextPanelRef}>
          <div className="sql-panel-header">
            <div className="sql-panel-title-row">
              <strong>SQL 도구</strong>
              <span className="sql-panel-header-actions">
                <em>{contextPanelTab === "tables" ? `${Math.max(0, datasets.length - selectedContextDatasets.length)}개 후보` : queryAiSuggestion ? "초안 생성됨" : "보조 기능"}</em>
                <button type="button" onClick={toggleContext} aria-label="분석 테이블 접기" title="분석 테이블 접기">
                  <PanelLeftClose size={15} />
                </button>
              </span>
            </div>
            <div className="sql-sidebar-tabs" role="tablist" aria-label="SQL 도구 선택">
              <button
                className={contextPanelTab === "tables" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={contextPanelTab === "tables"}
                onClick={() => setContextPanelTab("tables")}
              >
                <Table2 size={14} /> 분석 테이블
              </button>
              <button
                className={contextPanelTab === "queryAi" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={contextPanelTab === "queryAi"}
                onClick={() => setContextPanelTab("queryAi")}
              >
                <Sparkles size={14} /> Query AI
              </button>
            </div>
          </div>
          {contextPanelTab === "tables" ? (
            <div className="sql-sidebar-tab-panel tables">
              <label className="sql-context-search">
                <Search size={15} />
                <input
                  value={datasetSearch}
                  onChange={(event) => setDatasetSearch(event.target.value)}
                  placeholder="데이터셋, 컬럼, 태그 검색"
                />
              </label>
              <section className="sql-dataset-search-results">
                <div className="sql-section-heading">
                  <h2>데이터셋</h2>
                  <span>{filteredDatasets.length}개</span>
                </div>
                <div className="sql-context-result-list" ref={contextListRef}>
                  <SqlDatasetTree
                    datasets={paginatedContextDatasets}
                    expandedDatasetId={expandedDatasetId}
                    onSelect={addSelectedDataset}
                    onToggle={toggleDatasetPreview}
                  />
                  {filteredDatasets.length === 0 && (
                    <p>{datasetSearch.trim() ? "검색 결과가 없습니다." : "선택 가능한 테이블이 없습니다."}</p>
                  )}
                </div>
                {filteredDatasets.length > contextPageSize && (
                  <div className="sql-context-pagination" aria-label="테이블 검색 결과 페이지" ref={contextPaginationRef}>
                    <span>{contextPageStartIndex + 1}-{contextPageStartIndex + paginatedContextDatasets.length} / {filteredDatasets.length}</span>
                    <div>
                      <button
                        type="button"
                        disabled={currentContextPage === 1}
                        onClick={() => setContextPage((page) => Math.max(1, page - 1))}
                      >
                        이전
                      </button>
                      <strong>{currentContextPage} / {totalContextPages}</strong>
                      <button
                        type="button"
                        disabled={currentContextPage === totalContextPages}
                        onClick={() => setContextPage((page) => Math.min(totalContextPages, page + 1))}
                      >
                        다음
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <section className="sql-sidebar-tab-panel ai" aria-label="Query AI 생성">
              <div className="sql-ai-assistant sidebar">
                <div className="sql-ai-heading">
                  <div className="sql-ai-title-block">
                    <div className="sql-ai-title">
                      <Sparkles size={16} />
                      <strong>Query AI 생성</strong>
                    </div>
                    <span className="sql-ai-context">{baseDataset ? baseDataset.name : "테이블 선택 필요"}</span>
                  </div>
                </div>
                <div className="sql-ai-content">
                  <div className="sql-ai-compose">
                    <div className="sql-ai-input-row">
                      <label className="sql-ai-prompt">
                        <span>요청</span>
                        <textarea
                          ref={queryAiPromptRef}
                          onChange={(event) => {
                            setQueryAiPrompt(event.target.value);
                            setQueryAiError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.shiftKey) return;
                            event.preventDefault();
                            void requestQueryAiSuggestion();
                          }}
                          placeholder={QUERY_AI_PROMPT_PLACEHOLDER}
                          rows={3}
                          value={queryAiPrompt}
                        />
                      </label>
                      <div className="sql-ai-actions">
                        <button className="secondary-button" disabled={queryAiPending || !hasQueryPermission} title={hasQueryPermission ? "Query AI 초안을 생성합니다." : queryPermissionMessage} onClick={requestQueryAiSuggestion} type="button">
                          <Sparkles size={14} /> {queryAiPending ? "생성 중" : "제안"}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className={queryAiSuggestion ? "sql-ai-suggestion result" : queryAiError ? "sql-ai-suggestion error" : "sql-ai-suggestion empty"}>
                    {queryAiSuggestion ? (
                      <>
                        {queryAiSuggestion.sql && <pre>{queryAiSuggestion.sql}</pre>}
                        {queryAiSuggestion.sql && (
                          <button className="sql-ai-apply-button primary-button" onClick={applyQueryAiSuggestion} type="button">
                            SQL에 적용
                          </button>
                        )}
                      </>
                    ) : (
                      <span>{queryAiError ?? (!hasQueryPermission ? queryPermissionMessage : baseDataset ? "자동 실행 없이 초안만 만듭니다." : "분석 테이블을 추가하면 AI 제안을 만들 수 있습니다.")}</span>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}
        </aside>
      )}

      <main className="sql-workspace">
        <section className="sql-editor-card">
          <div className="sql-editor-header">
            <div>
              <h2>선택 데이터셋 기준 SQL</h2>
            </div>
            <div className="sql-editor-actions">
              <button className="primary-button" title={hasQueryPermission ? "선택 데이터셋 전체에 SQL을 실행합니다." : queryPermissionMessage} type="button" onClick={() => void executePreview()} disabled={!canRunPreview || queryPending || ["queued", "running"].includes(trinoRun?.status ?? "")}>
                <PlayCircle size={16} /> {queryPending ? "실행 중" : "실행"}
              </button>
            </div>
          </div>
          <div className="sql-editor-layout">
            <div className={baseDataset ? "sql-editor-surface" : "sql-editor-surface empty"}>
              <pre ref={lineNumberRef} aria-hidden="true">{lineNumbers}</pre>
              <div className="sql-editor-input-wrap">
                <textarea
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
                  <div className="sql-autocomplete-popover">
                    {autocompleteCandidates.map((candidate, index) => (
                      <button
                        className={index === autocompleteIndex ? "active" : ""}
                        key={candidate.id}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyAutocompleteCandidate(candidate)}
                      >
                        <strong>{candidate.label}</strong>
                        <span>{candidate.detail}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="sql-editor-footer">
            <div className="sql-editor-status-line">
              {preflightSummary && (
                <span className={`sql-check-pill ${preflightSummary.tone}`}>
                  {preflightSummary.label}
                </span>
              )}
              {preflightSummary?.detail && <span className={`sql-check-detail ${preflightSummary.tone}`}>{preflightSummary.detail}</span>}
            </div>
            <button className="secondary-button" type="button" onClick={resetQuery}><RotateCcw size={14} /> SQL 초기화</button>
            {preflightResult?.autoFixQuery && (
              <button className="secondary-button" type="button" onClick={applyPreflightAutoFix}>
                식별자 자동 보정
              </button>
            )}
          </div>
          {queryEstimate && (
            <div className={`sql-result-toolbar query-estimate ${queryEstimate.riskLevel}`}>
              <span>
                예상 처리량 {formatEstimateBytes(queryEstimate.estimatedBytes)}
                {queryEstimate.estimatedDurationSeconds != null ? ` · 약 ${formatDuration(queryEstimate.estimatedDurationSeconds * 1000)}` : ""}
              </span>
              <span>{queryEstimate.estimateSource === "trino_plan" ? "Trino plan 기준" : "Catalog 크기 기준"}</span>
              {queryEstimate.warnings.length > 0 && <span>{queryEstimate.warnings[0]}</span>}
            </div>
          )}
        </section>

        <section className={visibleResult ? "sql-result-card result-ready" : "sql-result-card"}>
          <div className="sql-result-header">
            <div>
              <span>실행 결과</span>
              <h2>{visibleResult ? `${visibleResult.rowCount}행 조회됨` : trinoRun ? "실행 상태 확인 중" : "결과 대기 중"}</h2>
            </div>
            <div className="sql-result-status">
              <span>{trinoRun ? trinoResultStatusLabel : queryPending ? "실행 중" : executed ? "완료" : "대기 중"}</span>
              {trinoRun && ["queued", "running"].includes(trinoRun.status) && (
                <button type="button" onClick={cancelActiveTrinoRun} disabled={queryPending}><Square size={14} /> 취소</button>
              )}
              {executionMs !== null && <span>{formatDuration(executionMs)}</span>}
            </div>
          </div>
          {!apiConfig.useMock && (
            <section className="sql-run-history" aria-label="내 최근 실행">
              <div className="sql-run-history-header">
                <span><History size={14} /> 내 최근 실행</span>
                <button type="button" onClick={() => void refreshTrinoRunHistory()} disabled={queryPending}>새로고침</button>
              </div>
              {trinoRunHistory.length > 0 ? (
                <div className="sql-run-history-list">
                  {trinoRunHistory.slice(0, 5).map((item) => (
                    <button
                      className={item.runId === trinoRun?.runId ? "active" : ""}
                      key={item.runId}
                      type="button"
                      onClick={() => void openTrinoRunHistoryItem(item)}
                      disabled={queryPending}
                    >
                      <span className={`sql-run-history-status ${item.status}`}>{getTrinoHistoryStatusLabel(item)}</span>
                      <strong>{item.query.replace(/\s+/g, " ").trim()}</strong>
                      <em>{formatResultTimestamp(item.submittedAt)}</em>
                    </button>
                  ))}
                </div>
              ) : (
                <span className="sql-run-history-empty">{trinoRunHistoryError ?? "최근 실행이 없습니다."}</span>
              )}
            </section>
          )}
          {trinoRun && (trinoRun.stats || queryEstimate) && (
            <div className="sql-execution-metrics" aria-label="쿼리 실행 지표">
              <div><span>대기</span><strong>{trinoRun.stats?.queuedMs != null ? formatDuration(trinoRun.stats.queuedMs) : "-"}</strong></div>
              <div><span>경과</span><strong>{trinoRun.stats?.elapsedMs != null ? formatDuration(trinoRun.stats.elapsedMs) : "-"}</strong></div>
              <div><span>실제 처리량</span><strong>{formatEstimateBytes(trinoRun.stats?.processedBytes)}</strong></div>
              <div><span>피크 메모리</span><strong>{formatEstimateBytes(trinoRun.stats?.peakMemoryBytes)}</strong></div>
              <div><span>처리 행</span><strong>{formatMetricNumber(trinoRun.stats?.processedRows)}</strong></div>
              {queryEstimate && <div><span>예상 처리량</span><strong>{formatEstimateBytes(queryEstimate.estimatedBytes)}</strong></div>}
            </div>
          )}
          {visibleResult ? (
            <>
              <div className="sql-result-toolbar">
                <span>
                  실행 ID {visibleResult.runId}
                  {visibleResult.previewLimit ? ` · 최대 ${visibleResult.previewLimit}행 표시` : ""}
                  {` · ${visibleResult.rows.length}/${visibleResult.rowCount}행 표시 · ${visibleResult.columns.length}컬럼`}
                  {` · ${formatResultTimestamp(visibleResult.executedAt)}`}
                </span>
                <div className="sql-result-actions">
                  {!trinoRun && <button type="button" onClick={downloadCsv}><Download size={14} /> CSV 다운로드</button>}
                  {(!trinoRun || trinoRun.status === "succeeded") && <button type="button" onClick={() => setMaterializeDialogOpen(true)}><Database size={14} /> {trinoRun ? "Iceberg Dataset 생성" : "처리 Job 생성"}</button>}
                  {!trinoRun && (
                    <button
                      disabled={!dashboardBaseDataset}
                      title={dashboardBaseDataset ? "현재 SQL 실행 결과로 대시보드 초안을 엽니다." : "SQL 실행 결과의 기준 데이터셋을 찾을 수 없습니다."}
                      type="button"
                      onClick={openDashboardBuilder}
                      onMouseDown={handleDashboardBuilderMouseDown}
                    >
                      <BarChart3 size={14} /> 대시보드 만들기
                    </button>
                  )}
                </div>
              </div>
              {trinoResultError && (
                <div className="sql-result-toolbar error" role="alert">
                  <span>{trinoResultError}</span>
                  <button type="button" onClick={() => void retryTrinoResultPage()}><RotateCcw size={14} /> 다시 시도</button>
                </div>
              )}
              {trinoMaterialization && (
                <div
                  className={trinoMaterializationError || trinoMaterialization.queryEngineStatus === "registration_failed" ? "sql-result-toolbar error" : "sql-result-toolbar"}
                  role={trinoMaterializationError || trinoMaterialization.queryEngineStatus === "registration_failed" ? "alert" : undefined}
                >
                  <span>{trinoMaterializationError ?? `${trinoMaterialization.datasetName}: ${getTrinoMaterializationStatusLabel(trinoMaterialization)}`}</span>
                  {(trinoMaterializationError || trinoMaterialization.queryEngineStatus === "registration_failed") && (
                    <button type="button" onClick={() => void retryTrinoMaterializationStatus()}><RotateCcw size={14} /> 등록 다시 확인</button>
                  )}
                </div>
              )}
              <div className="sql-result-scroll">
                <SqlPreviewTable
                  resultDraft={visibleResult}
                  remotePageIndex={trinoRun ? trinoResultPageIndex : undefined}
                  remoteNextCursor={activeTrinoPage?.nextCursor}
                  onRemoteNext={trinoRun ? () => void loadNextTrinoResultPage() : undefined}
                  onRemotePrevious={trinoRun && trinoResultPageIndex > 0 ? () => setTrinoResultPageIndex((index) => index - 1) : undefined}
                />
              </div>
            </>
          ) : (
            <div className="sql-result-empty">
              <strong>{trinoResultError ? "결과를 불러오지 못했습니다." : getTrinoResultEmptyTitle(trinoRun)}</strong>
              <span>{trinoResultError ?? trinoRun?.error?.message ?? getTrinoResultEmptyMessage(trinoRun, Boolean(baseDataset))}</span>
              {trinoResultError && <button className="secondary-button" type="button" onClick={() => void retryTrinoResultPage()}><RotateCcw size={14} /> 다시 시도</button>}
            </div>
          )}
        </section>
      </main>
      {(resultDraft || trinoRun) && materializeDialogOpen && (
        <div className="sql-materialize-dialog-backdrop" role="presentation" onMouseDown={() => setMaterializeDialogOpen(false)}>
          <section className="sql-materialize-dialog" role="dialog" aria-modal="true" aria-labelledby="sql-materialize-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="sql-materialize-dialog-header">
              <div>
                <span>처리 작업</span>
                <h2 id="sql-materialize-dialog-title">SQL 결과 처리 Job 생성</h2>
              </div>
              <button type="button" onClick={() => setMaterializeDialogOpen(false)} aria-label="저장 설정 닫기">닫기</button>
            </header>
            <div className="sql-materialize-form">
              <label>
                <span>데이터셋 이름</span>
                <input
                  onChange={(event) => {
                    setDerivedDatasetName(event.target.value);
                  }}
                  value={derivedDatasetName}
                />
              </label>
              <label className="wide">
                <span>설명</span>
                <textarea
                  onChange={(event) => {
                    setDerivedDatasetDescription(event.target.value);
                  }}
                  rows={2}
                  value={derivedDatasetDescription}
                />
              </label>
              <label className="wide">
                <span>태그</span>
                <input
                  onChange={(event) => {
                    setDerivedDatasetTags(event.target.value);
                  }}
                  placeholder="#sql-derived #analysis"
                  value={derivedDatasetTags}
                />
              </label>
              <label>
                <span>레이어</span>
                <select
                  onChange={(event) => {
                    setDerivedDatasetLayer(event.target.value as DerivedDatasetLayer);
                  }}
                  value={derivedDatasetLayer}
                >
                  <option value="SILVER">SILVER</option>
                  <option value="GOLD">GOLD</option>
                </select>
              </label>
              <label className="sql-materialize-checkbox">
                <input
                  checked={derivedDatasetRag}
                  onChange={(event) => {
                    setDerivedDatasetRag(event.target.checked);
                  }}
                  type="checkbox"
                />
                <span>RAG 사용 가능</span>
              </label>
              <button
                className="primary-button"
                disabled={trinoMaterializationPending || !hasQueryPermission || derivedDatasetName.trim().length === 0 || derivedDatasetTagList.length === 0}
                onClick={trinoRun ? () => void materializeTrinoRun() : prepareDerivedDatasetJob}
                title={hasQueryPermission ? trinoRun ? "Iceberg Dataset을 생성합니다." : "처리 Job 생성 검토로 이동합니다." : queryPermissionMessage}
                type="button"
              >
                <Database size={15} /> {trinoMaterializationPending ? "생성 요청 중" : trinoRun ? "Iceberg Dataset 생성" : "Job 생성 검토로 이동"}
              </button>
            </div>
            <div className="sql-materialize-summary">
              <span>실행 {(trinoRun ?? resultDraft)?.runId} · 태그 {derivedDatasetTagList.length}개 · 컬럼 {trinoRun?.result?.columns.length ?? resultDraft?.columns.length ?? 0}개</span>
            </div>
          </section>
        </div>
      )}
      {estimateDialogOpen && queryEstimate && (
        <div className="sql-materialize-dialog-backdrop" role="presentation" onMouseDown={() => setEstimateDialogOpen(false)}>
          <section className="sql-materialize-dialog sql-query-estimate-dialog" role="dialog" aria-modal="true" aria-labelledby="sql-query-estimate-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="sql-materialize-dialog-header">
              <div>
                <span>실행 확인</span>
                <h2 id="sql-query-estimate-title">대용량 쿼리를 실행할까요?</h2>
              </div>
              <button type="button" onClick={() => setEstimateDialogOpen(false)} aria-label="쿼리 실행 확인 닫기">닫기</button>
            </header>
            <div className="sql-materialize-summary">
              <span>예상 처리량 {formatEstimateBytes(queryEstimate.estimatedBytes)}</span>
              <span>{queryEstimate.estimatedDurationSeconds != null ? `예상 시간 약 ${formatDuration(queryEstimate.estimatedDurationSeconds * 1000)}` : "예상 시간을 계산할 수 없습니다."}</span>
              {queryEstimate.warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
            <div className="sql-result-actions">
              <button className="secondary-button" type="button" onClick={() => setEstimateDialogOpen(false)}>취소</button>
              <button className="primary-button" type="button" onClick={confirmEstimatedQueryRun}>실행</button>
            </div>
          </section>
        </div>
      )}
      {resultDraft && dashboardBaseDataset && dashboardDialogOpen && (
        <div className="sql-dashboard-builder-backdrop" role="presentation" onMouseDown={() => setDashboardDialogOpen(false)}>
          <section className="sql-dashboard-builder-dialog" role="dialog" aria-modal="true" aria-label="SQL 결과 대시보드 만들기" onMouseDown={(event) => event.stopPropagation()}>
            <button className="sql-dashboard-builder-close" type="button" onClick={() => setDashboardDialogOpen(false)}>
              닫기
            </button>
            <DashboardPage
              dataset={dashboardBaseDataset}
              datasets={selectedContextDatasets}
              entry={dashboardDialogEntry}
              sqlResult={resultDraft}
              onAction={onAction}
              onMissingSqlResult={() => setDashboardDialogOpen(false)}
            />
          </section>
        </div>
      )}
      <SchemaDetailsPanel
        dataset={schemaDataset}
        selectedDatasets={selectedContextDatasets}
        onColumnClick={insertColumnName}
        onJoinDataset={joinSelectedDataset}
        onSelectedDatasetRemove={removeSelectedDataset}
        onSchemaSelect={selectSchemaDataset}
      />
    </div>
  );
}
