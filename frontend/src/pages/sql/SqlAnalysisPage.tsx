import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  PlayCircle,
  RotateCcw,
  Search,
} from "lucide-react";
import { executeQueryDraft } from "../../services/mockApi";
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

export function SqlAnalysisPage({
  dataset,
  datasets,
  onAction,
  onResultChange,
}: {
  dataset: CatalogDataset;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
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
  const [openSchemaDatasetId, setOpenSchemaDatasetId] = useState<string | null>(dataset.id);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [showReferencedOnly, setShowReferencedOnly] = useState(false);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const referenceDatasetIdSet = useMemo(() => new Set(referenceDatasetIds), [referenceDatasetIds]);
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
    setOpenSchemaDatasetId(baseDataset.id);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset.id, defaultQuery]);

  const queryContextPath = () => {
    const params = new URLSearchParams({ baseDatasetId: baseDataset.id });
    referenceDatasetIds.forEach((id) => params.append("referenceDatasetIds", id));
    return `/api/query/runs?${params.toString()}`;
  };

  useEffect(() => {
    setAutocompleteIndex(0);
  }, [autocompleteCandidates.length, autocompleteContext.key]);

  const buildResultDraft = (): Promise<SqlResultDraft> => executeQueryDraft(baseDataset, query);

  const resetResultState = () => {
    setExecuted(false);
    setResultDraft(null);
    setExecutionMs(null);
    onResultChange(null);
  };

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
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

  const executeQuery = async () => {
    const startedAt = performance.now();
    setQueryPending(true);
    try {
      const resultDraft = await buildResultDraft();
      setExecuted(true);
      setExecutionMs(Math.round(performance.now() - startedAt));
      setResultDraft(resultDraft);
      onResultChange(resultDraft);
      onAction("analysis.query.executed", queryContextPath(), baseDataset.id);
    } catch {
      onAction("analysis.query.failed", queryContextPath(), baseDataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

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
          <article className={openSchemaDatasetId === baseDataset.id ? "sql-table-card active" : "sql-table-card"}>
            <div className="sql-table-card-main">
              <span>{baseDataset.layer}</span>
              <strong>{baseDataset.name}</strong>
              <small>{baseDataset.schema.length} columns · {baseDataset.owner}</small>
            </div>
            <div className="sql-table-card-actions two-actions">
              <button type="button" onClick={() => insertTableName(baseDataset)}>SQL에 삽입</button>
              <button type="button" onClick={() => toggleSchema(baseDataset)} aria-expanded={openSchemaDatasetId === baseDataset.id}>{openSchemaDatasetId === baseDataset.id ? "Schema 닫기" : "Schema"}</button>
            </div>
            {openSchemaDatasetId === baseDataset.id && (
              <SchemaColumnList dataset={baseDataset} onColumnClick={insertColumnName} />
            )}
          </article>
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
              <article
                className={[
                  "sql-table-card",
                  item.id === openSchemaDatasetId ? "active" : "",
                  referenceDatasetIdSet.has(item.id) ? "referenced" : "",
                ].filter(Boolean).join(" ")}
                key={item.id}
              >
                <div className="sql-table-card-main">
                  <span>{item.layer}</span>
                  <strong>{item.name}</strong>
                  <small>
                    {referenceDatasetIdSet.has(item.id) ? "referenced · " : ""}
                    {item.schema.slice(0, 3).map(([name]) => name).join(" · ")}
                  </small>
                </div>
                <div className="sql-table-card-actions">
                  <button type="button" onClick={() => changeBaseDataset(item)} disabled={item.id === baseDataset.id}>Base로 설정</button>
                  <button type="button" onClick={() => toggleReferenceDataset(item)}>
                    {referenceDatasetIdSet.has(item.id) ? "참조 해제" : "참조 추가"}
                  </button>
                  <button type="button" onClick={() => toggleSchema(item)} aria-expanded={openSchemaDatasetId === item.id}>{openSchemaDatasetId === item.id ? "Schema 닫기" : "Schema"}</button>
                </div>
                {openSchemaDatasetId === item.id && (
                  <SchemaColumnList dataset={item} onColumnClick={insertColumnName} />
                )}
              </article>
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
              <button className="primary-button" type="button" onClick={executeQuery} disabled={queryPending}><PlayCircle size={16} /> {queryPending ? "실행 중" : "실행"}</button>
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
            <span>Context: base + {referenceDatasetIds.length} referenced tables</span>
            <button className="secondary-button" type="button" onClick={resetQuery}><RotateCcw size={14} /> Reset SQL</button>
          </div>
        </section>

        <section className="sql-result-card">
          <div className="sql-result-header">
            <div>
              <span>QUERY RESULT</span>
              <h2>{resultDraft ? `${resultDraft.rowCount} rows returned` : "실행 후 결과가 표시됩니다"}</h2>
            </div>
            <div className="sql-result-status">
              <span>{queryPending ? "running" : executed ? "success" : "ready"}</span>
              {executionMs !== null && <span>{formatDuration(executionMs)}</span>}
            </div>
          </div>
          {resultDraft ? (
            <>
              <div className="sql-result-toolbar">
                <span>Run ID {resultDraft.runId}</span>
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
              <strong>아직 실행 결과가 없습니다.</strong>
              <span>SQL을 실행하면 이 영역에 결과 테이블이 표시됩니다.</span>
            </div>
          )}
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
  const tableCandidates: AutocompleteCandidate[] = datasets
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
  const contextDatasets = [
    baseDataset,
    ...datasets.filter((item) => referenceDatasetIdSet.has(item.id) && item.id !== baseDataset.id),
  ];
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
