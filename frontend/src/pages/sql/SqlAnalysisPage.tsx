import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  Download,
  PlayCircle,
  RotateCcw,
  Search,
} from "lucide-react";
import postgresqlParser from "node-sql-parser/build/postgresql.js";
import { executeQueryPreview } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, SqlResultDraft } from "../../types";

type AutocompleteKind = "keyword" | "table" | "column";

type AutocompleteCandidate = {
  id: string;
  type: AutocompleteKind;
  label: string;
  insertText: string;
  detail: string;
  datasetId?: string;
};

type AutocompleteContext = {
  token: string;
  start: number;
  end: number;
  mode: "table" | "column" | "general";
  key: string;
};

type SqlPreflightMessage = {
  tone: "success" | "info" | "warning" | "error";
  text: string;
};

type SqlPreflightResult = {
  key: string;
  canExecute: boolean;
  messages: SqlPreflightMessage[];
};

type DerivedDatasetDraft = {
  columnCount: number;
  datasetId?: string;
  layer: CatalogDataset["layer"];
  name: string;
  rowCount: number;
  sourceDatasetId: string;
  sourceRunId: string;
};

const PREVIEW_ROW_LIMIT = 100;
const { Parser: SqlParser } = postgresqlParser;
const sqlParser = new SqlParser();

export function SqlAnalysisPage({
  dataset,
  datasets,
  onAction,
  onCreateDerivedDataset,
  onResultChange,
}: {
  dataset: CatalogDataset;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCreateDerivedDataset: (request: {
    layer: CatalogDataset["layer"];
    name: string;
    sourceDataset: CatalogDataset;
    sqlResult: SqlResultDraft;
  }) => Promise<CatalogDataset | null>;
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
  const [openSchemaDatasetId, setOpenSchemaDatasetId] = useState<string | null>(null);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [showReferencedOnly, setShowReferencedOnly] = useState(false);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [preflightResult, setPreflightResult] = useState<SqlPreflightResult | null>(null);
  const [derivedDatasetName, setDerivedDatasetName] = useState(buildDefaultDerivedDatasetName(baseDataset));
  const [derivedDatasetLayer, setDerivedDatasetLayer] = useState<CatalogDataset["layer"]>("GOLD");
  const [derivedDatasetDraft, setDerivedDatasetDraft] = useState<DerivedDatasetDraft | null>(null);
  const [derivedDatasetPending, setDerivedDatasetPending] = useState(false);
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
    const contextDatasets = datasets.filter((item) => {
      if (item.id === baseDataset.id) return false;
      if (showReferencedOnly && !referenceDatasetIdSet.has(item.id)) return false;
      return true;
    });
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

    return searchableDatasets.slice(0, 4);
  }, [baseDataset.id, datasetSearch, datasets, referenceDatasetIdSet, showReferencedOnly]);
  useEffect(() => {
    setBaseDatasetId(dataset.id);
  }, [dataset.id]);

  useEffect(() => {
    setExecuted(false);
    setQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    setResultDraft(null);
    setExecutionMs(null);
    setPreflightResult(null);
    setDerivedDatasetName(buildDefaultDerivedDatasetName(baseDataset));
    setDerivedDatasetDraft(null);
    setOpenSchemaDatasetId(null);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset.id, defaultQuery]);

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
    setDerivedDatasetDraft(null);
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
      setDerivedDatasetDraft(null);
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

  const insertTableName = (targetDataset: CatalogDataset) => {
    insertSqlText(targetDataset.name);
    setOpenSchemaDatasetId(targetDataset.id);
    if (targetDataset.id !== baseDataset.id) {
      setReferenceDatasetIds((ids) => (ids.includes(targetDataset.id) ? ids : [...ids, targetDataset.id]));
    }
    onAction("analysis.context.dataset_inserted", `/api/query/context/datasets/${targetDataset.id}`, targetDataset.id);
  };

  const changeBaseDataset = (targetDataset: CatalogDataset) => {
    setBaseDatasetId(targetDataset.id);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== targetDataset.id));
    setOpenSchemaDatasetId(targetDataset.id);
    const nextDefaultQuery = buildDefaultQuery(targetDataset);
    setQuery(nextDefaultQuery);
    setCursorIndex(nextDefaultQuery.length);
    resetResultState();
    onAction("analysis.context.base_dataset_changed", `/api/query/context/base-datasets/${targetDataset.id}`, targetDataset.id);
  };

  const toggleReferenceDataset = (targetDataset: CatalogDataset) => {
    if (targetDataset.id === baseDataset.id) return;
    const isReferenced = referenceDatasetIdSet.has(targetDataset.id);
    setReferenceDatasetIds((ids) => (
      isReferenced ? ids.filter((id) => id !== targetDataset.id) : [...ids, targetDataset.id]
    ));
    resetResultState();
    onAction(
      isReferenced ? "analysis.context.reference_removed" : "analysis.context.reference_added",
      `/api/query/context/reference-datasets/${targetDataset.id}`,
      targetDataset.id,
    );
  };

  const toggleReferencedOnly = () => {
    const nextValue = !showReferencedOnly;
    setShowReferencedOnly(nextValue);
    onAction(
      nextValue ? "analysis.context.references_filtered" : "analysis.context.references_filter_cleared",
      "/api/query/context/reference-datasets",
      baseDataset.id,
    );
  };

  const toggleSchema = (targetDataset: CatalogDataset) => {
    const willOpen = openSchemaDatasetId !== targetDataset.id;
    setOpenSchemaDatasetId(willOpen ? targetDataset.id : null);
    onAction(
      willOpen ? "analysis.context.schema_opened" : "analysis.context.schema_closed",
      `/api/query/context/datasets/${targetDataset.id}/schema`,
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

  const createDerivedDataset = async () => {
    if (!resultDraft) return;
    setDerivedDatasetPending(true);
    try {
      const dataset = await onCreateDerivedDataset({
        layer: derivedDatasetLayer,
        name: derivedDatasetName.trim(),
        sourceDataset: baseDataset,
        sqlResult: resultDraft,
      });
      if (!dataset) return;
      setDerivedDatasetDraft({
        columnCount: resultDraft.columns.length,
        datasetId: dataset.id,
        layer: dataset.layer,
        name: dataset.name,
        rowCount: resultDraft.rowCount,
        sourceDatasetId: resultDraft.datasetId,
        sourceRunId: resultDraft.runId,
      });
    } finally {
      setDerivedDatasetPending(false);
    }
  };

  return (
    <div className={contextCollapsed ? "sql-page context-collapsed" : "sql-page"}>
      <aside className="sql-dataset-panel" aria-hidden={contextCollapsed}>
        <div className="sql-panel-header">
          <span>TABLE SEARCH</span>
          <div>
            <strong>분석 테이블</strong>
            <em>{datasets.length} tables</em>
          </div>
        </div>
        <section className="sql-base-table">
          <h2>BASE DATASET</h2>
          <SqlDatasetRow
            dataset={baseDataset}
            expanded={openSchemaDatasetId === baseDataset.id}
            isBase
            onInsert={insertTableName}
            onSchemaToggle={toggleSchema}
            onColumnClick={insertColumnName}
          />
        </section>
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
            <h2>table search</h2>
            <button type="button" onClick={toggleReferencedOnly} disabled={referenceDatasetIds.length === 0 && !showReferencedOnly}>
              {showReferencedOnly ? "All tables" : `${referenceDatasetIds.length} referenced`}
            </button>
          </div>
          <div>
            {filteredDatasets.map((item) => (
              <SqlDatasetRow
                dataset={item}
                expanded={openSchemaDatasetId === item.id}
                isReferenced={referenceDatasetIdSet.has(item.id)}
                key={item.id}
                onBaseChange={changeBaseDataset}
                onColumnClick={insertColumnName}
                onInsert={insertTableName}
                onReferenceToggle={toggleReferenceDataset}
                onSchemaToggle={toggleSchema}
              />
            ))}
            {filteredDatasets.length === 0 && (
              <p>{showReferencedOnly ? "참조된 테이블이 없습니다." : "검색 결과가 없습니다."}</p>
            )}
          </div>
        </section>
      </aside>

      <button className="sql-collapse-button" type="button" onClick={toggleContext} aria-label={contextCollapsed ? "SQL context 펼치기" : "SQL context 접기"}>
        {contextCollapsed ? "›" : "‹"}
      </button>

      <main className="sql-workspace">
        <header className="sql-page-header">
          <span>Analyze / Dataset-scoped SQL</span>
          <h1>읽기 전용 SQL 실행</h1>
          <p>{baseDataset.name} 데이터셋 범위에서 쿼리를 작성하고 결과를 내보냅니다.</p>
        </header>

        <section className="sql-editor-card">
          <div className="sql-editor-header">
            <div>
              <span>QUERY EDITOR</span>
              <h2>Base Dataset 기준 SQL</h2>
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
              <span>Context: base + {referenceDatasetIds.length} referenced tables</span>
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

        <section className="sql-result-card">
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
                </span>
                <button type="button" onClick={downloadCsv}><Download size={14} /> CSV 다운로드</button>
              </div>
              <div className="sql-result-scroll">
                <table className="schema-table">
                  <thead><tr>{resultDraft.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
                  <tbody>{resultDraft.rows.map((row, rowIndex) => <tr key={`result-${rowIndex}`}>{row.slice(0, resultDraft.columns.length).map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="sql-result-empty">
              <strong>아직 Preview 결과가 없습니다.</strong>
              <span>SQL 점검을 통과한 뒤 Preview를 실행하면 결과 테이블이 표시됩니다.</span>
            </div>
          )}
          <section className={resultDraft ? "sql-materialize-card" : "sql-materialize-card disabled"}>
            <div>
              <span>LAKE DATASET</span>
              <h3>Preview 결과 저장</h3>
            </div>
            <div className="sql-materialize-form">
              <label>
                <span>Dataset name</span>
                <input
                  disabled={!resultDraft}
                  onChange={(event) => {
                    setDerivedDatasetName(event.target.value);
                    setDerivedDatasetDraft(null);
                  }}
                  value={derivedDatasetName}
                />
              </label>
              <label>
                <span>Layer</span>
                <select
                  disabled={!resultDraft}
                  onChange={(event) => {
                    setDerivedDatasetLayer(event.target.value as CatalogDataset["layer"]);
                    setDerivedDatasetDraft(null);
                  }}
                  value={derivedDatasetLayer}
                >
                  <option value="SILVER">SILVER</option>
                  <option value="GOLD">GOLD</option>
                </select>
              </label>
              <button
                className="primary-button"
                disabled={!resultDraft || derivedDatasetName.trim().length === 0 || derivedDatasetPending || Boolean(derivedDatasetDraft)}
                onClick={createDerivedDataset}
                type="button"
              >
                <Database size={15} /> {derivedDatasetDraft ? "생성됨" : derivedDatasetPending ? "생성 중" : "Lake Dataset 생성"}
              </button>
            </div>
            <div className="sql-materialize-summary">
              {derivedDatasetDraft ? (
                <span>{derivedDatasetDraft.layer} · {derivedDatasetDraft.name} · {derivedDatasetDraft.columnCount} columns · {derivedDatasetDraft.datasetId}</span>
              ) : resultDraft ? (
                <span>{resultDraft.rowCount} preview rows · source {resultDraft.runId}</span>
              ) : (
                <span>Preview 성공 후 Lake Dataset을 생성할 수 있습니다.</span>
              )}
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}

function SchemaColumnList({
  dataset,
  onColumnClick,
}: {
  dataset: CatalogDataset;
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
}) {
  return (
    <div className="sql-card-schema">
      {dataset.schema.map(([name, type], index) => (
        <button key={`${dataset.id}-${name}-${index}`} type="button" onClick={() => onColumnClick(dataset, name)}>
          <span>{name}</span>
          <em>{type}</em>
        </button>
      ))}
    </div>
  );
}

function buildDefaultQuery(dataset: CatalogDataset) {
  const columns = dataset.schema.slice(0, 4).map(([name]) => name).join(", ") || "*";
  return `SELECT ${columns}
FROM ${dataset.name}
LIMIT 100;`;
}

function buildDefaultDerivedDatasetName(dataset: CatalogDataset) {
  return `${dataset.name}_analysis`;
}

function SqlDatasetRow({
  dataset,
  expanded,
  isBase = false,
  isReferenced = false,
  onBaseChange,
  onColumnClick,
  onInsert,
  onReferenceToggle,
  onSchemaToggle,
}: {
  dataset: CatalogDataset;
  expanded: boolean;
  isBase?: boolean;
  isReferenced?: boolean;
  onBaseChange?: (dataset: CatalogDataset) => void;
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
  onInsert: (dataset: CatalogDataset) => void;
  onReferenceToggle?: (dataset: CatalogDataset) => void;
  onSchemaToggle: (dataset: CatalogDataset) => void;
}) {
  const rowClasses = [
    "sql-table-card",
    expanded ? "active" : "",
    isBase ? "base" : "",
    isReferenced ? "referenced" : "",
  ].filter(Boolean).join(" ");

  return (
    <article className={rowClasses}>
      <button className="sql-table-row" type="button" aria-expanded={expanded} onClick={() => onSchemaToggle(dataset)}>
        <span className="sql-table-toggle">{expanded ? "▾" : "▸"}</span>
        <span className="sql-table-name">
          <strong>{dataset.name}</strong>
        </span>
        <span className="sql-table-pills">
          {isBase && <span className="sql-table-base-pill">BASE</span>}
          {isReferenced && <span className="sql-table-ref-pill">REF</span>}
          <span className="sql-table-layer">{dataset.layer}</span>
          {dataset.rag && <span className="sql-table-rag-pill">RAG</span>}
        </span>
      </button>
      {expanded && (
        <div className="sql-table-expanded">
          <div className="sql-table-card-actions">
            {!isBase && <button type="button" onClick={() => onBaseChange?.(dataset)}>Base로 설정</button>}
            {!isBase && (
              <button type="button" onClick={() => onReferenceToggle?.(dataset)}>
                {isReferenced ? "참조 해제" : "참조 추가"}
              </button>
            )}
            <button type="button" onClick={() => onInsert(dataset)}>SQL에 삽입</button>
          </div>
          <SchemaColumnList dataset={dataset} onColumnClick={onColumnClick} />
        </div>
      )}
    </article>
  );
}

function getPreflightSummary(result: SqlPreflightResult | null) {
  if (!result) return null;
  if (result.canExecute) {
    const warningMessage = result.messages.find((message) => message.tone === "warning")?.text;
    if (warningMessage) {
      return { detail: warningMessage, label: "확인 필요", tone: "warning" as const };
    }
    return { detail: "", label: "점검 통과", tone: "success" as const };
  }
  const errorMessage = result.messages.find((message) => message.tone === "error")?.text ?? "SQL을 확인해 주세요.";
  return { detail: errorMessage, label: "점검 필요", tone: "error" as const };
}

function runSqlPreflight(query: string, baseDataset: CatalogDataset, referenceDatasets: CatalogDataset[], key: string): SqlPreflightResult {
  const normalizedQuery = stripSqlComments(query).trim();
  const messages: SqlPreflightMessage[] = [];
  if (!normalizedQuery) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: "실행할 SQL을 입력해 주세요." }],
    };
  }

  const parsedQuery = parseSqlQuery(normalizedQuery);
  if (!parsedQuery.ok) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: parsedQuery.message }],
    };
  }

  const statements = Array.isArray(parsedQuery.ast) ? parsedQuery.ast : [parsedQuery.ast];
  if (statements.length !== 1) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: "Preview는 단일 SELECT 문만 실행할 수 있습니다." }],
    };
  }

  const statement = statements[0];
  if (!isSelectStatement(statement)) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: "읽기 전용 SQL만 실행할 수 있습니다. SELECT 또는 WITH로 시작해야 합니다." }],
    };
  }

  const limitIssue = findLimitIssue(statement);
  if (limitIssue) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: limitIssue }],
    };
  }

  const allowedTableNames = new Set([baseDataset.name, ...referenceDatasets.map((item) => item.name)].map(normalizeSqlIdentifier));
  const cteNames = extractCteNames(statement);
  const referencedTableNames = extractReferencedTableNames(statement);
  const unknownTableNames = referencedTableNames.filter((name) => {
    const normalizedName = normalizeSqlIdentifier(name);
    return !allowedTableNames.has(normalizedName) && !cteNames.has(normalizedName);
  });

  if (unknownTableNames.length > 0) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: `Query context에 없는 테이블이 있습니다: ${unknownTableNames.join(", ")}` }],
    };
  }

  messages.push({ tone: "success", text: `읽기 전용 SQL 확인 완료. base + ${referenceDatasets.length} referenced tables 기준으로 Preview할 수 있습니다.` });
  messages.push({ tone: "info", text: `Preview는 원본 SQL을 바꾸지 않고 최대 ${PREVIEW_ROW_LIMIT} rows로 제한해 실행합니다.` });
  const tableAliases = extractTableAliases(statement);
  if (tableAliases.length > 0) {
    messages.push({ tone: "warning", text: `테이블 alias ${tableAliases.map((alias) => `"${alias}"`).join(", ")}가 감지되었습니다. 의도한 별칭이면 Preview할 수 있고, LIMIT 오타라면 수정해 주세요.` });
  }
  if (referencedTableNames.length === 0) {
    messages.push({ tone: "warning", text: "FROM/JOIN 테이블이 없습니다. 상수 조회 또는 CTE-only 쿼리인지 확인해 주세요." });
  }

  return { key, canExecute: true, messages };
}

function stripSqlComments(query: string) {
  return query
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeSqlIdentifier(identifier: string) {
  return identifier.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase();
}

type SqlAstNode = {
  as?: string | null;
  columns?: unknown;
  db?: string | null;
  from?: SqlAstNode[] | null;
  limit?: { value?: Array<{ type?: string; value?: unknown }> } | null;
  name?: { value?: string } | string;
  stmt?: SqlAstNode;
  table?: string | null;
  type?: string;
  with?: SqlAstNode[] | null;
};

function parseSqlQuery(query: string): { ast: SqlAstNode | SqlAstNode[]; ok: true } | { message: string; ok: false } {
  try {
    return { ast: sqlParser.astify(query, { database: "postgresql" }) as SqlAstNode | SqlAstNode[], ok: true };
  } catch (error) {
    return {
      message: `SQL 문법 오류입니다. ${getParserErrorHint(error)}`,
      ok: false,
    };
  }
}

function getParserErrorHint(error: unknown) {
  if (isParserSyntaxError(error)) {
    const found = error.found ? ` "${error.found}"` : "";
    return `${error.location.start.line}:${error.location.start.column} 위치의${found} 토큰을 확인해 주세요.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("but") && message.includes("found")) {
    return message.replace(/\s+/g, " ");
  }
  return "문장을 확인해 주세요.";
}

function isParserSyntaxError(error: unknown): error is { found?: string; location: { start: { column: number; line: number } } } {
  return typeof error === "object"
    && error !== null
    && "location" in error
    && typeof (error as { location?: { start?: { column?: unknown; line?: unknown } } }).location?.start?.line === "number"
    && typeof (error as { location?: { start?: { column?: unknown; line?: unknown } } }).location?.start?.column === "number";
}

function isSelectStatement(statement: SqlAstNode) {
  return statement.type === "select";
}

function findLimitIssue(statement: SqlAstNode) {
  const limitValues = statement.limit?.value ?? [];
  const invalidLimit = limitValues.find((item) => item.type !== "number" || !Number.isFinite(Number(item.value)));
  return invalidLimit ? "LIMIT에는 숫자만 입력할 수 있습니다." : null;
}

function extractCteNames(statement: SqlAstNode) {
  const cteNames = new Set<string>();
  statement.with?.forEach((cte) => {
    const cteName = typeof cte.name === "string" ? cte.name : cte.name?.value;
    if (cteName) cteNames.add(normalizeSqlIdentifier(cteName));
  });
  return cteNames;
}

function extractReferencedTableNames(statement: SqlAstNode) {
  const tableNames = new Set<string>();
  const collectFromStatement = (node: SqlAstNode) => {
    node.from?.forEach((fromItem) => {
      if (fromItem.table) {
        const qualifiedName = fromItem.db ? `${fromItem.db}.${fromItem.table}` : fromItem.table;
        tableNames.add(normalizeSqlIdentifier(qualifiedName));
      }
    });
    node.with?.forEach((cte) => {
      if (cte.stmt) collectFromStatement(cte.stmt);
    });
  };
  collectFromStatement(statement);
  return Array.from(tableNames);
}

function extractTableAliases(statement: SqlAstNode) {
  const aliases = new Set<string>();
  const collectFromStatement = (node: SqlAstNode) => {
    node.from?.forEach((fromItem) => {
      if (fromItem.as) aliases.add(fromItem.as);
    });
    node.with?.forEach((cte) => {
      if (cte.stmt) collectFromStatement(cte.stmt);
    });
  };
  collectFromStatement(statement);
  return Array.from(aliases);
}

const SQL_AUTOCOMPLETE_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
];

function getAutocompleteContext(query: string, cursorIndex: number): AutocompleteContext {
  const end = Math.max(0, Math.min(cursorIndex, query.length));
  const beforeCursor = query.slice(0, end);
  const tokenMatch = beforeCursor.match(/[a-zA-Z0-9_.-]*$/);
  const token = tokenMatch?.[0] ?? "";
  const start = end - token.length;
  const beforeToken = query.slice(0, start);
  const statementPrefix = beforeToken.split(";").pop() ?? "";
  const tableContext = /(?:^|[\s,(])(?:from|join)\s*$/i.test(statementPrefix);
  const columnContext = /(?:^|[\s,(])(?:select|where|on|having|and|or)\s*$/i.test(statementPrefix)
    || /\b(?:select|where|on|group\s+by|order\s+by|having)\b/i.test(statementPrefix);
  const mode = tableContext ? "table" : columnContext ? "column" : "general";
  return {
    token,
    start,
    end,
    mode,
    key: `${start}:${end}:${mode}:${token}`,
  };
}

function buildAutocompleteCandidates({
  baseDataset,
  context,
  datasets,
  referenceDatasetIdSet,
}: {
  baseDataset: CatalogDataset;
  context: AutocompleteContext;
  datasets: CatalogDataset[];
  referenceDatasetIdSet: Set<string>;
}) {
  const token = context.token.toLowerCase();
  if (!token && context.mode === "general") return [];
  const canShowForToken = (value: string) => !token || value.toLowerCase().includes(token);
  const contextDatasets = [
    baseDataset,
    ...datasets.filter((item) => referenceDatasetIdSet.has(item.id) && item.id !== baseDataset.id),
  ];
  const tableCandidates: AutocompleteCandidate[] = contextDatasets
    .filter((item) => canShowForToken(item.name))
    .sort((left, right) => getDatasetContextRank(left.id, baseDataset.id, referenceDatasetIdSet) - getDatasetContextRank(right.id, baseDataset.id, referenceDatasetIdSet))
    .map((item) => ({
      id: `table-${item.id}`,
      type: "table",
      label: item.name,
      insertText: item.name,
      detail: item.id === baseDataset.id ? "table · base" : referenceDatasetIdSet.has(item.id) ? "table · referenced" : "table",
      datasetId: item.id,
    }));
  const columnCandidates = contextDatasets.flatMap((item) => item.schema.flatMap(([name, type]) => {
    const candidates: AutocompleteCandidate[] = [];
    if (canShowForToken(name)) {
      candidates.push({
        id: `column-${item.id}-${name}`,
        type: "column",
        label: name,
        insertText: name,
        detail: `column · ${item.name} · ${type}`,
        datasetId: item.id,
      });
    }
    const qualifiedName = `${item.name}.${name}`;
    if (context.token.includes(".") && canShowForToken(qualifiedName)) {
      candidates.push({
        id: `column-qualified-${item.id}-${name}`,
        type: "column",
        label: qualifiedName,
        insertText: qualifiedName,
        detail: `column · ${type}`,
        datasetId: item.id,
      });
    }
    return candidates;
  }));
  const keywordCandidates: AutocompleteCandidate[] = SQL_AUTOCOMPLETE_KEYWORDS
    .filter((keyword) => canShowForToken(keyword))
    .map((keyword) => ({
      id: `keyword-${keyword}`,
      type: "keyword",
      label: keyword,
      insertText: `${keyword} `,
      detail: "keyword",
    }));
  const groups = context.mode === "table"
    ? [tableCandidates, columnCandidates, keywordCandidates]
    : context.mode === "column"
      ? [columnCandidates, tableCandidates, keywordCandidates]
      : [keywordCandidates, tableCandidates, columnCandidates];
  return groups.flat().slice(0, 8);
}

function getDatasetContextRank(datasetId: string, baseDatasetId: string, referenceDatasetIdSet: Set<string>) {
  if (datasetId === baseDatasetId) return 0;
  if (referenceDatasetIdSet.has(datasetId)) return 1;
  return 2;
}

function escapeCsvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
