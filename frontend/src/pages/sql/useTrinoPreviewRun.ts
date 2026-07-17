import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import {
  cancelTrinoQueryRun,
  getTrinoQueryRun,
  getTrinoQueryRunResultPage,
} from "../../services/pipelineApi";
import type {
  AuditResult,
  CatalogDataset,
  SqlResultDraft,
  TrinoQueryRun,
  TrinoQueryRunResultPage,
} from "../../types";
import type { SqlRemoteResultPagination } from "./SqlResultsPanel";
import { buildTrinoDisplayResult, createTrinoResultLoadKey } from "./useTrinoFullResult";

type PreviewRunState = {
  actionError: string | null;
  cancelPending: boolean;
  cursors: Array<string | null>;
  firstPageDisplayMs: number | null;
  firstPageRowCount: number | null;
  page: TrinoQueryRunResultPage | null;
  pageError: string | null;
  pageIndex: number;
  pagePending: boolean;
  pollError: string | null;
  pollRetry: number;
  retryCursor: string | null | undefined;
  retryTargetIndex: number;
  run: TrinoQueryRun | null;
};

type PreviewRunAction =
  | { type: "patch"; value: Partial<PreviewRunState> }
  | { type: "reset" }
  | { type: "start"; run: TrinoQueryRun };

const INITIAL_PREVIEW_RUN_STATE: PreviewRunState = {
  actionError: null,
  cancelPending: false,
  cursors: [null],
  firstPageDisplayMs: null,
  firstPageRowCount: null,
  page: null,
  pageError: null,
  pageIndex: 0,
  pagePending: false,
  pollError: null,
  pollRetry: 0,
  retryCursor: undefined,
  retryTargetIndex: 0,
  run: null,
};

function previewRunReducer(state: PreviewRunState, action: PreviewRunAction): PreviewRunState {
  if (action.type === "reset") return { ...INITIAL_PREVIEW_RUN_STATE, cursors: [null] };
  if (action.type === "start") return { ...INITIAL_PREVIEW_RUN_STATE, cursors: [null], run: action.run };
  return { ...state, ...action.value };
}

type PreviewPageLoad = {
  cursor: string | null;
  generationRef: { current: number };
  initialDisplay?: boolean;
  loadKeyRef: { current: string };
  recordCursor: boolean;
  state: PreviewRunState;
  targetIndex: number;
};

async function loadPreviewPage(options: PreviewPageLoad, dispatch: (action: PreviewRunAction) => void) {
  const generation = options.generationRef.current;
  const loadKey = createTrinoResultLoadKey(options.state.run!, options.targetIndex, options.cursor);
  const startedAt = performance.now();
  options.loadKeyRef.current = loadKey;
  dispatch({ type: "patch", value: { pageError: null, pagePending: true } });
  try {
    const page = await getTrinoQueryRunResultPage(options.state.run!.runId, options.cursor);
    if (options.generationRef.current !== generation || options.loadKeyRef.current !== loadKey) return;
    const cursors = options.recordCursor
      ? [...options.state.cursors.slice(0, options.targetIndex), options.cursor]
      : options.state.cursors;
    dispatch({ type: "patch", value: {
      cursors,
      firstPageRowCount: options.initialDisplay ? options.state.firstPageRowCount ?? page.rows.length : options.state.firstPageRowCount,
      page,
      pageIndex: options.targetIndex,
      retryCursor: undefined,
    } });
    if (options.initialDisplay) window.requestAnimationFrame(() => {
      if (options.loadKeyRef.current !== loadKey) return;
      dispatch({ type: "patch", value: {
        firstPageDisplayMs: options.state.firstPageDisplayMs ?? Math.max(0, Math.round(performance.now() - startedAt)),
      } });
    });
  } catch (error) {
    if (options.generationRef.current !== generation || options.loadKeyRef.current !== loadKey) return;
    dispatch({ type: "patch", value: {
      pageError: error instanceof Error ? error.message : "실행 결과를 불러오지 못했습니다.",
      retryCursor: options.cursor,
      retryTargetIndex: options.targetIndex,
    } });
  } finally {
    if (options.generationRef.current === generation && options.loadKeyRef.current === loadKey) {
      dispatch({ type: "patch", value: { pagePending: false } });
    }
  }
}

function usePreviewRunPolling(
  state: PreviewRunState,
  dispatch: (action: PreviewRunAction) => void,
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
          dispatch({ type: "patch", value: { pollError: null, pollRetry: 0, run } });
        })
        .catch((error) => {
          if (disposed || generationRef.current !== generation) return;
          dispatch({ type: "patch", value: {
            pollError: error instanceof Error ? error.message : "Trino 실행 상태를 확인하지 못했습니다.",
            pollRetry: state.pollRetry + 1,
          } });
        });
    }, Math.min(5_000, 600 * (state.pollRetry + 1)));
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [dispatch, generationRef, state.pollRetry, state.run]);
}

function usePreviewFirstPage(
  state: PreviewRunState,
  dispatch: (action: PreviewRunAction) => void,
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
      || (state.page?.nextCursor && !(storageStatus === "available" && state.page.totalRows == null))
    ) return;
    const cursor = state.cursors[state.pageIndex] ?? null;
    const loadKey = createTrinoResultLoadKey(state.run, state.pageIndex, cursor);
    if (loadKeyRef.current === loadKey) return;
    void loadPreviewPage({
      cursor,
      generationRef,
      initialDisplay: state.pageIndex === 0 && !state.page,
      loadKeyRef,
      recordCursor: false,
      state,
      targetIndex: state.pageIndex,
    }, dispatch);
  }, [dispatch, generationRef, loadKeyRef, state]);
}

export function useTrinoPreviewRun({
  baseDataset,
  generationRef,
  onAction,
}: {
  baseDataset: CatalogDataset | null;
  generationRef: { current: number };
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
}) {
  const [state, dispatch] = useReducer(previewRunReducer, INITIAL_PREVIEW_RUN_STATE);
  const loadKeyRef = useRef("");
  usePreviewRunPolling(state, dispatch, generationRef);
  usePreviewFirstPage(state, dispatch, generationRef, loadKeyRef);

  const reset = useCallback(() => {
    loadKeyRef.current = "";
    dispatch({ type: "reset" });
  }, []);
  const startRun = useCallback((run: TrinoQueryRun) => {
    loadKeyRef.current = "";
    dispatch({ type: "start", run });
  }, []);
  const restore = useCallback((runtime: NonNullable<SqlResultDraft["trinoRuntime"]>) => {
    loadKeyRef.current = createTrinoResultLoadKey(
      runtime.run,
      runtime.pageIndex,
      runtime.cursors[runtime.pageIndex] ?? null,
    );
    dispatch({ type: "patch", value: {
      ...INITIAL_PREVIEW_RUN_STATE,
      cursors: [...runtime.cursors],
      firstPageDisplayMs: runtime.firstPageDisplayMs,
      firstPageRowCount: runtime.firstPageRowCount,
      page: runtime.page,
      pageIndex: runtime.pageIndex,
      run: runtime.run,
    } });
  }, []);

  const loadNext = useCallback(() => {
    if (!state.run || !state.page?.nextCursor || state.pagePending) return;
    void loadPreviewPage({
      cursor: state.page.nextCursor,
      generationRef,
      loadKeyRef,
      recordCursor: true,
      state,
      targetIndex: state.pageIndex + 1,
    }, dispatch);
  }, [generationRef, state]);
  const loadPrevious = useCallback(() => {
    if (!state.run || state.pageIndex < 1 || state.pagePending) return;
    const targetIndex = state.pageIndex - 1;
    void loadPreviewPage({
      cursor: state.cursors[targetIndex] ?? null,
      generationRef,
      loadKeyRef,
      recordCursor: false,
      state,
      targetIndex,
    }, dispatch);
  }, [generationRef, state]);
  const retry = useCallback(() => {
    if (!state.run || state.retryCursor === undefined || state.pagePending) return;
    void loadPreviewPage({
      cursor: state.retryCursor,
      generationRef,
      initialDisplay: state.retryTargetIndex === 0 && state.firstPageDisplayMs == null,
      loadKeyRef,
      recordCursor: true,
      state,
      targetIndex: state.retryTargetIndex,
    }, dispatch);
  }, [generationRef, state]);
  const cancel = useCallback(async () => {
    if (!state.run || !["queued", "running"].includes(state.run.status) || state.cancelPending) return;
    const generation = generationRef.current;
    const runId = state.run.runId;
    dispatch({ type: "patch", value: { actionError: null, cancelPending: true } });
    try {
      const run = await cancelTrinoQueryRun(runId);
      if (generationRef.current !== generation || run.runId !== runId) return;
      dispatch({ type: "patch", value: { pollError: null, run } });
      onAction("analysis.query.run_cancelled", `/api/query/runs/${runId}/cancel`, state.run.baseDatasetId);
    } catch (error) {
      if (generationRef.current !== generation) return;
      dispatch({ type: "patch", value: {
        actionError: error instanceof Error ? error.message : "실행을 취소하지 못했습니다.",
      } });
    } finally {
      if (generationRef.current === generation) dispatch({ type: "patch", value: { cancelPending: false } });
    }
  }, [generationRef, onAction, state]);

  const displayResult = useMemo(() => {
    if (!state.run || !state.page || !baseDataset) return null;
    return buildTrinoDisplayResult({
      cursors: state.cursors,
      dataset: baseDataset,
      firstPageDisplayMs: state.firstPageDisplayMs,
      firstPageRowCount: state.firstPageRowCount,
      page: state.page,
      pageIndex: state.pageIndex,
      run: state.run,
    });
  }, [baseDataset, state.cursors, state.firstPageDisplayMs, state.firstPageRowCount, state.page, state.pageIndex, state.run]);
  const pagination = useMemo<SqlRemoteResultPagination | undefined>(() => state.run && state.page ? {
    currentPage: state.page.pageNumber ?? state.pageIndex + 1,
    nextDisabled: !state.page.nextCursor,
    onNext: loadNext,
    onPrevious: loadPrevious,
    pending: state.pagePending,
    previousDisabled: state.pageIndex < 1,
    rangeLabel: state.page.totalRows == null
      ? `${state.page.rowStart.toLocaleString()}–${state.page.rowEnd.toLocaleString()}행 · 전체 수집 중`
      : `${state.page.rowStart.toLocaleString()}–${state.page.rowEnd.toLocaleString()} / ${Math.max(state.page.totalRows, state.page.rowEnd).toLocaleString()}행`,
    totalPages: state.page.totalPages,
  } : undefined, [loadNext, loadPrevious, state.page, state.pageIndex, state.pagePending, state.run]);

  return {
    actionError: state.actionError,
    cancel,
    cancelPending: state.cancelPending,
    cursors: state.cursors,
    displayResult,
    firstPageDisplayMs: state.firstPageDisplayMs,
    firstPageRowCount: state.firstPageRowCount,
    page: state.page,
    pageError: state.pageError,
    pageIndex: state.pageIndex,
    pagePending: state.pagePending,
    pagination,
    pollError: state.pollError,
    reset,
    restore,
    retry,
    retryCursor: state.retryCursor,
    run: state.run,
    startRun,
  };
}
