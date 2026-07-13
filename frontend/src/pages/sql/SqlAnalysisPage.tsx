import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { executeQueryPreview, getQueryPreviewPage } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, SqlResultDraft } from "../../types";
import styles from "./SqlAnalysisPage.module.css";
import { SqlDatasetContextPanel } from "./SqlDatasetContextPanel";
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
  runSqlPreflight,
  type AutocompleteCandidate,
  type SqlPreflightResult,
} from "./sqlLogic";
import { useSqlContextPanel } from "./useSqlContextPanel";
import { useSqlQueryAi } from "./useSqlQueryAi";

export function SqlAnalysisPage({
  cachedResult,
  createPending,
  dataset,
  datasets,
  onAction,
  onCreateDatasetJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  createPending: boolean;
  dataset: CatalogDataset | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCreateDatasetJob: (request: CreateDerivedDatasetRequest) => Promise<boolean>;
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
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [previewRowLimit, setPreviewRowLimit] = useState(PREVIEW_ROW_LIMIT);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
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
  const contextPanel = useSqlContextPanel({
    baseDatasetId: baseDataset?.id ?? null,
    datasets,
    onAction,
    selectedDatasetCount: selectedContextDatasets.length,
    selectedDatasetIds: selectedDatasetIdSet,
  });
  const canRunPreview = Boolean(baseDataset && preflightResult?.canExecute === true && preflightResult.key === queryValidationKey);
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
  const cachedResultBaseDatasetId = cachedResult ? cachedResult.baseDatasetId ?? cachedResult.datasetId : null;
  const canRestoreCachedResult = Boolean(cachedResult && baseDataset && cachedResultBaseDatasetId === baseDataset.id);
  useEffect(() => {
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
    setPreflightResult(null);
    setMaterializeDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setDialogResultDraft(null);
    setResultPageError(null);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset?.id]);

  useEffect(() => {
    if (!baseDataset || !cachedResult || !canRestoreCachedResult) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);

    setQuery(cachedResult.query);
    setPreviewRowLimit(cachedResult.previewLimit ?? PREVIEW_ROW_LIMIT);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    setResultDraft(cachedResult);
    setMaterializeDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setDialogResultDraft(null);
    setResultPageError(null);
  }, [baseDataset, cachedResult, canRestoreCachedResult]);

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

  const buildPreviewDraft = (): Promise<SqlResultDraft> => {
    if (!baseDataset) return Promise.reject(new Error("No dataset selected"));
    return executeQueryPreview(baseDataset, query, {
      limit: previewRowLimit,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
      validationKey: queryValidationKey,
    });
  };

  const resetResultState = () => {
    setResultDraft(null);
    setPreflightResult(null);
    setChartConfig(null);
    setResultView("table");
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

  const executePreview = async () => {
    if (!baseDataset || !canRunPreview) {
      onAction("analysis.query.preview_blocked", queryContextPath("preview"), baseDataset?.id ?? "sql-empty", "failed");
      return;
    }
    setQueryPending(true);
    try {
      const resultDraft = await buildPreviewDraft();
      setResultDraft(resultDraft);
      setDialogResultDraft(null);
      setResultPageError(null);
      setChartConfig(null);
      setResultView("table");
      onResultChange(resultDraft);
      onAction("analysis.query.preview_executed", queryContextPath("preview"), baseDataset.id);
    } catch (error) {
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
    if (open && resultDraft) setDialogResultDraft(resultDraft);
  };

  const loadResultPage = async (offset: number) => {
    if (!resultDraft || resultPagePending) return;
    const limit = resultDraft.pageLimit ?? resultDraft.previewLimit ?? PREVIEW_ROW_LIMIT;
    setResultPagePending(true);
    setResultPageError(null);
    try {
      const page = await getQueryPreviewPage(resultDraft.runId, { limit, offset });
      setDialogResultDraft(page);
      onAction(
        "analysis.query.preview_page_loaded",
        `/api/query/runs/${encodeURIComponent(resultDraft.runId)}?offset=${offset}&limit=${limit}`,
        resultDraft.datasetId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "SQL Preview 페이지를 불러오지 못했습니다.";
      setResultPageError(message);
      onAction(
        "analysis.query.preview_page_failed",
        `/api/query/runs/${encodeURIComponent(resultDraft.runId)}?offset=${offset}&limit=${limit}`,
        resultDraft.datasetId,
        "failed",
      );
    } finally {
      setResultPagePending(false);
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
    if (targetDataset.id === baseDataset?.id) return;
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
    if (!resultDraft) return;
    setChartConfig(nextConfig);
    setResultView("chart");
    onAction("analysis.chart.configured", `/api/query/runs/${resultDraft.runId}/visualization`, resultDraft.datasetId);
  };

  return (
    <div className={cn(styles.page, contextPanel.collapsed && styles.collapsed)}>
      <PageHeader
        className={styles.pageHeader}
        icon={<TerminalSquare size={18} />}
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
          onExecute={executePreview}
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
          dialogResultDraft={dialogResultDraft}
          dialogOpen={resultDialogOpen}
          pageError={resultPageError}
          pagePending={resultPagePending}
          onDialogOpenChange={changeResultDialogOpen}
          onDownloadCsv={downloadCsv}
          onOpenJobWizard={() => setMaterializeDialogOpen(true)}
          onPageChange={loadResultPage}
          onResultViewChange={setResultView}
          resultDraft={resultDraft}
          resultView={resultView}
        />
      </main>
      {resultDraft && baseDataset && materializeDialogOpen && (
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
          resultDraft={resultDraft}
        />
      )}
    </div>
  );
}
