import { useEffect, useMemo, useState } from "react";
import {
  Check,
  PlayCircle,
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
  onDashboard: (result: SqlResultDraft) => void;
  onResultChange: (result: SqlResultDraft) => void;
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
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const relatedDatasets = useMemo(() => [dataset, ...datasets.filter((item) => item.id !== dataset.id).slice(0, 2)], [dataset, datasets]);
  const scopeDatasets = relatedDatasets.map((item, index) => ({ checked: index < 2, label: index === 0 ? "BASE" : "JOIN", name: item.name }));
  const schemaChips = dataset.schema.slice(0, 5).map(([name]) => name);
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

  useEffect(() => {
    setExecuted(false);
    setQuery(defaultQuery);
    setResultDraft(null);
  }, [defaultQuery, dataset.id]);

  const buildResultDraft = (): Promise<SqlResultDraft> => executeQueryDraft(dataset, query);

  const executeQuery = async () => {
    setQueryPending(true);
    try {
      const resultDraft = await buildResultDraft();
      setExecuted(true);
      setResultDraft(resultDraft);
      onResultChange(resultDraft);
      onAction("analysis.query.executed", `/api/query/runs`, dataset.id);
    } catch {
      onAction("analysis.query.failed", `/api/query/runs`, dataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

  const formatQuery = () => {
    setQuery(defaultQuery);
    onAction("analysis.query.formatted", "/api/query/format", dataset.id);
  };

  const toggleContext = () => {
    const nextCollapsed = !contextCollapsed;
    setContextCollapsed(nextCollapsed);
    onAction(nextCollapsed ? "analysis.context.collapsed" : "analysis.context.expanded", "/api/query/context", dataset.id);
  };

  const openDatasetInQuery = (targetDataset: CatalogDataset) => {
    setQuery(`SELECT *\nFROM ${targetDataset.name}\nLIMIT 100;`);
    setExecuted(false);
    setResultDraft(null);
    onAction("analysis.context.dataset_selected", `/api/query/context/datasets/${targetDataset.id}`, targetDataset.id);
  };

  return (
    <div className={contextCollapsed ? "sql-page context-collapsed" : "sql-page"}>
      <aside className="sql-dataset-panel" aria-hidden={contextCollapsed}>
        <div className="sql-panel-header">
          <span>SQL CONTEXT</span>
          <div>
            <strong>선택 데이터셋</strong>
          <em>{scopeDatasets.filter((item) => item.checked).length} checked</em>
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
          <h2>dataset search</h2>
          <div>
            {filteredDatasets.map((item) => (
              <button key={item.id} type="button" onClick={() => openDatasetInQuery(item)}>
                <span>{item.layer}</span>
                <strong>{item.name}</strong>
                <small>{item.schema.slice(0, 3).map(([name]) => name).join(" · ")}</small>
              </button>
            ))}
            {filteredDatasets.length === 0 && <p>검색 결과가 없습니다.</p>}
          </div>
        </section>
        <div className="sql-selected-list">
          {scopeDatasets.map((item) => (
            <article className={item.checked ? "sql-selected-item active" : "sql-selected-item"} key={item.name}>
              <span>{item.label}</span>
              <strong>{item.name}</strong>
              <i className={item.checked ? "sql-checkmark checked" : "sql-checkmark"} aria-label={item.checked ? "checked" : "unchecked"} />
            </article>
          ))}
        </div>
        <section className="sql-schema-panel chip-mode">
          <h2>schema</h2>
          <div>
            {schemaChips.map((name, index) => (
              <button key={`${name}-${index}`} type="button" onClick={() => setQuery(`${query.replace(/;$/, "")}\n-- ${name};`)}>
                {name}
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
              <span><Check size={13} /> policy passed</span>
            </div>
          </div>
          <div className="sql-editor-layout">
            <div className="sql-editor-surface">
              <pre aria-hidden="true">1{`\n`}2{`\n`}3{`\n`}4{`\n`}5{`\n`}6{`\n`}7</pre>
              <textarea value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} />
            </div>
          </div>
          <div className="sql-editor-footer">
            <span>SQL 실행 범위: {scopeDatasets.filter((item) => item.checked).length} checked datasets · {dataset.layer.toLowerCase()} / {dataset.name}</span>
            <button className="secondary-button" type="button" onClick={formatQuery}>Format SQL</button>
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
            </div>
          </div>
          {resultDraft ? (
            <div className="sql-result-scroll">
              <table className="schema-table">
                <thead><tr>{resultDraft.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
                <tbody>{resultDraft.rows.map((row, rowIndex) => <tr key={`result-${rowIndex}`}>{row.slice(0, resultDraft.columns.length).map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
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
