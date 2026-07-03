import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  Check,
  CircleUser,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  Info,
  LayoutGrid,
  Maximize2,
  Minus,
  PlayCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Star,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TerminalSquare,
} from "lucide-react";
import { DatasetStatusBadge } from "../catalog/CatalogPage";
import { executeQueryDraft } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, SqlResultDraft } from "../../types";

export function SqlAnalysisPage({
  dataset,
  datasets,
  onAction,
  onDashboard,
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
  const relatedDatasets = useMemo(() => [dataset, ...datasets.filter((item) => item.id !== dataset.id).slice(0, 2)], [dataset, datasets]);
  const scopeDatasets = relatedDatasets.map((item, index) => ({ checked: index < 2, label: index === 0 ? "BASE" : "JOIN", name: item.name }));
  const schemaChips = dataset.schema.slice(0, 5).map(([name]) => name);
  const resultColumns = dataset.schema.slice(0, 6).map(([name]) => name);
  const resultRows = dataset.sampleRows.map((row) => row.slice(0, Math.max(resultColumns.length, 1)));
  const savedQueries = [
    ["Risk score Top 100", "product_health_gold", "성공", "방금 전"],
    ["Behavior join 검증", "silver_behavior_events", "성공", "2026-07-02 10:11"],
    ["Commerce orders 매핑", "commerce.orders", "성공", "2026-07-02 01:05"],
  ];
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
  }, [defaultQuery, dataset.id]);

  const buildResultDraft = (): Promise<SqlResultDraft> => executeQueryDraft(dataset, query);

  const executeQuery = async () => {
    setQueryPending(true);
    try {
      const resultDraft = await buildResultDraft();
      setExecuted(true);
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

  const createDashboard = async () => {
    setQueryPending(true);
    try {
      const resultDraft = await buildResultDraft();
      onResultChange(resultDraft);
      onDashboard(resultDraft);
    } catch {
      onAction("analysis.dashboard.create_failed", "/api/dashboards", dataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

  const openDatasetInQuery = (targetDataset: CatalogDataset) => {
    setQuery(`SELECT *\nFROM ${targetDataset.name}\nLIMIT 100;`);
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
        <section className="sql-mini-result">
          <h2>result table</h2>
          <div className="sql-mini-result-scroll">
            <table>
              <thead><tr>{resultColumns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
              <tbody>{resultRows.map((row, rowIndex) => <tr key={`mini-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
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
              <button className="secondary-button" type="button" onClick={() => onAction("analysis.query.saved", "/api/query/saved", dataset.id)}><Save size={15} /> 저장</button>
              <span><Check size={13} /> policy passed</span>
            </div>
          </div>
          <div className="sql-editor-layout">
            <div className="sql-editor-surface">
              <pre aria-hidden="true">1{`\n`}2{`\n`}3{`\n`}4{`\n`}5{`\n`}6{`\n`}7</pre>
              <textarea value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} />
            </div>
            <aside className="sql-preflight-panel">
              <div>
                <span>RUN PREFLIGHT</span>
                <strong>실행 전 확인</strong>
                <em>ready</em>
              </div>
              {[
                ["선택 데이터셋", `${scopeDatasets.filter((item) => item.checked).length} checked / ${relatedDatasets.length} queryable`],
                ["Join key", dataset.schema[0]?.[0] ? `${dataset.schema[0][0]} available` : "schema pending"],
                ["Scan", dataset.size === "Pending" ? "queued / limit 5GB" : `${dataset.size} / limit 5GB`],
                ["Locked source", "MongoDB 제외"],
              ].map(([label, value]) => (
                <p key={label}><Check size={14} /><span>{label}</span><strong>{value}</strong></p>
              ))}
            </aside>
          </div>
          <div className="sql-editor-footer">
            <span>SQL 실행 범위: {scopeDatasets.filter((item) => item.checked).length} checked datasets · {dataset.layer.toLowerCase()} / {dataset.name}</span>
            <button className="secondary-button" type="button" onClick={formatQuery}>Format SQL</button>
          </div>
        </section>

        <section className="sql-estimation-bar">
          <strong>Estimation</strong>
          <span>예상 14초 · 1.8GB scan · DuckDB adapter</span>
          <div><span style={{ width: "32%" }} /></div>
          <em>32%</em>
        </section>

        <section className="sql-result-card">
          <div className="sql-result-header">
            <div>
              <span>RESULT PREVIEW</span>
              <h2>100 rows returned</h2>
            </div>
            <div className="sql-result-status">
              <span>{queryPending ? "running" : executed ? "success" : "ready"}</span>
              <span>3.2s</span>
            </div>
            <div className="sql-result-actions">
              <button type="button" onClick={() => onAction("analysis.result.saved_to_lake", "/api/query/results/lake", dataset.id)}>Lake로 저장</button>
              <button type="button" onClick={() => onAction("analysis.result.opened_in_sheets", "/api/query/results/sheets", dataset.id)}>Sheets</button>
              <button type="button" onClick={() => onAction("analysis.result.downloaded", "/api/query/results/download", dataset.id)}>CSV</button>
              <button type="button" onClick={createDashboard}>대시보드 생성</button>
            </div>
          </div>
          <div className="sql-result-scroll">
            <table className="schema-table">
              <thead><tr>{resultColumns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
              <tbody>{resultRows.map((row, rowIndex) => <tr key={`result-${rowIndex}`}>{row.slice(0, resultColumns.length).map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </section>
      </main>

      <aside className="sql-history-panel">
        <section>
          <h2>최근 실행</h2>
          {savedQueries.map(([name, source, status, lastRun], index) => (
            <button key={`${name}-${index}`} type="button" onClick={() => {
              setQuery(`SELECT *\nFROM ${source}\nLIMIT 100;`);
              onAction("analysis.history.selected", "/api/query/history", source);
            }}>
              <strong>{name}</strong>
              <span>{source}</span>
              <small>{status} · {lastRun}</small>
            </button>
          ))}
        </section>
        <section>
          <h2>저장된 쿼리</h2>
          <button type="button" onClick={() => {
            setQuery("SELECT *\nFROM customer_orders_gold\nORDER BY order_count DESC\nLIMIT 100;");
            onAction("analysis.saved_query_opened", "/api/query/saved/customer-orders-top100", "customer_orders_gold");
          }}><FileText size={14} /> 고객 주문 Top 100</button>
          <button type="button" onClick={() => {
            setQuery(`SELECT sentiment, COUNT(*) AS review_count\nFROM ${dataset.name}\nGROUP BY sentiment;`);
            onAction("analysis.saved_query_opened", "/api/query/saved/review-sentiment", dataset.id);
          }}><FileText size={14} /> 리뷰 감성 분포</button>
        </section>
      </aside>
    </div>
  );
}
