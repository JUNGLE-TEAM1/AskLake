import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { apiConfig } from "../../services/apiClient";
import { getTrinoQueryRun, getTrinoQueryRunResultPage, requestTrinoFullResults } from "../../services/sqlQueryApi";
import type { AuditResult, CatalogDataset, SqlResultDraft, TrinoQueryRun, TrinoQueryRunResultPage } from "../../types";
import type { SqlRemoteResultPagination } from "./SqlResultsPanel";

type FullResultIntent = "chart" | "csv" | "view" | null;

type FullResultState = {
  cursors: Array<string | null>;
  error: string | null;
  intent: FullResultIntent;
  page: TrinoQueryRunResultPage | null;
  pageError: string | null;
  pageIndex: number;
  pagePending: boolean;
  pollRetry: number;
  requestPending: boolean;
  retryCursor: string | null | undefined;
  retryTargetIndex: number;
  run: TrinoQueryRun | null;
};

type FullResultAction =
  | { type: "patch"; value: Partial<FullResultState> }
  | { type: "reset" };

const INITIAL_FULL_RESULT_STATE: FullResultState = {
  cursors: [null],
  error: null,
  intent: null,
  page: null,
  pageError: null,
  pageIndex: 0,
  pagePending: false,
  pollRetry: 0,
  requestPending: false,
  retryCursor: undefined,
  retryTargetIndex: 0,
  run: null,
};

function fullResultReducer(state: FullResultState, action: FullResultAction): FullResultState {
  return action.type === "reset" ? INITIAL_FULL_RESULT_STATE : { ...state, ...action.value };
}

export function createTrinoResultLoadKey(run: TrinoQueryRun, pageIndex: number, cursor: string | null) {
  return [
    run.runId,
    pageIndex,
    run.result?.availablePageCount ?? 0,
    run.result?.storageStatus ?? "unknown",
    cursor ?? "first",
  ].join(":");
}

export function isTrinoResultReady(run: TrinoQueryRun | null | undefined): run is TrinoQueryRun {
  return run?.status === "succeeded" && run.result?.storageStatus === "available";
}

export function buildTrinoDisplayResult({
  cursors,
  dataset,
  firstPageDisplayMs,
  firstPageRowCount,
  page,
  pageIndex,
  run,
}: {
  cursors: Array<string | null>;
  dataset: CatalogDataset;
  firstPageDisplayMs: number | null;
  firstPageRowCount: number | null;
  page: TrinoQueryRunResultPage;
  pageIndex: number;
  run: TrinoQueryRun;
}): SqlResultDraft {
  const pageColumns = Array.isArray(page.columns) ? page.columns : run.result?.columns ?? [];
  const pageRows = Array.isArray(page.rows) ? page.rows : [];
  const provisionalRowCount = Math.max(page.rowEnd, run.result?.rowCount ?? 0, pageRows.length);
  return {
    baseDatasetId: run.baseDatasetId,
    columns: pageColumns,
    datasetId: dataset.id,
    datasetName: dataset.name,
    engine: "trino",
    executedAt: run.completedAt ?? run.startedAt ?? run.submittedAt,
    mode: run.mode,
    pageLimit: page.pageSize,
    pageOffset: Math.max(0, page.rowStart - 1),
    query: run.query,
    rangeEnd: page.rowEnd,
    rangeStart: page.rowStart,
    referenceDatasetIds: run.referenceDatasetIds,
    rowCount: page.totalRows ?? provisionalRowCount,
    rows: pageRows.map((row) => row.map((cell) => cell == null ? "" : String(cell))),
    runId: run.runId,
    trinoRuntime: {
      cursors: [...cursors],
      firstPageDisplayMs,
      firstPageRowCount,
      page,
      pageIndex,
      run,
    },
  };
}

function createFullResultClientRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `full-result-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function useFullResultStatusPolling(
  state: FullResultState,
  dispatch: (action: FullResultAction) => void,
  generationRef: { current: number },
) {
  useEffect(() => {
    if (!state.run) return;
    const shouldPoll = ["queued", "running"].includes(state.run.status)
      || state.run.result?.storageStatus === "collecting";
    if (!shouldPoll) return;

    let disposed = false;
    const generation = generationRef.current;
    const runId = state.run.runId;
    const timeoutId = window.setTimeout(() => {
      void getTrinoQueryRun(runId)
        .then((run) => {
          if (disposed || generationRef.current !== generation || run.runId !== runId) return;
          const failed = run.status === "failed" || run.status === "cancelled";
          dispatch({ type: "patch", value: {
            error: failed ? run.error?.message ?? "전체 결과 준비에 실패했습니다." : state.error,
            intent: failed ? null : state.intent,
            pollRetry: 0,
            run,
          } });
        })
        .catch((error) => {
          if (disposed || generationRef.current !== generation) return;
          dispatch({ type: "patch", value: {
            error: error instanceof Error ? error.message : "전체 결과 상태를 확인하지 못했습니다.",
            pollRetry: state.pollRetry + 1,
          } });
        });
    }, Math.min(5_000, 600 * (state.pollRetry + 1)));

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [dispatch, generationRef, state.error, state.intent, state.pollRetry, state.run]);
}

type FullResultPageLoad = {
  cursor: string | null;
  cursors: Array<string | null>;
  dispatch: (action: FullResultAction) => void;
  errorMessage: string;
  generationRef: { current: number };
  loadKeyRef: { current: string };
  recordCursor: boolean;
  run: TrinoQueryRun;
  targetIndex: number;
};

async function loadFullResultPage(options: FullResultPageLoad) {
  const generation = options.generationRef.current;
  const loadKey = createTrinoResultLoadKey(options.run, options.targetIndex, options.cursor);
  options.loadKeyRef.current = loadKey;
  options.dispatch({ type: "patch", value: { pageError: null, pagePending: true } });
  try {
    const page = await getTrinoQueryRunResultPage(options.run.runId, options.cursor);
    if (options.generationRef.current !== generation || options.loadKeyRef.current !== loadKey) return;
    const cursors = options.recordCursor
      ? [...options.cursors.slice(0, options.targetIndex), options.cursor]
      : options.cursors;
    options.dispatch({ type: "patch", value: {
      cursors,
      page,
      pageIndex: options.targetIndex,
      retryCursor: undefined,
    } });
  } catch (error) {
    if (options.generationRef.current !== generation || options.loadKeyRef.current !== loadKey) return;
    options.dispatch({ type: "patch", value: {
      pageError: error instanceof Error ? error.message : options.errorMessage,
      retryCursor: options.cursor,
      retryTargetIndex: options.targetIndex,
    } });
  } finally {
    if (options.generationRef.current === generation && options.loadKeyRef.current === loadKey) {
      options.dispatch({ type: "patch", value: { pagePending: false } });
    }
  }
}

function useFullResultFirstPage(
  state: FullResultState,
  dispatch: (action: FullResultAction) => void,
  generationRef: { current: number },
  loadKeyRef: { current: string },
) {
  useEffect(() => {
    const availablePageCount = state.run?.result?.availablePageCount ?? 0;
    const storageStatus = state.run?.result?.storageStatus;
    if (
      !state.run
      || availablePageCount < 1
      || !["collecting", "available"].includes(storageStatus ?? "")
      || state.pagePending
      || (state.page && state.page.nextCursor && !(storageStatus === "available" && state.page.totalRows == null))
    ) return;
    const cursor = state.cursors[state.pageIndex] ?? null;
    const loadKey = createTrinoResultLoadKey(state.run, state.pageIndex, cursor);
    if (loadKeyRef.current === loadKey) return;
    void loadFullResultPage({
      cursor,
      cursors: state.cursors,
      dispatch,
      errorMessage: "전체 결과 페이지를 불러오지 못했습니다.",
      generationRef,
      loadKeyRef,
      recordCursor: false,
      run: state.run,
      targetIndex: state.pageIndex,
    });
  }, [dispatch, generationRef, loadKeyRef, state.cursors, state.page, state.pageIndex, state.pagePending, state.run]);
}

function useFullResultPagination(
  state: FullResultState,
  dispatch: (action: FullResultAction) => void,
  generationRef: { current: number },
  loadKeyRef: { current: string },
) {
  const loadNext = () => {
    if (!state.run || !state.page?.nextCursor || state.pagePending) return;
    void loadFullResultPage({
      cursor: state.page.nextCursor,
      cursors: state.cursors,
      dispatch,
      errorMessage: "다음 전체 결과 페이지를 불러오지 못했습니다.",
      generationRef,
      loadKeyRef,
      recordCursor: true,
      run: state.run,
      targetIndex: state.pageIndex + 1,
    });
  };
  const loadPrevious = () => {
    if (!state.run || state.pageIndex < 1 || state.pagePending) return;
    const targetIndex = state.pageIndex - 1;
    void loadFullResultPage({
      cursor: state.cursors[targetIndex] ?? null,
      cursors: state.cursors,
      dispatch,
      errorMessage: "이전 전체 결과 페이지를 불러오지 못했습니다.",
      generationRef,
      loadKeyRef,
      recordCursor: false,
      run: state.run,
      targetIndex,
    });
  };
  const retry = () => {
    if (!state.run || state.retryCursor === undefined || state.pagePending) return;
    void loadFullResultPage({
      cursor: state.retryCursor,
      cursors: state.cursors,
      dispatch,
      errorMessage: "전체 결과 페이지를 다시 불러오지 못했습니다.",
      generationRef,
      loadKeyRef,
      recordCursor: true,
      run: state.run,
      targetIndex: state.retryTargetIndex,
    });
  };
  return { loadNext, loadPrevious, retry };
}

function useFullResultRequestActions({
  baseDatasetName,
  dispatch,
  generationRef,
  loadKeyRef,
  onAction,
  previewRun,
  state,
}: {
  baseDatasetName: string | null;
  dispatch: (action: FullResultAction) => void;
  generationRef: { current: number };
  loadKeyRef: { current: string };
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  previewRun: TrinoQueryRun | null;
  state: FullResultState;
}) {
  const triggerCsvDownload = useCallback((run: TrinoQueryRun) => {
    const url = `${apiConfig.baseUrl}/api/query/runs/${encodeURIComponent(run.runId)}/exports/csv`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseDatasetName ?? "query-result"}_${run.runId}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    onAction("analysis.query_run.csv_export.download", `/api/query/runs/${run.runId}/exports/csv`, run.runId);
  }, [baseDatasetName, onAction]);

  const start = async (intent: Exclude<FullResultIntent, null>) => {
    if (!isTrinoResultReady(previewRun) || previewRun.mode !== "preview") return;
    dispatch({ type: "patch", value: { error: null, intent } });
    if (state.run && (["queued", "running"].includes(state.run.status) || isTrinoResultReady(state.run))) return;

    const generation = generationRef.current;
    dispatch({ type: "patch", value: { requestPending: true } });
    try {
      const run = await requestTrinoFullResults(previewRun.runId, createFullResultClientRequestId());
      if (generationRef.current !== generation || run.sourceRunId !== previewRun.runId) return;
      loadKeyRef.current = "";
      dispatch({ type: "patch", value: {
        cursors: [null],
        page: null,
        pageError: null,
        pageIndex: 0,
        pollRetry: 0,
        retryCursor: undefined,
        run,
      } });
      onAction("analysis.query_run.full_result.requested", `/api/query/runs/${previewRun.runId}/full-results`, previewRun.runId);
    } catch (error) {
      if (generationRef.current !== generation) return;
      dispatch({ type: "patch", value: {
        error: error instanceof Error ? error.message : "전체 결과 준비를 시작하지 못했습니다.",
        intent: null,
      } });
      onAction("analysis.query_run.full_result.failed", `/api/query/runs/${previewRun.runId}/full-results`, previewRun.runId, "failed");
    } finally {
      if (generationRef.current === generation) dispatch({ type: "patch", value: { requestPending: false } });
    }
  };

  const downloadCsv = () => {
    if (!isTrinoResultReady(previewRun) || previewRun.mode !== "preview") return;
    if (isTrinoResultReady(state.run)) {
      triggerCsvDownload(state.run);
      return;
    }
    void start("csv");
  };
  const prepareChart = () => void start("chart");
  const openView = () => void start("view");
  return { downloadCsv, openView, prepareChart, triggerCsvDownload };
}

function useFullResultCsvIntent(
  state: FullResultState,
  dispatch: (action: FullResultAction) => void,
  triggerCsvDownload: (run: TrinoQueryRun) => void,
) {
  useEffect(() => {
    if (state.intent !== "csv" || !isTrinoResultReady(state.run)) return;
    triggerCsvDownload(state.run);
    dispatch({ type: "patch", value: { intent: null } });
  }, [dispatch, state.intent, state.run, triggerCsvDownload]);
}

export function useTrinoFullResult({
  baseDataset,
  generationRef,
  onAction,
  previewRun,
}: {
  baseDataset: CatalogDataset | null;
  generationRef: { current: number };
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  previewRun: TrinoQueryRun | null;
}) {
  const [state, dispatch] = useReducer(fullResultReducer, INITIAL_FULL_RESULT_STATE);
  const loadKeyRef = useRef("");
  useFullResultStatusPolling(state, dispatch, generationRef);
  useFullResultFirstPage(state, dispatch, generationRef, loadKeyRef);
  const pageActions = useFullResultPagination(state, dispatch, generationRef, loadKeyRef);
  const displayResult = useMemo(() => {
    if (!state.run || !state.page || !baseDataset) return null;
    return buildTrinoDisplayResult({
      cursors: state.cursors,
      dataset: baseDataset,
      firstPageDisplayMs: null,
      firstPageRowCount: state.page.rows.length,
      page: state.page,
      pageIndex: state.pageIndex,
      run: state.run,
    });
  }, [baseDataset, state.cursors, state.page, state.pageIndex, state.run]);
  const requestActions = useFullResultRequestActions({
    baseDatasetName: baseDataset?.name ?? null,
    dispatch,
    generationRef,
    loadKeyRef,
    onAction,
    previewRun,
    state,
  });
  useFullResultCsvIntent(state, dispatch, requestActions.triggerCsvDownload);
  const clearIntent = useCallback(() => dispatch({ type: "patch", value: { intent: null } }), []);
  const reset = useCallback(() => {
    loadKeyRef.current = "";
    dispatch({ type: "reset" });
  }, []);
  const pagination = useMemo<SqlRemoteResultPagination | undefined>(() => state.run && state.page ? {
    currentPage: state.page.pageNumber ?? state.pageIndex + 1,
    nextDisabled: !state.page.nextCursor,
    onNext: pageActions.loadNext,
    onPrevious: pageActions.loadPrevious,
    pending: state.pagePending,
    previousDisabled: state.pageIndex < 1,
    rangeLabel: state.page.totalRows == null
      ? `${state.page.rowStart.toLocaleString()}–${state.page.rowEnd.toLocaleString()}행 · 전체 결과 준비 중`
      : `${state.page.rowStart.toLocaleString()}–${state.page.rowEnd.toLocaleString()} / ${Math.max(state.page.totalRows, state.page.rowEnd).toLocaleString()}행`,
    totalPages: state.page.totalPages,
  } : undefined, [pageActions.loadNext, pageActions.loadPrevious, state.page, state.pageIndex, state.pagePending, state.run]);
  const preparing = state.requestPending || Boolean(
    state.run && (["queued", "running"].includes(state.run.status) || state.run.result?.storageStatus === "collecting"),
  );
  return {
    canRetryPage: state.retryCursor !== undefined,
    clearIntent,
    displayResult,
    downloadCsv: requestActions.downloadCsv,
    error: state.error,
    intent: state.intent,
    openView: requestActions.openView,
    pageError: state.pageError,
    pagePending: state.pagePending,
    pagination,
    preparing,
    prepareChart: requestActions.prepareChart,
    reset,
    retryPage: pageActions.retry,
    run: state.run,
    viewResult: state.intent === "view" ? displayResult : null,
  };
}
