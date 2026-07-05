import { useEffect, useState } from "react";
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
import { PageTitle } from "../../components/common";
import type { AuditResult, CatalogDataset } from "../../types";
import { datasetStatusMeta } from "../../utils/statusMeta";

export function CatalogPage({
  datasets,
  onAction,
  onDatasetOpen,
  onOpenSql,
  selectedDataset,
}: {
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDatasetOpen: (dataset: CatalogDataset) => void;
  onOpenSql: (dataset: CatalogDataset) => void;
  selectedDataset: CatalogDataset;
}) {
  const [previewDataset, setPreviewDataset] = useState<CatalogDataset>(selectedDataset);
  const hasDatasets = datasets.length > 0;
  const tags = ["#customer", "#sales", "#behavior", "#marketing", "#dw", "#growth", "#클릭", "#실시간", "#고객 주문", "#스트림", "#RAG", "#사용자 지표"];

  useEffect(() => {
    const nextPreview = datasets.find((dataset) => dataset.id === selectedDataset.id) ?? datasets[0] ?? selectedDataset;
    setPreviewDataset(nextPreview);
  }, [datasets, selectedDataset.id]);

  return (
    <div className="catalog-page">
      <div className="catalog-main">
        <PageTitle title="검색/카탈로그" description="테이블명, 컬럼명, 태그 또는 업무 키워드로 데이터셋을 검색합니다." />
        <section className="catalog-search-panel">
          <div className="catalog-search-box">
            <Search size={18} />
            <span>테이블명, 컬럼명, 태그 또는 업무 키워드로 검색하세요...</span>
            <kbd>Enter</kbd>
          </div>
          <div className="catalog-tag-row">
            <span>태그</span>
            <div>
              {tags.map((tag) => <button className="catalog-tag" key={tag} type="button" onClick={() => onAction("catalog.tag_filter_selected", `/api/catalog/search?tag=${encodeURIComponent(tag)}`, tag)}>{tag}</button>)}
            </div>
          </div>
        </section>

        <section className="catalog-results-section">
          <div className="catalog-results-header">
            <div>
              <h2>검색 결과</h2>
              <span>{datasets.length}건</span>
            </div>
            <div className="catalog-filter-row">
              {["사용 가능", "승인 필요", "RAG 여부"].map((filter) => (
                <label key={filter}>
                  <input type="checkbox" />
                  {filter}
                </label>
              ))}
              <button type="button" onClick={() => onAction("catalog.sort_opened", "/api/catalog/search/sort", "catalog-sort")}>정렬 기준 ▾</button>
            </div>
          </div>

          <div className="catalog-result-list">
            {!hasDatasets && (
              <div className="catalog-empty-state">
                <BookOpen size={22} />
                <strong>등록된 데이터셋이 없습니다.</strong>
                <p>수집/처리 작업을 실행해 Spark 적재가 성공하면 결과 데이터셋이 카탈로그에 추가됩니다.</p>
              </div>
            )}
            {datasets.map((dataset) => (
              <button
                className={dataset.id === previewDataset.id ? "catalog-result-card active" : "catalog-result-card"}
                key={dataset.id}
                type="button"
                onClick={() => setPreviewDataset(dataset)}
                onDoubleClick={() => onDatasetOpen(dataset)}
              >
                <div className="catalog-result-title">
                  <strong>{dataset.name}</strong>
                  <DatasetStatusBadge dataset={dataset} />
                </div>
                <p>{dataset.description}</p>
                <div className="catalog-result-tags">
                  {dataset.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
                  {dataset.tags.length > 2 && <span>+{dataset.tags.length - 2} {dataset.tags.slice(2).join(" ")}</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      <aside className="catalog-preview-panel">
        <div className="catalog-preview-title">
          <LayoutGrid size={20} />
          <div>
            <h2>{previewDataset.name}</h2>
            <p>{previewDataset.description}</p>
          </div>
          <Star size={18} />
        </div>

        <div className="catalog-preview-metrics">
          <CatalogMiniMetric label="품질 지표" value={previewDataset.quality} />
          <CatalogMiniMetric label="최근 갱신 일시" value={previewDataset.lastUpdated} />
          <CatalogMiniMetric label="데이터 담당자" value={previewDataset.owner} />
          <CatalogMiniMetric label="행 수" value={previewDataset.rows} />
          <CatalogMiniMetric label="파일 크기" value={previewDataset.size} />
          <CatalogMiniMetric label="갱신 예정 일시" value={previewDataset.nextRefresh} />
        </div>

        <article className="catalog-preview-card">
          <div className="catalog-preview-card-header">
            <TerminalSquare size={16} />
            <h3>스키마 미리보기</h3>
            <span>{previewDataset.schema.length} 컬럼</span>
          </div>
          <table className="catalog-schema-preview">
            <thead>
              <tr><th>Column Name</th><th>Type</th></tr>
            </thead>
            <tbody>
              {previewDataset.schema.slice(0, 5).map(([name, type], index) => <tr key={`${name}-${index}`}><td>{name}</td><td><span>{type}</span></td></tr>)}
              {previewDataset.schema.length === 0 && <tr><td colSpan={2}>생성된 스키마가 없습니다.</td></tr>}
            </tbody>
          </table>
          <button className="catalog-text-button" type="button" disabled={!hasDatasets} onClick={() => onDatasetOpen(previewDataset)}>전체 스키마 상세 보기</button>
        </article>

        <article className="catalog-lineage-teaser" role="button" tabIndex={hasDatasets ? 0 : -1} onClick={() => {
          if (!hasDatasets) return;
          onAction("catalog.lineage.opened", `/api/catalog/datasets/${previewDataset.id}/lineage`, previewDataset.id);
          onDatasetOpen(previewDataset);
        }} aria-disabled={!hasDatasets}>
          <ExternalLink size={16} />
          <div>
            <strong>데이터 흐름도 확인</strong>
            <span>Upstream {previewDataset.upstream.length} / Downstream {previewDataset.downstream.length}</span>
          </div>
          <span>›</span>
        </article>

        <button className="primary-button catalog-wide-button" type="button" disabled={!hasDatasets} onClick={() => onOpenSql(previewDataset)}>
          <ExternalLink size={16} /> 쿼리 편집기에서 열기
        </button>
        <button className="secondary-button catalog-wide-button" type="button" disabled={!hasDatasets} onClick={() => onAction("catalog.dataset.saved", `/api/catalog/datasets/${previewDataset.id}/saved`, previewDataset.id)}>내 저장소 보관</button>
        <p className="catalog-help-text">문제가 있나요? 데이터 카탈로그 가이드를 확인하세요.</p>
      </aside>
    </div>
  );
}

export function CatalogDetailPage({
  dataset,
  onAction,
  onBack,
  onCreateDashboard,
  onLineage,
  onOpenSql,
}: {
  dataset: CatalogDataset;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCreateDashboard: () => void;
  onLineage: () => void;
  onOpenSql: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "schema" | "sample" | "lineage">("overview");

  const openLineage = () => {
    setActiveTab("lineage");
    onLineage();
  };

  return (
    <div className="catalog-detail-page">
      <header className="catalog-detail-header">
        <button className="job-detail-breadcrumb" type="button" onClick={onBack}>검색/카탈로그 &gt; {dataset.name}</button>
        <div className="catalog-detail-title-row">
          <div>
            <h1>{dataset.name}</h1>
            <div className="job-detail-meta">
              <DatasetStatusBadge dataset={dataset} />
              <span className="owner-chip">{dataset.owner}</span>
              <span className="tag-chip">{dataset.layer} LAYER</span>
              {dataset.tags.slice(0, 2).map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}
            </div>
          </div>
          <div className="job-detail-actions">
            <button className="job-action-button primary" type="button" onClick={onOpenSql}><ExternalLink size={14} /> SQL 분석에서 열기</button>
            <button className="job-action-button primary soft" type="button" onClick={onCreateDashboard}><BarChart3 size={14} /> 대시보드 만들기</button>
            <button className="job-action-button" type="button" onClick={openLineage}>리니지 보기</button>
            <button className="job-action-button" type="button" onClick={() => onAction("catalog.dataset.refreshed", `/api/catalog/datasets/${dataset.id}`, dataset.id)}>새로고침</button>
          </div>
        </div>
        <nav className="job-detail-tabs" aria-label="데이터셋 상세 탭">
          {[
            ["overview", "개요"],
            ["schema", "스키마"],
            ["sample", "샘플 데이터"],
            ["lineage", "리니지"],
          ].map(([id, label]) => (
            <button className={activeTab === id ? "active" : ""} key={id} type="button" onClick={() => {
              if (id === "lineage") onLineage();
              setActiveTab(id as typeof activeTab);
            }}>{label}</button>
          ))}
        </nav>
      </header>

      {activeTab === "overview" && <CatalogOverview dataset={dataset} onLineage={openLineage} />}
      {activeTab === "schema" && <CatalogSchema dataset={dataset} />}
      {activeTab === "sample" && <CatalogSample dataset={dataset} />}
      {activeTab === "lineage" && <CatalogLineage dataset={dataset} />}
    </div>
  );
}

export function DatasetStatusBadge({ dataset }: { dataset: CatalogDataset }) {
  const statusMeta = datasetStatusMeta[dataset.status];
  const statusClass = dataset.status === "approval_required" ? statusMeta.className : dataset.freshness === "stale" ? "stale" : statusMeta.className;

  return (
    <span className={`dataset-status-badge ${statusClass}`}>
      {dataset.rag && <span>RAG</span>}
      {statusMeta.label}
    </span>
  );
}

function CatalogMiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="catalog-mini-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CatalogOverview({ dataset, onLineage }: { dataset: CatalogDataset; onLineage: () => void }) {
  return (
    <div className="catalog-detail-grid">
      <section className="catalog-overview-card">
        <h2>데이터셋 개요</h2>
        <p>{dataset.description}</p>
        <div className="catalog-overview-metrics">
          <CatalogMiniMetric label="품질 지표" value={dataset.quality} />
          <CatalogMiniMetric label="최근 갱신" value={dataset.lastUpdated} />
          <CatalogMiniMetric label="행 수" value={dataset.rows} />
          <CatalogMiniMetric label="크기" value={dataset.size} />
          <CatalogMiniMetric label="Source" value={dataset.source} />
          <CatalogMiniMetric label="다음 갱신" value={dataset.nextRefresh} />
        </div>
      </section>
      <section className="catalog-overview-card">
        <h2>연결된 흐름</h2>
        <CatalogLineageMini dataset={dataset} />
        <button className="catalog-text-button" type="button" onClick={onLineage}>전체 리니지 보기</button>
      </section>
    </div>
  );
}

function CatalogSchema({ dataset }: { dataset: CatalogDataset }) {
  return (
    <section className="catalog-table-card">
      <div className="catalog-section-header">
        <h2>스키마</h2>
        <span>{dataset.schema.length} 컬럼</span>
      </div>
      <table className="schema-table">
        <thead><tr><th>Column Name</th><th>Type</th><th>Nullable</th><th>설명</th></tr></thead>
        <tbody>
          {dataset.schema.map(([name, type], index) => (
            <tr key={`${name}-${index}`}><td>{name}</td><td>{type}</td><td>{index % 2 === 0 ? "NO" : "YES"}</td><td>{dataset.name}의 {name} 필드</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CatalogSample({ dataset }: { dataset: CatalogDataset }) {
  const columns = dataset.schema.slice(0, 5).map(([name]) => name);
  return (
    <section className="catalog-table-card">
      <div className="catalog-section-header">
        <h2>샘플 데이터</h2>
        <span>read only preview</span>
      </div>
      <div className="catalog-sample-scroll">
        <table className="schema-table">
          <thead><tr>{columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
          <tbody>{dataset.sampleRows.map((row, rowIndex) => <tr key={`sample-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function CatalogLineage({ dataset }: { dataset: CatalogDataset }) {
  return (
    <section className="catalog-lineage-card">
      <div className="catalog-section-header">
        <h2>{dataset.name}</h2>
        <span>DATA LINEAGE</span>
      </div>
      <div className="catalog-lineage-scroll">
        <div className="catalog-lineage-graph">
          <div className="lineage-column">
            <span>Upstream</span>
            {dataset.upstream.map((item) => <LineageNode key={item} label={item} tone="source" />)}
          </div>
          <div className="lineage-connector" />
          <div className="lineage-column current">
            <span>{dataset.layer} LAYER</span>
            <LineageNode label={dataset.name} tone="current" />
          </div>
          <div className="lineage-connector" />
          <div className="lineage-column">
            <span>Downstream</span>
            {dataset.downstream.map((item) => <LineageNode key={item} label={item} tone="downstream" />)}
          </div>
        </div>
      </div>
      <div className="catalog-lineage-footer">
        <span>Upstream {dataset.upstream.length}</span>
        <span>Layer {dataset.layer}</span>
        <span>Status {datasetStatusMeta[dataset.status].label}</span>
      </div>
    </section>
  );
}

function CatalogLineageMini({ dataset }: { dataset: CatalogDataset }) {
  return (
    <div className="catalog-lineage-mini">
      <div>{dataset.upstream.map((item) => <span key={item}>{item}</span>)}</div>
      <strong>{dataset.name}</strong>
      <div>{dataset.downstream.slice(0, 2).map((item) => <span key={item}>{item}</span>)}</div>
    </div>
  );
}

function LineageNode({ label, tone }: { label: string; tone: "source" | "current" | "downstream" }) {
  return (
    <article className={`lineage-node ${tone}`}>
      <Database size={16} />
      <span>{label}</span>
    </article>
  );
}
