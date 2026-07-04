import { useEffect, useState } from "react";
import type React from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  Check,
  CircleUser,
  Clock3,
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

type LineageColumn = {
  baseId: string;
  id: string;
  name: string;
  type: string;
};

type LineageTableNodeData = Record<string, unknown> & {
  columns: LineageColumn[];
  engine: string;
  handleMode: "source" | "target" | "both";
  layerLabel: string;
  onColumnSelect: (columnId: string) => void;
  selectedColumnId: string;
  tableName: string;
  tone: "source" | "bronze" | "silver" | "gold" | "downstream";
};

const lineageNodeTypes = {
  lineageTable: LineageTableNode,
};

const lineageNodeWidth = 306;
const lineageNodeHeaderHeight = 90;
const lineageColumnRowHeight = 46;
const lineageGroupGap = 36;

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
  const [activeModal, setActiveModal] = useState<"lineage" | "schema" | null>(null);
  const tags = ["#customer", "#sales", "#behavior", "#marketing", "#dw", "#growth", "#클릭", "#실시간", "#고객 주문", "#스트림", "#RAG", "#사용자 지표"];

  useEffect(() => {
    const nextPreview = datasets.find((dataset) => dataset.id === selectedDataset.id) ?? datasets[0];
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
            </tbody>
          </table>
          <button className="catalog-text-button" type="button" onClick={() => {
            onAction("catalog.schema.modal_opened", `/api/catalog/datasets/${previewDataset.id}/schema`, previewDataset.id);
            setActiveModal("schema");
          }}>전체 스키마 상세 보기</button>
        </article>

        <article className="catalog-lineage-teaser" role="button" tabIndex={0} onClick={() => {
          onAction("catalog.lineage.opened", `/api/catalog/datasets/${previewDataset.id}/lineage`, previewDataset.id);
          setActiveModal("lineage");
        }} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onAction("catalog.lineage.opened", `/api/catalog/datasets/${previewDataset.id}/lineage`, previewDataset.id);
            setActiveModal("lineage");
          }
        }}>
          <ExternalLink size={16} />
          <div>
            <strong>데이터 흐름도 확인</strong>
            <span>Upstream {previewDataset.upstream.length} / Downstream {previewDataset.downstream.length}</span>
          </div>
          <span>›</span>
        </article>

        <button className="primary-button catalog-wide-button" type="button" onClick={() => onOpenSql(previewDataset)}>
          <ExternalLink size={16} /> 쿼리 편집기에서 열기
        </button>
        <button className="secondary-button catalog-wide-button" type="button" onClick={() => onAction("catalog.dataset.saved", `/api/catalog/datasets/${previewDataset.id}/saved`, previewDataset.id)}>내 저장소 보관</button>
        <p className="catalog-help-text">문제가 있나요? 데이터 카탈로그 가이드를 확인하세요.</p>
      </aside>
      {activeModal && (
        <CatalogModal
          dataset={previewDataset}
          onClose={() => setActiveModal(null)}
          title={activeModal === "schema" ? "전체 스키마" : "데이터 흐름도"}
        >
          {activeModal === "schema" ? <CatalogSchema dataset={previewDataset} /> : <CatalogLineage dataset={previewDataset} />}
        </CatalogModal>
      )}
    </div>
  );
}

function CatalogModal({
  children,
  dataset,
  onClose,
  title,
}: {
  children: React.ReactNode;
  dataset: CatalogDataset;
  onClose: () => void;
  title: string;
}) {
  return (
    <div className="catalog-modal-backdrop" role="presentation" onClick={onClose}>
      <section className="catalog-modal" role="dialog" aria-modal="true" aria-label={`${dataset.name} ${title}`} onClick={(event) => event.stopPropagation()}>
        <header className="catalog-modal-header">
          <div>
            <span>{dataset.layer} Dataset</span>
            <h2>{dataset.name}</h2>
            <p>{title}</p>
          </div>
          <button type="button" onClick={onClose}>닫기</button>
        </header>
        <div className="catalog-modal-body">
          {children}
        </div>
      </section>
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
  const defaultColumnId = normalizeLineageId(dataset.schema[0]?.[0] ?? "column");
  const [selectedColumnId, setSelectedColumnId] = useState(defaultColumnId);
  const { edges, nodes } = buildLineageGraph(dataset, selectedColumnId, setSelectedColumnId);
  const statusMeta = datasetStatusMeta[dataset.status];

  useEffect(() => {
    setSelectedColumnId(defaultColumnId);
  }, [defaultColumnId, dataset.id]);

  return (
    <section className="catalog-lineage-card">
      <div className="catalog-lineage-title">
        <div className="lineage-title-icon"><LayoutGrid size={22} /></div>
        <div>
          <h2>{dataset.name}</h2>
          <span>DATA LINEAGE</span>
        </div>
      </div>
      <div className="catalog-lineage-flow" aria-label={`${dataset.name} lineage graph`}>
        <ReactFlow
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          maxZoom={1.1}
          minZoom={0.35}
          nodes={nodes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodeTypes={lineageNodeTypes}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#d5dde8" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="catalog-lineage-footer">
        <span>Upstream <strong>{dataset.upstream.length} Datasets</strong></span>
        <span>Layer <strong>{dataset.layer}</strong></span>
        <span>Status <strong>{statusMeta.label}</strong></span>
      </div>
    </section>
  );
}

function buildLineageGraph(
  dataset: CatalogDataset,
  selectedColumnId: string,
  onColumnSelect: (columnId: string) => void,
): { edges: Edge[]; nodes: Node[] } {
  const primaryColumns = buildLineageColumns(dataset.schema);
  const upstreamHeight = getLineageStackHeight(dataset.upstream.length, primaryColumns.length);
  const currentHeight = getLineageTableHeight(primaryColumns.length);
  const downstreamHeight = getLineageStackHeight(dataset.downstream.length, primaryColumns.length);
  const graphHeight = Math.max(upstreamHeight, currentHeight, downstreamHeight);
  const upstreamStartY = (graphHeight - upstreamHeight) / 2;
  const currentY = (graphHeight - currentHeight) / 2;
  const downstreamStartY = (graphHeight - downstreamHeight) / 2;
  const sourceX = 40;
  const currentX = 450;
  const downstreamX = 860;

  const upstreamNodes: Node<LineageTableNodeData>[] = dataset.upstream.map((item, index) => {
    const sourceMeta = getLineageSourceMeta(item, dataset.layer, index);
    return {
      data: {
        columns: buildSourceColumns(primaryColumns, item, index),
        engine: sourceMeta.engine,
        handleMode: "source",
        layerLabel: sourceMeta.layerLabel,
        onColumnSelect,
        selectedColumnId,
        tableName: getLineageTableName(item),
        tone: sourceMeta.tone,
      },
      id: `upstream-${index}`,
      position: { x: sourceX, y: upstreamStartY + getLineageStackOffset(index, primaryColumns.length) },
      type: "lineageTable",
    };
  });
  const currentNode: Node<LineageTableNodeData> = {
    data: {
      columns: primaryColumns,
      engine: "ICEBERG",
      handleMode: "both",
      layerLabel: `${dataset.layer} LAYER`,
      onColumnSelect,
      selectedColumnId,
      tableName: dataset.name,
      tone: getLayerTone(dataset.layer),
    },
    id: "current-dataset",
    position: { x: currentX, y: currentY },
    type: "lineageTable",
  };
  const downstreamNodes: Node<LineageTableNodeData>[] = dataset.downstream.map((item, index) => ({
    data: {
      columns: primaryColumns,
      engine: getDownstreamEngine(item),
      handleMode: "target",
      layerLabel: "CONSUMER",
      onColumnSelect,
      selectedColumnId,
      tableName: getLineageTableName(item),
      tone: "downstream",
    },
    id: `downstream-${index}`,
    position: { x: downstreamX, y: downstreamStartY + getLineageStackOffset(index, primaryColumns.length) },
    type: "lineageTable",
  }));
  const upstreamEdges = upstreamNodes.flatMap((node) => {
    const sourceColumns = node.data.columns as LineageColumn[];
    return primaryColumns.map((targetColumn, columnIndex) => {
      const sourceColumn = sourceColumns[columnIndex % sourceColumns.length];
      return buildColumnEdge({
        active: targetColumn.baseId === selectedColumnId,
        id: `${node.id}-${sourceColumn.id}-to-current-${targetColumn.id}`,
        source: node.id,
        sourceHandle: lineageHandleId(sourceColumn.id, "right"),
        target: currentNode.id,
        targetHandle: lineageHandleId(targetColumn.id, "left"),
      });
    });
  });
  const downstreamEdges = downstreamNodes.flatMap((node) => {
    const targetColumns = node.data.columns as LineageColumn[];
    return primaryColumns.map((sourceColumn, columnIndex) => {
      const targetColumn = targetColumns[columnIndex % targetColumns.length];
      return buildColumnEdge({
        active: sourceColumn.baseId === selectedColumnId,
        id: `current-${sourceColumn.id}-to-${node.id}-${targetColumn.id}`,
        source: currentNode.id,
        sourceHandle: lineageHandleId(sourceColumn.id, "right"),
        target: node.id,
        targetHandle: lineageHandleId(targetColumn.id, "left"),
      });
    });
  });

  return {
    edges: [...upstreamEdges, ...downstreamEdges],
    nodes: [...upstreamNodes, currentNode, ...downstreamNodes],
  };
}

function getLineageStackHeight(nodeCount: number, columnCount: number): number {
  if (nodeCount === 0) return 0;
  return nodeCount * getLineageTableHeight(columnCount) + (nodeCount - 1) * lineageGroupGap;
}

function getLineageStackOffset(index: number, columnCount: number): number {
  return index * (getLineageTableHeight(columnCount) + lineageGroupGap);
}

function getLineageTableHeight(columnCount: number): number {
  return lineageNodeHeaderHeight + columnCount * lineageColumnRowHeight + 16;
}

function LineageTableNode({ data }: { data: LineageTableNodeData }) {
  return (
    <article className={`lineage-table-node ${data.tone}`}>
      <header className="lineage-table-header">
        <div>
          <span>{data.layerLabel}</span>
          <strong><Table2 size={18} /> {data.tableName}</strong>
        </div>
        <em>{data.engine}</em>
      </header>
      <div className="lineage-table-columns">
        {data.columns.map((column) => (
          <button
            className={column.baseId === data.selectedColumnId ? "lineage-column-row active" : "lineage-column-row"}
            key={column.id}
            onClick={() => data.onColumnSelect(column.baseId)}
            type="button"
          >
            {(data.handleMode === "target" || data.handleMode === "both") && (
              <Handle
                className="lineage-column-handle left target-handle"
                id={lineageHandleId(column.id, "left")}
                position={Position.Left}
                type="target"
              />
            )}
            <span>{column.name}</span>
            <b className={`lineage-type-pill ${getColumnTypeTone(column.type)}`}>{column.type}</b>
            {(data.handleMode === "source" || data.handleMode === "both") && (
              <Handle
                className="lineage-column-handle right source-handle"
                id={lineageHandleId(column.id, "right")}
                position={Position.Right}
                type="source"
              />
            )}
          </button>
        ))}
      </div>
    </article>
  );
}

function buildColumnEdge({
  active,
  id,
  source,
  sourceHandle,
  target,
  targetHandle,
}: {
  active: boolean;
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}): Edge {
  return {
    animated: false,
    className: active ? "lineage-column-edge active" : "lineage-column-edge muted",
    id,
    markerEnd: { color: active ? "#2563eb" : "#94a3b8", type: MarkerType.ArrowClosed },
    source,
    sourceHandle,
    style: {
      stroke: active ? "#2563eb" : "#94a3b8",
      strokeWidth: active ? 2.4 : 1.5,
    },
    target,
    targetHandle,
    type: "smoothstep",
  };
}

function buildLineageColumns(schema: CatalogDataset["schema"]): LineageColumn[] {
  return schema.slice(0, 7).map(([name, type]) => ({
    baseId: normalizeLineageId(name),
    id: normalizeLineageId(name),
    name,
    type,
  }));
}

function buildSourceColumns(columns: LineageColumn[], sourceName: string, sourceIndex: number): LineageColumn[] {
  if (isRawSource(sourceName)) {
    return columns.map((column) => ({
      ...column,
      name: sourceIndex === 0 ? column.name : column.name.replace(/^order_/, "").replace(/^customer_/, "user_"),
      id: normalizeLineageId(`${sourceIndex}-${column.name}`),
    }));
  }

  return columns.map((column) => ({
    ...column,
    id: normalizeLineageId(`${sourceIndex}-${column.name}`),
  }));
}

function getLineageSourceMeta(
  sourceName: string,
  currentLayer: CatalogDataset["layer"],
  index: number,
): Pick<LineageTableNodeData, "engine" | "layerLabel" | "tone"> {
  const lower = sourceName.toLowerCase();
  if (lower.includes("postgres")) return { engine: "POSTGRESQL", layerLabel: "SOURCE", tone: "source" };
  if (lower.includes("kafka")) return { engine: "KAFKA", layerLabel: "SOURCE", tone: "source" };
  if (lower.includes("s3")) return { engine: "S3", layerLabel: "SOURCE", tone: "source" };
  if (lower.includes("raw")) return { engine: "LAKE", layerLabel: "RAW LAYER", tone: "source" };
  if (lower.includes("bronze") || (currentLayer === "SILVER" && index > 0)) return { engine: "ICEBERG", layerLabel: "BRONZE LAYER", tone: "bronze" };
  if (lower.includes("silver") || currentLayer === "GOLD") return { engine: "ICEBERG", layerLabel: "SILVER LAYER", tone: "silver" };
  return { engine: "PIPELINE", layerLabel: "BRONZE LAYER", tone: "bronze" };
}

function getLineageTableName(value: string): string {
  const parts = value.split(/[ /]/).filter(Boolean);
  return parts[parts.length - 1]?.replace(/\*\.csv$/, "events") ?? value;
}

function getLayerTone(layer: CatalogDataset["layer"]): LineageTableNodeData["tone"] {
  if (layer === "GOLD") return "gold";
  if (layer === "SILVER") return "silver";
  if (layer === "BRONZE") return "bronze";
  return "source";
}

function getDownstreamEngine(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("sql")) return "SQL";
  if (lower.includes("dashboard")) return "BI";
  if (lower.includes("ai")) return "AI";
  return "MART";
}

function getColumnTypeTone(type: string): string {
  const normalized = type.toLowerCase();
  if (["int", "integer", "bigint"].includes(normalized)) return "integer";
  if (["decimal", "double", "float", "number"].includes(normalized)) return "double";
  if (["timestamp", "date", "datetime"].includes(normalized)) return "timestamp";
  if (normalized.includes("json")) return "json";
  return "string";
}

function isRawSource(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("postgres") || lower.includes("kafka") || lower.includes("s3") || lower.includes("raw");
}

function lineageHandleId(columnId: string, position: "left" | "right"): string {
  return `${columnId}-${position}`;
}

function normalizeLineageId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "column";
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
