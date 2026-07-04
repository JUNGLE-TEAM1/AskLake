import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  PlayCircle,
  RotateCcw,
  Search,
} from "lucide-react";
import { DatasetStatusBadge } from "../catalog/CatalogPage";
import { executeQueryDraft } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, SqlResultDraft } from "../../types";

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
  const defaultQuery = useMemo(() => {
    const columns = dataset.schema.slice(0, 4).map(([name]) => name).join(", ") || "*";
    return `SELECT ${columns}
FROM ${dataset.name}
LIMIT 100;`;
  }, [dataset.name, dataset.schema]);
  const [executed, setExecuted] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [datasetSearch, setDatasetSearch] = useState("");
  const [activeSchemaDatasetId, setActiveSchemaDatasetId] = useState(dataset.id);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const filteredDatasets = useMemo(() => {
    const keyword = datasetSearch.trim().toLowerCase();
    const searchableDatasets = keyword
      ? datasets.filter((item) => {
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
      : datasets;

    return searchableDatasets.slice(0, 4);
  }, [datasetSearch, datasets]);
  const activeSchemaDataset = useMemo(
    () => datasets.find((item) => item.id === activeSchemaDatasetId) ?? dataset,
    [activeSchemaDatasetId, dataset, datasets],
  );
  const tableCompletion = useMemo(() => getTableCompletion(query, datasets), [datasets, query]);

  useEffect(() => {
    setExecuted(false);
    setQuery(defaultQuery);
    setResultDraft(null);
    setExecutionMs(null);
    setActiveSchemaDatasetId(dataset.id);
    onResultChange(null);
  }, [defaultQuery, dataset.id]);

  const buildResultDraft = (): Promise<SqlResultDraft> => executeQueryDraft(dataset, query);

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

  const executeQuery = async () => {
    const startedAt = performance.now();
    setQueryPending(true);
    try {
      const resultDraft = await buildResultDraft();
      setExecuted(true);
      setExecutionMs(Math.round(performance.now() - startedAt));
      setResultDraft(resultDraft);
      onResultChange(resultDraft);
      onAction("analysis.query.executed", `/api/query/runs`, dataset.id);
    } catch {
      onAction("analysis.query.failed", `/api/query/runs`, dataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

  const resetQuery = () => {
    updateQuery(defaultQuery);
    onAction("analysis.query.reset", "/api/query/reset", dataset.id);
  };

  const toggleContext = () => {
    const nextCollapsed = !contextCollapsed;
    setContextCollapsed(nextCollapsed);
    onAction(nextCollapsed ? "analysis.context.collapsed" : "analysis.context.expanded", "/api/query/context", dataset.id);
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
    updateQuery(nextQuery);
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = selectionStart + text.length;
      textarea.setSelectionRange(caret, caret);
    });
  };

  const insertTableName = (targetDataset: CatalogDataset) => {
    const completedQuery = applyTableCompletion(query, targetDataset.name);
    if (completedQuery !== query) {
      updateQuery(completedQuery);
    } else {
      insertSqlText(targetDataset.name);
    }
    setActiveSchemaDatasetId(targetDataset.id);
    onAction("analysis.context.dataset_inserted", `/api/query/context/datasets/${targetDataset.id}`, targetDataset.id);
  };

  const insertColumnName = (columnName: string) => {
    insertSqlText(columnName);
    onAction("analysis.context.column_inserted", `/api/query/context/datasets/${activeSchemaDataset.id}/columns/${columnName}`, activeSchemaDataset.id);
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
          <h2>base table</h2>
          <button type="button" onClick={() => setActiveSchemaDatasetId(dataset.id)}>
            <span>{dataset.layer}</span>
            <strong>{dataset.name}</strong>
            <small>{dataset.schema.length} columns · {dataset.owner}</small>
          </button>
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
          <h2>table search</h2>
          <div>
            {filteredDatasets.map((item) => (
              <article className={item.id === activeSchemaDataset.id ? "sql-table-card active" : "sql-table-card"} key={item.id}>
                <button className="sql-table-card-main" type="button" onClick={() => insertTableName(item)}>
                  <span>{item.layer}</span>
                  <strong>{item.name}</strong>
                  <small>{item.schema.slice(0, 3).map(([name]) => name).join(" · ")}</small>
                </button>
                <button className="sql-inline-action" type="button" onClick={() => setActiveSchemaDatasetId(item.id)}>스키마</button>
              </article>
            ))}
            {filteredDatasets.length === 0 && <p>검색 결과가 없습니다.</p>}
          </div>
        </section>
        <section className="sql-schema-panel chip-mode">
          <h2>{activeSchemaDataset.name} schema</h2>
          <div>
            {activeSchemaDataset.schema.map(([name, type], index) => (
              <button key={`${name}-${index}`} type="button" onClick={() => insertColumnName(name)}>
                {name}<span>{type}</span>
              </button>
            ))}
          </div>
        </section>
        <div className="sql-context-source">
          <span>선택 데이터셋</span>
          <strong>{dataset.name}</strong>
          <DatasetStatusBadge dataset={dataset} />
        </div>
      </aside>

      <button className="sql-collapse-button" type="button" onClick={toggleContext} aria-label={contextCollapsed ? "SQL context 펼치기" : "SQL context 접기"}>
        {contextCollapsed ? "›" : "‹"}
      </button>

      <main className="sql-workspace">
        <header className="sql-page-header">
          <span>Analyze / Dataset-scoped SQL</span>
          <h1>읽기 전용 SQL 실행</h1>
          <p>{dataset.name} 데이터셋 범위에서 쿼리를 작성하고 결과를 저장/내보냅니다.</p>
        </header>

        <section className="sql-editor-card">
          <div className="sql-editor-header">
            <div>
              <span>QUERY EDITOR</span>
              <h2>선택 데이터셋 기준 SQL</h2>
            </div>
            <div className="sql-editor-actions">
              <button className="primary-button" type="button" onClick={executeQuery} disabled={queryPending}><PlayCircle size={16} /> {queryPending ? "실행 중" : "실행"}</button>
            </div>
          </div>
          <div className="sql-editor-layout">
            <div className="sql-editor-surface">
              <pre aria-hidden="true">1{`\n`}2{`\n`}3{`\n`}4{`\n`}5{`\n`}6{`\n`}7</pre>
              <textarea ref={textareaRef} value={query} onChange={(event) => updateQuery(event.target.value)} spellCheck={false} />
            </div>
            {tableCompletion && (
              <div className="sql-table-completion">
                <span>{tableCompletion.keyword ? `"${tableCompletion.keyword}" 후보` : "테이블 후보"}</span>
                <div>
                  {tableCompletion.candidates.map((item) => (
                    <button key={item.id} type="button" onClick={() => insertTableName(item)}>
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="sql-editor-footer">
            <span>접근 가능한 테이블을 검색하거나 `FROM` 뒤에 입력하면 후보가 표시됩니다.</span>
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

function getTableCompletion(query: string, datasets: CatalogDataset[]) {
  const match = query.match(/(?:^|\s)(?:from|join)\s+([a-zA-Z0-9_.-]*)$/i);
  if (!match) return null;
  const keyword = match[1] ?? "";
  const normalizedKeyword = keyword.toLowerCase();
  const candidates = datasets
    .filter((item) => item.name.toLowerCase().includes(normalizedKeyword))
    .slice(0, 5);
  return candidates.length > 0 ? { candidates, keyword } : null;
}

function applyTableCompletion(query: string, tableName: string) {
  return query.replace(/((?:^|\s)(?:from|join)\s+)([a-zA-Z0-9_.-]*)$/i, `$1${tableName}`);
}

function escapeCsvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
