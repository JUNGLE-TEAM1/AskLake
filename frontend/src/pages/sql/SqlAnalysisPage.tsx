import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Database,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RotateCcw,
  Search,
} from "lucide-react";
import { executeQueryPreview } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, DerivedDatasetLayer, SqlResultDraft } from "../../types";
import { SqlDashboardPreview } from "./SqlDashboardPreview";
import { SqlDatasetRow } from "./SqlDatasetRow";
import { SqlPreviewTable } from "./SqlPreviewTable";
import { SchemaDetailsPanel } from "./SqlSchemaPanel";
import {
  PREVIEW_ROW_LIMIT,
  SQL_CONTEXT_PAGE_SIZE,
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

export function SqlAnalysisPage({
  cachedResult,
  dataset,
  datasets,
  onAction,
  onPrepareDatasetJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  dataset: CatalogDataset;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onPrepareDatasetJob: (request: CreateDerivedDatasetRequest) => boolean;
  onResultChange: (result: SqlResultDraft | null) => void;
}) {
  const [baseDatasetId, setBaseDatasetId] = useState(dataset.id);
  const baseDataset = useMemo(
    () => datasets.find((item) => item.id === baseDatasetId) ?? dataset,
    [baseDatasetId, dataset, datasets],
  );
  const defaultQuery = useMemo(() => buildDefaultQuery(baseDataset), [baseDataset]);
  const [executed, setExecuted] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [datasetSearch, setDatasetSearch] = useState("");
  const [contextPage, setContextPage] = useState(1);
  const [openSchemaDatasetId, setOpenSchemaDatasetId] = useState<string | null>(null);
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [preflightResult, setPreflightResult] = useState<SqlPreflightResult | null>(null);
  const [derivedDatasetName, setDerivedDatasetName] = useState(buildDefaultDerivedDatasetName(baseDataset));
  const [derivedDatasetDescription, setDerivedDatasetDescription] = useState(buildDefaultDerivedDatasetDescription(baseDataset));
  const [derivedDatasetTags, setDerivedDatasetTags] = useState(buildDefaultDerivedDatasetTags(baseDataset));
  const [derivedDatasetLayer, setDerivedDatasetLayer] = useState<DerivedDatasetLayer>("GOLD");
  const [derivedDatasetRag, setDerivedDatasetRag] = useState(baseDataset.rag);
  const [materializeDialogOpen, setMaterializeDialogOpen] = useState(false);
  const [dashboardDialogOpen, setDashboardDialogOpen] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const referenceDatasetIdSet = useMemo(() => new Set(referenceDatasetIds), [referenceDatasetIds]);
  const queryValidationKey = useMemo(
    () => JSON.stringify({
      baseDatasetId: baseDataset.id,
      query,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
    }),
    [baseDataset.id, query, referenceDatasetIds],
  );
  const derivedDatasetTagList = useMemo(() => parseDerivedDatasetTags(derivedDatasetTags), [derivedDatasetTags]);
  const selectedContextDatasets = useMemo(
    () => [
      baseDataset,
      ...referenceDatasetIds
        .map((id) => datasets.find((item) => item.id === id))
        .filter((item): item is CatalogDataset => Boolean(item)),
    ],
    [baseDataset, datasets, referenceDatasetIds],
  );
  const selectedDatasetIdSet = useMemo(
    () => new Set(selectedContextDatasets.map((item) => item.id)),
    [selectedContextDatasets],
  );
  const schemaDataset = useMemo(
    () => selectedContextDatasets.find((item) => item.id === openSchemaDatasetId) ?? selectedContextDatasets[0] ?? null,
    [openSchemaDatasetId, selectedContextDatasets],
  );
  const canRunPreview = preflightResult?.canExecute === true && preflightResult.key === queryValidationKey;
  const lineNumbers = useMemo(() => {
    const lineCount = Math.max(query.split("\n").length, 7);
    return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  }, [query]);
  const autocompleteContext = useMemo(() => getAutocompleteContext(query, cursorIndex), [cursorIndex, query]);
  const autocompleteCandidates = useMemo(() => {
    if (dismissedAutocompleteKey === autocompleteContext.key) return [];
    return buildAutocompleteCandidates({
      baseDataset,
      context: autocompleteContext,
      datasets,
      referenceDatasetIdSet,
    });
  }, [autocompleteContext, baseDataset, datasets, dismissedAutocompleteKey, referenceDatasetIdSet]);
  const filteredDatasets = useMemo(() => {
    const keyword = datasetSearch.trim().toLowerCase();
    const contextDatasets = datasets.filter((item) => !selectedDatasetIdSet.has(item.id));
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
  }, [datasetSearch, datasets, selectedDatasetIdSet]);
  const totalContextPages = Math.max(1, Math.ceil(filteredDatasets.length / SQL_CONTEXT_PAGE_SIZE));
  const currentContextPage = Math.min(Math.max(contextPage, 1), totalContextPages);
  const contextPageStartIndex = (currentContextPage - 1) * SQL_CONTEXT_PAGE_SIZE;
  const paginatedContextDatasets = filteredDatasets.slice(contextPageStartIndex, contextPageStartIndex + SQL_CONTEXT_PAGE_SIZE);
  const cachedResultBaseDatasetId = cachedResult ? cachedResult.baseDatasetId ?? cachedResult.datasetId : null;
  const canRestoreCachedResult = Boolean(cachedResult && cachedResultBaseDatasetId === baseDataset.id);
  useEffect(() => {
    setBaseDatasetId(dataset.id);
    setReferenceDatasetIds([]);
    setOpenSchemaDatasetId(dataset.id);
    setExpandedDatasetId(null);
  }, [dataset.id]);

  useEffect(() => {
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
    setOpenSchemaDatasetId(baseDataset.id);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset.id, canRestoreCachedResult, defaultQuery]);

  useEffect(() => {
    if (!cachedResult || !canRestoreCachedResult) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);

    setExecuted(true);
    setQuery(cachedResult.query);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    setResultDraft(cachedResult);
    setExecutionMs(null);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
    setOpenSchemaDatasetId(baseDataset.id);
  }, [baseDataset.id, cachedResult, canRestoreCachedResult]);

  const queryContextPath = (mode: "preflight" | "preview" = "preview") => {
    const params = new URLSearchParams({ baseDatasetId: baseDataset.id });
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
  }, [baseDataset.id, datasetSearch, selectedDatasetIdSet]);

  useEffect(() => {
    if (contextPage === currentContextPage) return;
    setContextPage(currentContextPage);
  }, [contextPage, currentContextPage]);

  useEffect(() => {
    const referenceDatasets = datasets.filter((item) => referenceDatasetIdSet.has(item.id));
    setPreflightResult(runSqlPreflight(query, baseDataset, referenceDatasets, queryValidationKey));
  }, [baseDataset, datasets, query, queryValidationKey, referenceDatasetIdSet]);

  const buildPreviewDraft = (): Promise<SqlResultDraft> => executeQueryPreview(baseDataset, query, {
    limit: PREVIEW_ROW_LIMIT,
    referenceDatasetIds: [...referenceDatasetIds].sort(),
    validationKey: queryValidationKey,
  });

  const resetResultState = () => {
    setExecuted(false);
    setResultDraft(null);
    setExecutionMs(null);
    setPreflightResult(null);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
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
    if (candidate.type === "table" && candidate.datasetId && candidate.datasetId !== baseDataset.id) {
      const datasetId = candidate.datasetId;
      setReferenceDatasetIds((ids) => (ids.includes(datasetId) ? ids : [...ids, datasetId]));
    }
    onAction("analysis.autocomplete.inserted", `/api/query/autocomplete/${candidate.type}/${encodeURIComponent(candidate.label)}`, candidate.datasetId ?? baseDataset.id);
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
    if (!canRunPreview) {
      onAction("analysis.query.preview_blocked", queryContextPath("preview"), baseDataset.id, "failed");
      return;
    }
    const startedAt = performance.now();
    setQueryPending(true);
    try {
      const resultDraft = await buildPreviewDraft();
      setExecuted(true);
      setExecutionMs(Math.round(performance.now() - startedAt));
      setResultDraft(resultDraft);
      onResultChange(resultDraft);
      onAction("analysis.query.preview_executed", queryContextPath("preview"), baseDataset.id);
    } catch {
      setPreflightResult({
        key: queryValidationKey,
        canExecute: false,
        messages: [{ tone: "error", text: "Preview 실행에 실패했습니다. 쿼리 또는 데이터셋 상태를 확인해 주세요." }],
      });
      onAction("analysis.query.preview_failed", queryContextPath("preview"), baseDataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

  const preflightSummary = getPreflightSummary(preflightResult);

  const resetQuery = () => {
    updateQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    onAction("analysis.query.reset", "/api/query/reset", baseDataset.id);
  };

  const toggleContext = () => {
    const nextCollapsed = !contextCollapsed;
    setContextCollapsed(nextCollapsed);
    onAction(nextCollapsed ? "analysis.context.collapsed" : "analysis.context.expanded", "/api/query/context", baseDataset.id);
  };

  const insertSqlText = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      updateQuery(`${query.replace(/;$/, "")} ${text};`);
      return;
    }
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
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

  const removeSelectedDataset = (targetDataset: CatalogDataset) => {
    const selectedIds = selectedContextDatasets.map((item) => item.id);
    if (selectedIds.length <= 1) {
      onAction(
        "analysis.context.dataset_remove_blocked",
        `/api/query/context/datasets/${targetDataset.id}/remove`,
        targetDataset.id,
        "failed",
      );
      return;
    }

    const nextSelectedIds = selectedIds.filter((id) => id !== targetDataset.id);
    const nextBaseDatasetId = targetDataset.id === baseDataset.id ? nextSelectedIds[0] : baseDataset.id;
    const nextReferenceDatasetIds = nextSelectedIds.filter((id) => id !== nextBaseDatasetId);

    if (targetDataset.id === baseDataset.id) {
      const nextBaseDataset = selectedContextDatasets.find((item) => item.id === nextBaseDatasetId)
        ?? datasets.find((item) => item.id === nextBaseDatasetId);
      if (nextBaseDataset) {
        const nextDefaultQuery = buildDefaultQuery(nextBaseDataset);
        setQuery(nextDefaultQuery);
        setCursorIndex(nextDefaultQuery.length);
      }
      setBaseDatasetId(nextBaseDatasetId);
    }

    setReferenceDatasetIds(nextReferenceDatasetIds);
    setOpenSchemaDatasetId(
      openSchemaDatasetId && nextSelectedIds.includes(openSchemaDatasetId) ? openSchemaDatasetId : nextBaseDatasetId,
    );
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
    insertSqlText(columnName);
    onAction("analysis.context.column_inserted", `/api/query/context/datasets/${targetDataset.id}/columns/${columnName}`, targetDataset.id);
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
    if (!resultDraft) return;
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

  return (
    <div className={[
      "sql-page",
      contextCollapsed ? "context-collapsed" : "",
    ].filter(Boolean).join(" ")}>
      {contextCollapsed && (
        <button className="sql-context-rail-button" type="button" onClick={toggleContext} aria-label="분석 테이블 열기" title="분석 테이블 열기">
          <PanelLeftOpen size={16} />
        </button>
      )}
      {!contextCollapsed && (
        <aside className="sql-dataset-panel">
          <div className="sql-panel-header">
            <span>TABLE SEARCH</span>
            <div className="sql-panel-title-row">
              <strong>분석 테이블</strong>
              <span className="sql-panel-header-actions">
                <em>{Math.max(0, datasets.length - selectedContextDatasets.length)} available</em>
                <button type="button" onClick={toggleContext} aria-label="분석 테이블 접기" title="분석 테이블 접기">
                  <PanelLeftClose size={15} />
                </button>
              </span>
            </div>
          </div>
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
              <h2>선택 가능한 테이블</h2>
              <span>{filteredDatasets.length}개</span>
            </div>
            <div className="sql-context-result-list">
              {paginatedContextDatasets.map((item) => (
                <SqlDatasetRow
                  dataset={item}
                  expanded={expandedDatasetId === item.id}
                  key={item.id}
                  onSelect={addSelectedDataset}
                  onToggle={toggleDatasetPreview}
                />
              ))}
              {filteredDatasets.length === 0 && (
                <p>{datasetSearch.trim() ? "검색 결과가 없습니다." : "선택 가능한 테이블이 없습니다."}</p>
              )}
            </div>
            {filteredDatasets.length > SQL_CONTEXT_PAGE_SIZE && (
              <div className="sql-context-pagination" aria-label="table search pagination">
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
        </aside>
      )}

      <main className="sql-workspace">
        <header className="sql-page-header">
          <div>
            <span>Analyze / Dataset-scoped SQL</span>
            <h1>읽기 전용 SQL 실행</h1>
            <p>{selectedContextDatasets.length}개 선택 테이블 범위에서 쿼리를 작성하고 결과를 내보냅니다.</p>
          </div>
        </header>

        <section className="sql-editor-card">
          <div className="sql-editor-header">
            <div>
              <span>QUERY EDITOR</span>
              <h2>선택 데이터셋 기준 SQL</h2>
            </div>
            <div className="sql-editor-actions">
              <button className="primary-button" type="button" onClick={executePreview} disabled={!canRunPreview || queryPending}>
                <PlayCircle size={16} /> {queryPending ? "Preview 중" : "Preview 실행"}
              </button>
            </div>
          </div>
          <div className="sql-editor-layout">
            <div className="sql-editor-surface">
              <pre ref={lineNumberRef} aria-hidden="true">{lineNumbers}</pre>
              <div className="sql-editor-input-wrap">
                <textarea
                  ref={textareaRef}
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
              <span>Context: 선택 테이블 {selectedContextDatasets.length}개</span>
              {preflightSummary && (
                <span className={`sql-check-pill ${preflightSummary.tone}`}>
                  {preflightSummary.label}
                </span>
              )}
              {preflightSummary?.detail && <span className={`sql-check-detail ${preflightSummary.tone}`}>{preflightSummary.detail}</span>}
            </div>
            <button className="secondary-button" type="button" onClick={resetQuery}><RotateCcw size={14} /> Reset SQL</button>
          </div>
        </section>

        <section className={resultDraft ? "sql-result-card result-ready" : "sql-result-card"}>
          <div className="sql-result-header">
            <div>
              <span>PREVIEW RESULT</span>
              <h2>{resultDraft ? `${resultDraft.rowCount} rows returned` : "Preview 실행 후 결과가 표시됩니다"}</h2>
            </div>
            <div className="sql-result-status">
              <span>{queryPending ? "running" : executed ? "테스트 완료" : "ready"}</span>
              {executionMs !== null && <span>{formatDuration(executionMs)}</span>}
            </div>
          </div>
          {resultDraft ? (
            <>
              <div className="sql-result-toolbar">
                <span>
                  Run ID {resultDraft.runId}
                  {resultDraft.previewLimit ? ` · Preview ${resultDraft.previewLimit} rows` : ""}
                  {` · ${resultDraft.rows.length}/${resultDraft.rowCount} rows shown · ${resultDraft.columns.length} columns`}
                  {` · ${formatResultTimestamp(resultDraft.executedAt)}`}
                </span>
                <div className="sql-result-actions">
                  <button type="button" onClick={downloadCsv}><Download size={14} /> Preview 전체 CSV</button>
                  <button type="button" onClick={() => setMaterializeDialogOpen(true)}><Database size={14} /> 처리 Job 생성</button>
                  <button type="button" onClick={() => setDashboardDialogOpen(true)}><BarChart3 size={14} /> 대시보드 만들기</button>
                </div>
              </div>
              <div className="sql-result-scroll">
                <SqlPreviewTable resultDraft={resultDraft} />
              </div>
            </>
          ) : (
            <div className="sql-result-empty">
              <strong>아직 Preview 결과가 없습니다.</strong>
              <span>SQL 점검을 통과한 뒤 Preview를 실행하면 결과 테이블이 표시됩니다.</span>
            </div>
          )}
        </section>
      </main>
      {resultDraft && materializeDialogOpen && (
        <div className="sql-materialize-dialog-backdrop" role="presentation" onMouseDown={() => setMaterializeDialogOpen(false)}>
          <section className="sql-materialize-dialog" role="dialog" aria-modal="true" aria-labelledby="sql-materialize-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="sql-materialize-dialog-header">
              <div>
                <span>PROCESSING JOB</span>
                <h2 id="sql-materialize-dialog-title">SQL 결과 처리 Job 생성</h2>
              </div>
              <button type="button" onClick={() => setMaterializeDialogOpen(false)} aria-label="저장 설정 닫기">닫기</button>
            </header>
            <div className="sql-materialize-form">
              <label>
                <span>Dataset name</span>
                <input
                  onChange={(event) => {
                    setDerivedDatasetName(event.target.value);
                  }}
                  value={derivedDatasetName}
                />
              </label>
              <label className="wide">
                <span>Description</span>
                <textarea
                  onChange={(event) => {
                    setDerivedDatasetDescription(event.target.value);
                  }}
                  rows={2}
                  value={derivedDatasetDescription}
                />
              </label>
              <label className="wide">
                <span>Tags</span>
                <input
                  onChange={(event) => {
                    setDerivedDatasetTags(event.target.value);
                  }}
                  placeholder="#sql-derived #analysis"
                  value={derivedDatasetTags}
                />
              </label>
              <label>
                <span>Layer</span>
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
                disabled={derivedDatasetName.trim().length === 0 || derivedDatasetTagList.length === 0}
                onClick={prepareDerivedDatasetJob}
                type="button"
              >
                <Database size={15} /> Job 생성 검토로 이동
              </button>
            </div>
            <div className="sql-materialize-summary">
              <span>source {resultDraft.runId} · {derivedDatasetTagList.length} tags · {resultDraft.columns.length} columns · Review 단계에서 생성 요청</span>
            </div>
          </section>
        </div>
      )}
      {resultDraft && dashboardDialogOpen && (
        <div className="sql-materialize-dialog-backdrop" role="presentation" onMouseDown={() => setDashboardDialogOpen(false)}>
          <section className="sql-materialize-dialog sql-dashboard-dialog" role="dialog" aria-modal="true" aria-labelledby="sql-dashboard-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="sql-materialize-dialog-header">
              <div>
                <span>DASHBOARD</span>
                <h2 id="sql-dashboard-dialog-title">SQL 결과 즉석 대시보드</h2>
              </div>
              <button type="button" onClick={() => setDashboardDialogOpen(false)} aria-label="대시보드 생성 닫기">닫기</button>
            </header>
            <SqlDashboardPreview resultDraft={resultDraft} dataset={baseDataset} />
          </section>
        </div>
      )}
      <SchemaDetailsPanel
        dataset={schemaDataset}
        selectedDatasets={selectedContextDatasets}
        onColumnClick={insertColumnName}
        onSelectedDatasetRemove={removeSelectedDataset}
        onSchemaSelect={selectSchemaDataset}
      />
    </div>
  );
}
