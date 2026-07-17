import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  SqlPageIcon as PanelLeftOpen,
  SqlPageIcon as Table2,
} from "./SqlPageIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { apiConfig } from "../../services/apiClient";
import { executeQueryPreview, getQueryPreviewPage } from "../../services/mockApi";
import {
  cancelTrinoQueryRun,
  estimateSqlQueryRun,
  getTrinoQueryRun,
  getTrinoQueryRunResultPage,
  isTrinoQueryRun,
  submitSqlQueryRun,
  validateSqlQueryRun,
} from "../../services/pipelineApi";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, CreateTrinoSqlJobRequest, SqlResultDraft, TrinoQueryEstimate, TrinoQueryRun, TrinoQueryRunResultPage } from "../../types";
import styles from "./SqlAnalysisPage.module.css";
import { SqlDatasetContextPanel } from "./SqlDatasetContextPanel";
import { SqlExecutionInfo } from "./SqlExecutionInfo";
import {
  formatSqlJobWizardScheduleLabel,
  formatSqlJobWizardScheduleSummary,
  SqlJobWizardDialog,
  type SqlJobWizardCreateRequest,
} from "./SqlJobWizardDialog";
import {
  buildSqlChartSources,
  type SqlChartConfig,
} from "./SqlResultChart";
import { SqlQueryEditorPanel } from "./SqlQueryEditorPanel";
import { SqlResultsPanel, type SqlResultView } from "./SqlResultsPanel";
import {
  PREVIEW_ROW_LIMIT,
  buildAutocompleteCandidates,
  buildDefaultDerivedDatasetDescription,
  buildDefaultDerivedDatasetName,
  buildDefaultQuery,
  escapeCsvCell,
  getAutocompleteContext,
  getPreflightSummary,
  hasSqlResultDataShape,
  runSqlPreflight,
  type AutocompleteCandidate,
  type SqlPreflightResult,
} from "./sqlLogic";
import { useSqlContextPanel } from "./useSqlContextPanel";
import { useSqlQueryAi } from "./useSqlQueryAi";
import {
  buildTrinoDisplayResult,
  createTrinoResultLoadKey,
  isTrinoResultReady,
  useTrinoFullResult,
} from "./useTrinoFullResult";

function createClientRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `query-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function SqlAnalysisPage({
  cachedResult,
  createPending,
  dataset,
  datasets,
  onAction,
  onCreateDatasetJob,
  onCreateTrinoSqlJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  createPending: boolean;
  dataset: CatalogDataset | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCreateDatasetJob: (request: CreateDerivedDatasetRequest) => Promise<boolean>;
  onCreateTrinoSqlJob: (request: CreateTrinoSqlJobRequest) => Promise<boolean>;
  onResultChange: (result: SqlResultDraft | null) => void;
}) {
  const [baseDatasetId, setBaseDatasetId] = useState<string | null>(dataset?.id ?? null);
  const datasetById = useMemo(
    () => new Map(datasets.map((item) => [item.id, item])),
    [datasets],
  );
  const baseDataset = useMemo(
    () => baseDatasetId ? datasetById.get(baseDatasetId) ?? (dataset?.id === baseDatasetId ? dataset : null) : null,
    [baseDatasetId, dataset, datasetById],
  );
  const defaultQuery = useMemo(() => baseDataset ? buildDefaultQuery(baseDataset) : "", [baseDataset]);
  const usesTrinoRuntime = Boolean(baseDataset?.queryEngineRequired);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [previewRowLimit, setPreviewRowLimit] = useState(PREVIEW_ROW_LIMIT);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [trinoRun, setTrinoRun] = useState<TrinoQueryRun | null>(null);
  const [trinoSubmissionPending, setTrinoSubmissionPending] = useState(false);
  const [trinoSubmissionError, setTrinoSubmissionError] = useState<string | null>(null);
  const [trinoStatusPollError, setTrinoStatusPollError] = useState<string | null>(null);
  const [trinoStatusPollRetry, setTrinoStatusPollRetry] = useState(0);
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
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const [dialogResultDraft, setDialogResultDraft] = useState<SqlResultDraft | null>(null);
  const [resultPagePending, setResultPagePending] = useState(false);
  const [resultPageError, setResultPageError] = useState<string | null>(null);
  const [preflightResult, setPreflightResult] = useState<SqlPreflightResult | null>(null);
  const [chartConfig, setChartConfig] = useState<SqlChartConfig | null>(null);
  const [resultView, setResultView] = useState<SqlResultView>("table");
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  const [materializeDialogOpen, setMaterializeDialogOpen] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const initializedBaseDatasetIdRef = useRef<string | null | undefined>(undefined);
  const queryOperationGenerationRef = useRef(0);
  const queryClientRequestRef = useRef<{ generation: number; id: string; key: string } | null>(null);
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
            .map((id) => datasetById.get(id))
            .filter((item): item is CatalogDataset => Boolean(item)),
        ]
      : [],
    [baseDataset, datasetById, referenceDatasetIds],
  );
  const trinoDisplayResult = useMemo<SqlResultDraft | null>(() => {
    if (!trinoRun || !trinoResultPage || !baseDataset) return null;
    return buildTrinoDisplayResult({
      cursors: trinoResultCursors,
      dataset: baseDataset,
      firstPageDisplayMs: trinoFirstPageDisplayMs,
      firstPageRowCount: trinoFirstPageRowCount,
      page: trinoResultPage,
      pageIndex: trinoResultPageIndex,
      run: trinoRun,
    });
  }, [baseDataset, trinoFirstPageDisplayMs, trinoFirstPageRowCount, trinoResultCursors, trinoResultPage, trinoResultPageIndex, trinoRun]);
  const visibleResultCandidate = resultDraft ?? trinoDisplayResult;
  const visibleResult = hasSqlResultDataShape(visibleResultCandidate) ? visibleResultCandidate : null;
  const fullResult = useTrinoFullResult({
    baseDataset,
    generationRef: queryOperationGenerationRef,
    onAction,
    previewRun: trinoRun ?? visibleResult?.trinoRuntime?.run ?? null,
  });
  const fullTrinoDisplayResult = fullResult.displayResult;
  useEffect(() => {
    if (!fullResult.viewResult) return;
    setDialogResultDraft(fullResult.viewResult);
    setResultDialogOpen(true);
    fullResult.clearIntent();
  }, [fullResult.clearIntent, fullResult.viewResult]);
  const chartSources = useMemo(
    () => visibleResult ? buildSqlChartSources(visibleResult, selectedContextDatasets) : [],
    [selectedContextDatasets, visibleResult],
  );
  const activeChartSource = useMemo(
    () => chartConfig ? chartSources.find((source) => source.id === chartConfig.sourceId) : undefined,
    [chartConfig, chartSources],
  );
  const selectedDatasetIdSet = useMemo(
    () => new Set(selectedContextDatasets.map((item) => item.id)),
    [selectedContextDatasets],
  );
  const contextPanel = useSqlContextPanel({
    baseDatasetId: baseDataset?.id ?? null,
    datasets,
    onAction,
    selectedDatasetCount: selectedContextDatasets.length,
    selectedDatasetIds: selectedDatasetIdSet,
  });
  const canRunPreview = Boolean(
    baseDataset
      && preflightResult?.canExecute === true
      && preflightResult.key === queryValidationKey
      && (!usesTrinoRuntime || apiConfig.useMock || trinoValidationKey === queryValidationKey),
  );
  const activeQueryEstimate = queryEstimateKey === queryValidationKey ? queryEstimate : null;
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
      datasets: contextPanel.candidateDatasets,
      referenceDatasetIdSet,
    });
  }, [autocompleteContext, baseDataset, contextPanel.candidateDatasets, dismissedAutocompleteKey, referenceDatasetIdSet]);
  const cachedResultBaseDatasetId = hasSqlResultDataShape(cachedResult)
    ? cachedResult.baseDatasetId ?? cachedResult.datasetId
    : null;
  const canRestoreCachedResult = Boolean(
    hasSqlResultDataShape(cachedResult)
      && baseDataset
      && cachedResultBaseDatasetId === baseDataset.id,
  );

  const clearTrinoState = () => {
    queryOperationGenerationRef.current += 1;
    setTrinoRun(null);
    setTrinoSubmissionPending(false);
    setTrinoSubmissionError(null);
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
    setQueryEstimatePending(false);
    setTrinoValidationKey(null);
    setTrinoValidationError(null);
    setTrinoValidationPending(false);
    setEstimateDialogOpen(false);
    queryClientRequestRef.current = null;
    trinoResultLoadKeyRef.current = "";
    fullResult.reset();
  };

  useEffect(() => {
    queryOperationGenerationRef.current += 1;
    queryClientRequestRef.current = null;
    trinoResultLoadKeyRef.current = "";
    if (!dataset) {
      setBaseDatasetId(null);
      setReferenceDatasetIds([]);
      contextPanel.setExpandedDatasetId(null);
      return;
    }

    setBaseDatasetId(dataset.id);
    setReferenceDatasetIds([]);
    contextPanel.setExpandedDatasetId(null);
  }, [dataset?.id]);

  // 데이터셋이 실제로 바뀔 때만 기본 쿼리를 초기화한다. 결과 상태나 사용자가
  // 입력한 SQL이 바뀌었다는 이유로 빈 편집 내용을 다시 덮어쓰면 안 된다.
  useEffect(() => {
    const nextBaseDatasetId = baseDataset?.id ?? null;
    if (initializedBaseDatasetIdRef.current === nextBaseDatasetId) return;
    initializedBaseDatasetIdRef.current = nextBaseDatasetId;

    if (!baseDataset) {
      setQuery("");
      setCursorIndex(0);
      setResultDraft(null);
      clearTrinoState();
      setPreflightResult(null);
      setMaterializeDialogOpen(false);
      setChartConfig(null);
      setResultView("table");
      setResultDialogOpen(false);
      setDialogResultDraft(null);
      setResultPageError(null);
      setReferenceDatasetIds([]);
      onResultChange(null);
      return;
    }

    if (canRestoreCachedResult) return;

    setQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    setResultDraft(null);
    clearTrinoState();
    setPreflightResult(null);
    setMaterializeDialogOpen(false);
    setChartConfig(null);
    setResultView("execution");
    setResultDialogOpen(false);
    setDialogResultDraft(null);
    setResultPageError(null);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset?.id]);

  useEffect(() => {
    if (!baseDataset || !cachedResult || !canRestoreCachedResult) return;
    if (resultDraft?.runId === cachedResult.runId || trinoRun?.runId === cachedResult.runId) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);
    const cachedTrinoRuntime = cachedResult.trinoRuntime;

    setQuery(cachedResult.query);
    setPreviewRowLimit(cachedResult.previewLimit ?? PREVIEW_ROW_LIMIT);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    clearTrinoState();
    if (cachedResult.engine === "trino" && cachedTrinoRuntime && !apiConfig.useMock) {
      setResultDraft(null);
      setTrinoRun(cachedTrinoRuntime.run);
      setTrinoResultPage(cachedTrinoRuntime.page);
      setTrinoResultCursors([...cachedTrinoRuntime.cursors]);
      setTrinoResultPageIndex(cachedTrinoRuntime.pageIndex);
      setTrinoFirstPageDisplayMs(cachedTrinoRuntime.firstPageDisplayMs);
      setTrinoFirstPageRowCount(cachedTrinoRuntime.firstPageRowCount);
      trinoResultLoadKeyRef.current = createTrinoResultLoadKey(
        cachedTrinoRuntime.run,
        cachedTrinoRuntime.pageIndex,
        cachedTrinoRuntime.cursors[cachedTrinoRuntime.pageIndex] ?? null,
      );
    } else {
      setResultDraft(cachedResult);
    }
    setMaterializeDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setDialogResultDraft(null);
    setResultPageError(null);
  }, [baseDataset, cachedResult, canRestoreCachedResult, resultDraft?.runId, trinoRun?.runId]);

  useEffect(() => {
    if (trinoDisplayResult) onResultChange(trinoDisplayResult);
  }, [onResultChange, trinoDisplayResult]);

  const queryContextPath = (mode: "preflight" | "preview" = "preview") => {
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
    if (!baseDataset) {
      setPreflightResult(null);
      return;
    }
    const referenceDatasets = datasets.filter((item) => referenceDatasetIdSet.has(item.id));
    setPreflightResult(runSqlPreflight(query, baseDataset, referenceDatasets, queryValidationKey, previewRowLimit));
  }, [baseDataset, datasets, previewRowLimit, query, queryValidationKey, referenceDatasetIdSet]);

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
    if (!trinoRun) return;
    const shouldPoll = ["queued", "running"].includes(trinoRun.status)
      || trinoRun.result?.storageStatus === "collecting";
    if (!shouldPoll) return;

    let disposed = false;
    const generation = queryOperationGenerationRef.current;
    const runId = trinoRun.runId;
    const timeoutId = window.setTimeout(() => {
      void getTrinoQueryRun(runId)
        .then((nextRun) => {
          if (disposed || queryOperationGenerationRef.current !== generation || nextRun.runId !== runId) return;
          setTrinoStatusPollError(null);
          setTrinoStatusPollRetry(0);
          setTrinoRun(nextRun);
        })
        .catch((error) => {
          if (disposed || queryOperationGenerationRef.current !== generation) return;
          setTrinoStatusPollError(error instanceof Error ? error.message : "Trino 실행 상태를 확인하지 못했습니다.");
          setTrinoStatusPollRetry((attempt) => attempt + 1);
        });
    }, Math.min(5_000, 600 * (trinoStatusPollRetry + 1)));

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [trinoRun, trinoStatusPollRetry]);

  useEffect(() => {
    const availablePageCount = trinoRun?.result?.availablePageCount ?? 0;
    const storageStatus = trinoRun?.result?.storageStatus;
    if (
      !trinoRun
      || availablePageCount < 1
      || !["collecting", "available"].includes(storageStatus ?? "")
      || trinoResultPagePending
      || (trinoResultPage
        && trinoResultPage.nextCursor
        && !(storageStatus === "available" && trinoResultPage.totalRows == null))
    ) return;

    const cursor = trinoResultCursors[trinoResultPageIndex] ?? null;
    const loadKey = createTrinoResultLoadKey(trinoRun, trinoResultPageIndex, cursor);
    if (trinoResultLoadKeyRef.current === loadKey) return;
    trinoResultLoadKeyRef.current = loadKey;
    const generation = queryOperationGenerationRef.current;
    const initialDisplay = trinoResultPageIndex === 0 && !trinoResultPage;
    const startedAt = performance.now();
    setTrinoResultPagePending(true);
    void getTrinoQueryRunResultPage(trinoRun.runId, cursor)
      .then((page) => {
        if (queryOperationGenerationRef.current !== generation || trinoResultLoadKeyRef.current !== loadKey) return;
        setTrinoResultPage(page);
        if (initialDisplay) setTrinoFirstPageRowCount((current) => current ?? page.rows.length);
        setTrinoResultError(null);
        setTrinoResultRetryCursor(undefined);
        if (initialDisplay) window.requestAnimationFrame(() => {
          if (trinoResultLoadKeyRef.current === loadKey) {
            setTrinoFirstPageDisplayMs((current) => current ?? Math.max(0, Math.round(performance.now() - startedAt)));
          }
        });
      })
      .catch((error) => {
        if (queryOperationGenerationRef.current !== generation || trinoResultLoadKeyRef.current !== loadKey) return;
        setTrinoResultError(error instanceof Error ? error.message : "실행 결과를 불러오지 못했습니다.");
        setTrinoResultRetryCursor(cursor);
        setTrinoResultRetryTargetIndex(trinoResultPageIndex);
      })
      .finally(() => {
        if (queryOperationGenerationRef.current === generation && trinoResultLoadKeyRef.current === loadKey) {
          setTrinoResultPagePending(false);
        }
      });
  }, [trinoResultCursors, trinoResultPage, trinoResultPageIndex, trinoResultPagePending, trinoRun]);

  const resetResultState = () => {
    setResultDraft(null);
    clearTrinoState();
    setPreflightResult(null);
    setChartConfig(null);
    setResultView(usesTrinoRuntime ? "execution" : "table");
    setResultDialogOpen(false);
    setDialogResultDraft(null);
    setResultPagePending(false);
    setResultPageError(null);
    setMaterializeDialogOpen(false);
    onResultChange(null);
  };

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setPreflightResult(null);
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
    const reusableRequest = queryClientRequestRef.current?.key === queryValidationKey
      ? queryClientRequestRef.current
      : null;
    const confirmationContinuation = Boolean(clientRequestId && reusableRequest?.id === clientRequestId);
    const generation = confirmationContinuation && reusableRequest
      ? reusableRequest.generation
      : queryOperationGenerationRef.current + 1;
    if (!confirmationContinuation) queryOperationGenerationRef.current = generation;
    const requestId = clientRequestId ?? reusableRequest?.id ?? createClientRequestId();
    queryClientRequestRef.current = { generation, id: requestId, key: queryValidationKey };
    const isCurrentGeneration = () => queryOperationGenerationRef.current === generation;
    const isCurrentRequest = () => {
      const currentRequest = queryClientRequestRef.current;
      return Boolean(
        isCurrentGeneration()
        && currentRequest?.generation === generation
        && currentRequest.id === requestId
        && currentRequest.key === queryValidationKey,
      );
    };
    setTrinoSubmissionError(null);
    setQueryPending(true);
    if (usesTrinoRuntime && !apiConfig.useMock) {
      if (!confirmationContinuation) {
        setResultDraft(null);
        setDialogResultDraft(null);
        setChartConfig(null);
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
        setMaterializeDialogOpen(false);
        trinoResultLoadKeyRef.current = "";
        fullResult.reset();
        onResultChange(null);
      }
      setResultView("execution");
      setResultDialogOpen(false);
      setTrinoSubmissionPending(true);
    }

    try {
      if (usesTrinoRuntime && !apiConfig.useMock) {
        if (!confirmationToken) {
          const estimate = activeQueryEstimate ?? await estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort());
          if (!isCurrentRequest()) return;
          setQueryEstimate(estimate);
          setQueryEstimateError(null);
          setQueryEstimateKey(queryValidationKey);
          if (estimate.confirmationRequired) {
            setEstimateDialogOpen(true);
            return;
          }
        }

        const response = await submitSqlQueryRun(
          baseDataset,
          query,
          [...referenceDatasetIds].sort(),
          confirmationToken,
          requestId,
        );
        if (!isCurrentRequest()) return;
        queryClientRequestRef.current = null;

        if (isTrinoQueryRun(response)) {
          setResultDraft(null);
          setDialogResultDraft(null);
          setChartConfig(null);
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
          onAction("analysis.query.run_submitted", queryContextPath("preview"), baseDataset.id);
          return;
        }

        if (!hasSqlResultDataShape(response)) {
          throw new Error("SQL 실행 응답에 결과 컬럼 또는 행 정보가 없습니다.");
        }

        setResultDraft(response);
        setResultView("table");
        onResultChange(response);
        onAction("analysis.query.compatibility_executed", queryContextPath("preview"), baseDataset.id);
        return;
      }

      const resultDraft = await buildPreviewDraft();
      if (!isCurrentRequest()) return;
      queryClientRequestRef.current = null;
      setResultDraft(resultDraft);
      setDialogResultDraft(null);
      setResultPageError(null);
      setChartConfig(null);
      setResultView("table");
      onResultChange(resultDraft);
      onAction("analysis.query.preview_executed", queryContextPath("preview"), baseDataset.id);
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (usesTrinoRuntime && !apiConfig.useMock && error instanceof ApiError && error.code === "QUERY_CONFIRMATION_REQUIRED") {
        try {
          const estimate = await estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort());
          if (!isCurrentRequest()) return;
          setQueryEstimate(estimate);
          setQueryEstimateError(null);
          setQueryEstimateKey(queryValidationKey);
          setEstimateDialogOpen(estimate.confirmationRequired);
          return;
        } catch {
          // The original submission error is more actionable than a follow-up estimate failure.
        }
      }
      if (!isCurrentRequest()) return;
      queryClientRequestRef.current = null;
      const message = error instanceof Error ? error.message : "실행에 실패했습니다. 쿼리 또는 데이터셋 상태를 확인해 주세요.";
      setTrinoSubmissionError(usesTrinoRuntime ? message : null);
      setPreflightResult({
        key: queryValidationKey,
        canExecute: false,
        messages: [{ tone: "error", text: message }],
      });
      onAction("analysis.query.preview_failed", queryContextPath("preview"), baseDataset.id, "failed");
    } finally {
      if (isCurrentGeneration()) {
        setTrinoSubmissionPending(false);
        setQueryPending(false);
      }
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

  const preflightSummary = getPreflightSummary(preflightResult);
  const visiblePreflightSummary = preflightSummary?.tone === "success" ? null : preflightSummary;

  const applyAiQuery = (nextQuery: string) => {
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
      syncLineNumberScroll();
    });
  };
  const queryAi = useSqlQueryAi({
    baseDataset,
    onAction,
    onApplyQuery: applyAiQuery,
    preflightResult,
    query,
    selectedDatasets: selectedContextDatasets,
  });

  const resetQuery = () => {
    updateQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    onAction("analysis.query.reset", "/api/query/reset", baseDataset?.id ?? "sql-empty");
  };

  const changeResultDialogOpen = (open: boolean) => {
    setResultDialogOpen(open);
    setResultPageError(null);
    if (open && (fullTrinoDisplayResult ?? visibleResult)) setDialogResultDraft(fullTrinoDisplayResult ?? visibleResult);
  };

  const loadResultPage = async (offset: number) => {
    if (!resultDraft || resultPagePending) return;
    const generation = queryOperationGenerationRef.current;
    const runId = resultDraft.runId;
    const limit = resultDraft.pageLimit ?? resultDraft.previewLimit ?? PREVIEW_ROW_LIMIT;
    setResultPagePending(true);
    setResultPageError(null);
    try {
      const page = await getQueryPreviewPage(runId, { limit, offset });
      if (queryOperationGenerationRef.current !== generation || page.runId !== runId) return;
      setDialogResultDraft(page);
      onAction(
        "analysis.query.preview_page_loaded",
        `/api/query/runs/${encodeURIComponent(resultDraft.runId)}?offset=${offset}&limit=${limit}`,
        resultDraft.datasetId,
      );
    } catch (error) {
      if (queryOperationGenerationRef.current !== generation) return;
      const message = error instanceof Error ? error.message : "SQL Preview 페이지를 불러오지 못했습니다.";
      setResultPageError(message);
      onAction(
        "analysis.query.preview_page_failed",
        `/api/query/runs/${encodeURIComponent(resultDraft.runId)}?offset=${offset}&limit=${limit}`,
        resultDraft.datasetId,
        "failed",
      );
    } finally {
      if (queryOperationGenerationRef.current === generation) setResultPagePending(false);
    }
  };

  const loadNextTrinoResultPage = async () => {
    if (!trinoRun || !trinoResultPage?.nextCursor || trinoResultPagePending) return;
    const generation = queryOperationGenerationRef.current;
    const runId = trinoRun.runId;
    const nextCursor = trinoResultPage.nextCursor;
    const targetIndex = trinoResultPageIndex + 1;
    setTrinoResultPagePending(true);
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(runId, nextCursor);
      if (queryOperationGenerationRef.current !== generation || page.runId !== runId) return;
      setTrinoResultCursors((cursors) => [...cursors.slice(0, targetIndex), nextCursor]);
      setTrinoResultPage(page);
      setTrinoResultPageIndex(targetIndex);
      setTrinoResultRetryCursor(undefined);
      trinoResultLoadKeyRef.current = createTrinoResultLoadKey(trinoRun, targetIndex, nextCursor);
    } catch (error) {
      if (queryOperationGenerationRef.current !== generation) return;
      setTrinoResultError(error instanceof Error ? error.message : "다음 결과 페이지를 불러오지 못했습니다.");
      setTrinoResultRetryCursor(nextCursor);
      setTrinoResultRetryTargetIndex(targetIndex);
    } finally {
      if (queryOperationGenerationRef.current === generation) setTrinoResultPagePending(false);
    }
  };

  const loadPreviousTrinoResultPage = async () => {
    if (!trinoRun || trinoResultPageIndex < 1 || trinoResultPagePending) return;
    const generation = queryOperationGenerationRef.current;
    const runId = trinoRun.runId;
    const targetIndex = trinoResultPageIndex - 1;
    const cursor = trinoResultCursors[targetIndex] ?? null;
    setTrinoResultPagePending(true);
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(runId, cursor);
      if (queryOperationGenerationRef.current !== generation || page.runId !== runId) return;
      setTrinoResultPage(page);
      setTrinoResultPageIndex(targetIndex);
      setTrinoResultRetryCursor(undefined);
      trinoResultLoadKeyRef.current = createTrinoResultLoadKey(trinoRun, targetIndex, cursor);
    } catch (error) {
      if (queryOperationGenerationRef.current !== generation) return;
      setTrinoResultError(error instanceof Error ? error.message : "이전 결과 페이지를 불러오지 못했습니다.");
      setTrinoResultRetryCursor(cursor);
      setTrinoResultRetryTargetIndex(targetIndex);
    } finally {
      if (queryOperationGenerationRef.current === generation) setTrinoResultPagePending(false);
    }
  };

  const retryTrinoResultPage = async () => {
    if (!trinoRun || trinoResultRetryCursor === undefined || trinoResultPagePending) return;
    const generation = queryOperationGenerationRef.current;
    const runId = trinoRun.runId;
    const retryCursor = trinoResultRetryCursor;
    const retryTargetIndex = trinoResultRetryTargetIndex;
    setTrinoResultPagePending(true);
    setTrinoResultError(null);
    try {
      const page = await getTrinoQueryRunResultPage(runId, retryCursor);
      if (queryOperationGenerationRef.current !== generation || page.runId !== runId) return;
      setTrinoResultCursors((cursors) => {
        const next = [...cursors];
        next[retryTargetIndex] = retryCursor;
        return next.slice(0, retryTargetIndex + 1);
      });
      setTrinoResultPage(page);
      setTrinoResultPageIndex(retryTargetIndex);
      setTrinoResultRetryCursor(undefined);
      if (retryTargetIndex === 0 && trinoFirstPageDisplayMs == null) {
        setTrinoFirstPageRowCount(page.rows.length);
        setTrinoFirstPageDisplayMs(0);
      }
      trinoResultLoadKeyRef.current = createTrinoResultLoadKey(trinoRun, retryTargetIndex, retryCursor);
    } catch (error) {
      if (queryOperationGenerationRef.current !== generation) return;
      setTrinoResultError(error instanceof Error ? error.message : "실행 결과를 다시 불러오지 못했습니다.");
    } finally {
      if (queryOperationGenerationRef.current === generation) setTrinoResultPagePending(false);
    }
  };

  const cancelActiveTrinoRun = async () => {
    if (!trinoRun || !["queued", "running"].includes(trinoRun.status)) return;
    const generation = queryOperationGenerationRef.current;
    const runId = trinoRun.runId;
    setQueryPending(true);
    try {
      const cancelledRun = await cancelTrinoQueryRun(runId);
      if (queryOperationGenerationRef.current !== generation || cancelledRun.runId !== runId) return;
      setTrinoRun(cancelledRun);
      setTrinoStatusPollError(null);
      onAction("analysis.query.run_cancelled", `/api/query/runs/${runId}/cancel`, trinoRun.baseDatasetId);
    } catch (error) {
      if (queryOperationGenerationRef.current !== generation) return;
      setTrinoSubmissionError(error instanceof Error ? error.message : "실행을 취소하지 못했습니다.");
    } finally {
      if (queryOperationGenerationRef.current === generation) setQueryPending(false);
    }
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
      removeSelectedDataset(targetDataset);
      return;
    }
    if (!baseDataset) {
      setBaseDatasetId(targetDataset.id);
      setReferenceDatasetIds([]);
      contextPanel.setExpandedDatasetId(null);
      resetResultState();
      onAction(
        "analysis.context.dataset_selected",
        `/api/query/context/datasets/${targetDataset.id}/select`,
        targetDataset.id,
      );
      return;
    }
    setReferenceDatasetIds((ids) => (ids.includes(targetDataset.id) ? ids : [...ids, targetDataset.id]));
    contextPanel.setExpandedDatasetId(null);
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

    if (targetDataset.id === baseDataset?.id) setBaseDatasetId(nextBaseDatasetId);

    setReferenceDatasetIds(nextReferenceDatasetIds);
    if (nextSelectedIds.length === 0) {
      setQuery("");
      setCursorIndex(0);
      setPreflightResult(null);
    }
    resetResultState();
    onAction(
      "analysis.context.dataset_removed",
      `/api/query/context/datasets/${targetDataset.id}/remove`,
      targetDataset.id,
    );
  };

  const downloadCsv = () => {
    const activeTrinoRun = trinoRun ?? visibleResult?.trinoRuntime?.run;
    if (visibleResult?.engine === "trino") {
      if (!isTrinoResultReady(activeTrinoRun)) return;
      fullResult.downloadCsv();
      return;
    }
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

  const createDerivedDatasetJob = async ({ configuration, context }: SqlJobWizardCreateRequest) => {
    if (materializationResult?.engine === "trino" && materializationResult.runId === context.sourceRunId) {
      const request: CreateTrinoSqlJobRequest = {
        baseDatasetId: context.baseDatasetId,
        dataset: {
          description: configuration.dataset.description.trim(),
          layer: configuration.dataset.layer,
          name: configuration.dataset.name.trim(),
          rag: false,
          refreshPolicy: "manual",
          tags: configuration.target.tags,
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
          partitionColumn: configuration.target.partitionColumns[0] || undefined,
          writeMode: "full_refresh",
        },
      };
      const created = await onCreateTrinoSqlJob(request);
      if (created) setMaterializeDialogOpen(false);
      return created;
    }

    const request: CreateDerivedDatasetRequest = {
      dataset: {
        description: configuration.dataset.description.trim(),
        layer: configuration.dataset.layer,
        name: configuration.dataset.name.trim(),
        rag: false,
        refreshPolicy: "manual",
        tags: configuration.target.tags,
      },
      job: {
        accessScope: configuration.governance.accessScope,
        compression: configuration.target.compression,
        databaseName: configuration.target.databaseName.trim(),
        fileFormat: configuration.target.fileFormat,
        owner: configuration.governance.owner.trim(),
        overlapPolicy: configuration.schedule.overlapPolicy,
        partitionColumn: configuration.target.partitionColumns[0] || undefined,
        partitionColumns: configuration.target.partitionColumns,
        permissionSummary: configuration.governance.permissionSummary.trim(),
        scheduleLabel: formatSqlJobWizardScheduleLabel(configuration.schedule),
        scheduleMode: configuration.schedule.mode === "manual" ? "manual" : "repeat",
        scheduleSummary: formatSqlJobWizardScheduleSummary(configuration.schedule),
        storagePath: configuration.target.storagePath.trim(),
        tags: configuration.target.tags,
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
    if (created) setMaterializeDialogOpen(false);
    return created;
  };

  const applyChartConfig = (nextConfig: SqlChartConfig) => {
    if (!visibleResult) return;
    setChartConfig(nextConfig);
    setResultView("chart");
    onAction("analysis.chart.configured", `/api/query/runs/${visibleResult.runId}/visualization`, visibleResult.datasetId);
  };

  const actionTrinoRun = trinoRun ?? visibleResult?.trinoRuntime?.run;
  const trinoPreviewReady = visibleResult?.engine !== "trino" || (
    isTrinoResultReady(actionTrinoRun) && actionTrinoRun.mode === "preview"
  );
  const fullResultPreparing = fullResult.preparing;
  const materializationResult = visibleResult?.engine === "trino"
    ? trinoPreviewReady ? visibleResult : null
    : resultDraft;
  const executionWorkspaceEnabled = Boolean(baseDataset || trinoRun || trinoSubmissionPending || trinoSubmissionError);
  const remoteResultPagination = trinoRun && trinoResultPage ? {
    currentPage: trinoResultPage.pageNumber ?? trinoResultPageIndex + 1,
    nextDisabled: !trinoResultPage.nextCursor,
    onNext: () => void loadNextTrinoResultPage(),
    onPrevious: () => void loadPreviousTrinoResultPage(),
    pending: trinoResultPagePending,
    previousDisabled: trinoResultPageIndex < 1,
    rangeLabel: trinoResultPage.totalRows == null
      ? `${trinoResultPage.rowStart.toLocaleString()}–${trinoResultPage.rowEnd.toLocaleString()}행 · 전체 수집 중`
      : `${trinoResultPage.rowStart.toLocaleString()}–${trinoResultPage.rowEnd.toLocaleString()} / ${Math.max(trinoResultPage.totalRows, trinoResultPage.rowEnd).toLocaleString()}행`,
    totalPages: trinoResultPage.totalPages,
  } : undefined;
  return (
    <div className={cn(styles.page, contextPanel.collapsed && styles.collapsed)}>
      <PageHeader
        className={styles.pageHeader}
        icon={<Table2 size={18} />}
        leadingAlign="center"
        title="SQL 분석"
      />
      {!contextPanel.collapsed && (
        <SqlDatasetContextPanel
          chartConfig={chartConfig}
          chartSources={chartSources}
          contextListRef={contextPanel.listRef}
          contextPageSize={contextPanel.pageSize}
          contextPaginationRef={contextPanel.paginationRef}
          contextPanelRef={contextPanel.panelRef}
          currentPage={contextPanel.currentPage}
          datasetSearch={contextPanel.datasetSearch}
          expandedDatasetId={contextPanel.expandedDatasetId}
          filteredDatasetCount={contextPanel.filteredDatasetCount}
          onApplyChartConfig={applyChartConfig}
          onCollapse={contextPanel.toggleCollapsed}
          onDatasetSearchChange={contextPanel.setDatasetSearch}
          onNextPage={contextPanel.nextPage}
          onPreviousPage={contextPanel.previousPage}
          onSelectDataset={addSelectedDataset}
          onTabChange={contextPanel.setTab}
          onToggleDataset={contextPanel.toggleDatasetPreview}
          pageDatasets={contextPanel.pageDatasets}
          rangeLabel={contextPanel.rangeLabel}
          selectedDatasetIds={selectedDatasetIdSet}
          tab={contextPanel.tab}
          totalPages={contextPanel.totalPages}
        />
      )}

      <main className={cn(styles.workspace, "grid min-w-0 content-start gap-3")}>
        {contextPanel.collapsed && (
          <Button className={styles.contextRailButton} type="button" onClick={contextPanel.toggleCollapsed} aria-label="분석 테이블 열기" title="분석 테이블 열기" size="icon" variant="outline">
            <PanelLeftOpen data-icon="inline-start" />
          </Button>
        )}
        <SqlQueryEditorPanel
          ai={{
            error: queryAi.error,
            onApply: queryAi.apply,
            onGenerate: queryAi.generate,
            onOpenChange: queryAi.changeOpen,
            onPromptChange: queryAi.changePrompt,
            open: queryAi.open,
            pending: queryAi.pending,
            prompt: queryAi.prompt,
            promptRef: queryAi.promptRef,
            suggestion: queryAi.suggestion,
          }}
          autocompleteCandidates={autocompleteCandidates}
          autocompleteIndex={autocompleteIndex}
          canExecute={canRunPreview}
          disabled={!baseDataset}
          lineNumberRef={lineNumberRef}
          lineNumbers={lineNumbers}
          onAutocompleteSelect={applyAutocompleteCandidate}
          onEditorBlur={() => setDismissedAutocompleteKey(autocompleteContext.key)}
          onEditorCursorChange={updateCursorFromTextarea}
          onEditorKeyDown={handleQueryKeyDown}
          onExecute={() => void executePreview()}
          onQueryChange={(nextQuery, nextCursorIndex) => {
            updateQuery(nextQuery);
            setCursorIndex(nextCursorIndex);
            setDismissedAutocompleteKey(null);
          }}
          onReset={resetQuery}
          onScroll={syncLineNumberScroll}
          pending={queryPending}
          preflightSummary={visiblePreflightSummary}
          query={query}
          textareaRef={textareaRef}
        />

        <SqlResultsPanel
          activeChartSource={activeChartSource}
          baseDatasetSelected={Boolean(baseDataset)}
          chartConfig={chartConfig}
          dialogPageError={visibleResult?.engine === "trino" ? fullResult.pageError ?? fullResult.error : resultPageError}
          dialogPagePending={visibleResult?.engine === "trino" ? fullResult.pagePending : resultPagePending}
          dialogRemotePagination={fullResult.pagination}
          dialogResultDraft={fullTrinoDisplayResult ?? (trinoRun ? visibleResult : dialogResultDraft)}
          dialogOpen={resultDialogOpen}
          downloadDisabled={!trinoPreviewReady || fullResultPreparing}
          downloadPending={fullResult.intent === "csv"}
          executionWorkspaceEnabled={executionWorkspaceEnabled}
          executionInfo={
            <SqlExecutionInfo
              cancelPending={queryPending}
              estimate={activeQueryEstimate}
              estimateError={queryEstimateError}
              estimatePending={queryEstimatePending}
              firstPageDisplayMs={trinoFirstPageDisplayMs}
              firstPageRowCount={trinoFirstPageRowCount}
              onCancel={() => void cancelActiveTrinoRun()}
              onRetryResult={trinoResultRetryCursor === undefined ? undefined : () => void retryTrinoResultPage()}
              queryEngineStatus={baseDataset?.queryEngineStatus}
              resultPageError={trinoResultError}
              run={trinoRun}
              statusPollError={trinoStatusPollError}
              submissionError={trinoSubmissionError}
              submissionPending={trinoSubmissionPending}
              validationError={trinoValidationError}
              validationPending={trinoValidationPending}
            />
          }
          fullViewDisabled={!trinoPreviewReady || (fullResultPreparing && !fullTrinoDisplayResult)}
          fullViewPending={fullResult.intent === "view"}
          jobCreationDisabled={!trinoPreviewReady || !materializationResult}
          pageError={trinoRun ? trinoResultError ?? fullResult.error : resultPageError}
          pagePending={trinoRun ? trinoResultPagePending : resultPagePending}
          onDialogOpenChange={changeResultDialogOpen}
          onDialogPageRetry={fullResult.canRetryPage ? fullResult.retryPage : undefined}
          onDownloadCsv={downloadCsv}
          onOpenFullView={() => {
            if (visibleResult?.engine !== "trino") {
              changeResultDialogOpen(true);
              return;
            }
            fullResult.openView();
          }}
          onOpenJobWizard={() => {
            if (!materializationResult || (materializationResult.engine === "trino" && !trinoPreviewReady)) return;
            setMaterializeDialogOpen(true);
          }}
          onPageChange={loadResultPage}
          onPageRetry={trinoResultRetryCursor === undefined ? undefined : () => void retryTrinoResultPage()}
          onResultViewChange={(view) => {
            setResultView(view);
            if (view === "execution") setResultDialogOpen(false);
          }}
          remotePagination={remoteResultPagination}
          resultDraft={visibleResult}
          resultView={resultView}
        />
      </main>
      {estimateDialogOpen && activeQueryEstimate && (
        <Dialog onOpenChange={setEstimateDialogOpen} open={estimateDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>대용량 Trino 쿼리를 실행할까요?</DialogTitle>
              <DialogDescription>
                예상 스캔량과 실행 위험도를 확인한 뒤 계속해 주세요. SQL 입력 내용은 변경되지 않습니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <strong>위험도 {activeQueryEstimate.riskLevel === "high" ? "높음" : activeQueryEstimate.riskLevel === "medium" ? "보통" : "낮음"}</strong>
              <span>확인 후 동일 요청 ID로 한 번만 제출합니다.</span>
              {activeQueryEstimate.warnings.map((warning) => <span key={warning}>• {warning}</span>)}
            </div>
            <DialogFooter>
              <Button onClick={() => setEstimateDialogOpen(false)} type="button" variant="outline">취소</Button>
              <Button onClick={confirmEstimatedQueryRun} type="button" variant="primary">확인 후 실행</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {materializationResult && baseDataset && materializeDialogOpen && (
        <SqlJobWizardDialog
          baseDataset={baseDataset}
          defaultMetadata={{
            description: buildDefaultDerivedDatasetDescription(baseDataset),
            name: buildDefaultDerivedDatasetName(baseDataset),
          }}
          onClose={() => setMaterializeDialogOpen(false)}
          onCreate={createDerivedDatasetJob}
          open={materializeDialogOpen}
          pending={createPending}
          resultDraft={materializationResult}
          runtime={materializationResult.engine === "trino" ? "trino" : "compatibility"}
        />
      )}
    </div>
  );
}
