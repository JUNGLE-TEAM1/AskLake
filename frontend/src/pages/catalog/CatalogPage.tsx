import { useEffect, useState } from "react";
import type React from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useUpdateNodeInternals } from "@xyflow/react";
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
import { getDatasetLineageGraph } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, LineageGraph, LineageGraphDataset, LineageLayer } from "../../types";
import { datasetStatusMeta } from "../../utils/statusMeta";

type LineageColumn = {
  baseId: string;
  id: string;
  name: string;
  type: string;
};

type LineageTableNodeData = Record<string, unknown> & {
  activeColumnKey: string | null;
  columns: LineageColumn[];
  dimmed: boolean;
  engine: string;
  handleMode: "source" | "target" | "both";
  highlighted: boolean;
  layerLabel: string;
  nodeId: string;
  onColumnSelect: (columnKey: string | null) => void;
  relatedColumnKeys: string[] | null;
  tableName: string;
  tone: "source" | "bronze" | "silver" | "gold" | "downstream";
};

const lineageNodeTypes = {
  lineageTable: LineageTableNode,
};

const lineageNodeWidth = 220;
const lineageNodeHeaderHeight = 76;
const lineageColumnRowHeight = 32;
const lineageGroupGap = 44;

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
          {activeModal === "schema" ? <CatalogSchema dataset={previewDataset} /> : <CatalogLineage dataset={previewDataset} compact />}
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

function CatalogLineage({ compact = false, dataset }: { compact?: boolean; dataset: CatalogDataset }) {
  const [lineageGraph, setLineageGraph] = useState<LineageGraph | null>(dataset.lineageGraph ?? null);
  const [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
  const { edges, nodes } = lineageGraph
    ? buildLineageGraph(lineageGraph, selectedColumnKey, setSelectedColumnKey)
    : { edges: [], nodes: [] };
  const statusMeta = datasetStatusMeta[dataset.status];

  useEffect(() => {
    let isActive = true;
    setLineageGraph(dataset.lineageGraph ?? null);
    setSelectedColumnKey(null);
    getDatasetLineageGraph(dataset)
      .then((graph) => {
        if (isActive) setLineageGraph(graph);
      })
      .catch(() => {
        if (isActive) setLineageGraph(null);
      });

    return () => {
      isActive = false;
    };
  }, [dataset.id]);

  return (
    <section className={compact ? "catalog-lineage-card compact" : "catalog-lineage-card"}>
      {!compact && (
        <div className="catalog-lineage-title">
          <div className="lineage-title-icon"><LayoutGrid size={22} /></div>
          <div>
            <h2>{dataset.name}</h2>
            <span>DATA LINEAGE</span>
          </div>
        </div>
      )}
      {lineageGraph ? (
        <div className="catalog-lineage-flow" aria-label={`${dataset.name} lineage graph`}>
          <ReactFlow
            edges={edges}
            fitView
            fitViewOptions={{ maxZoom: 0.9, padding: 0.2 }}
            maxZoom={1}
            minZoom={0.35}
            nodes={nodes}
            nodesDraggable={false}
            nodesConnectable={false}
            nodeTypes={lineageNodeTypes}
            onPaneClick={() => setSelectedColumnKey(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#d5dde8" gap={22} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      ) : (
        <div className="catalog-lineage-empty">
          <strong>Lineage graph unavailable</strong>
          <span>백엔드 lineage contract 또는 mock fallback을 확인해 주세요.</span>
        </div>
      )}
      <div className="catalog-lineage-footer">
        <span>Upstream <strong>{Math.max((lineageGraph?.datasets.length ?? 1) - 1, 0)} Datasets</strong></span>
        <span>Layer <strong>{dataset.layer}</strong></span>
        <span>Status <strong>{statusMeta.label}</strong></span>
      </div>
    </section>
  );
}

function buildLineageGraph(
  graph: LineageGraph,
  selectedColumnKey: string | null,
  onColumnSelect: (columnKey: string | null) => void,
): { edges: Edge[]; nodes: Node[] } {
  const graphDatasets = graph.datasets;
  const depthByDatasetId = getLineageDepths(graph);
  const groupedDatasets = groupLineageDatasets(graphDatasets, depthByDatasetId);
  const maxGroupHeight = Math.max(...groupedDatasets.map((group) => getLineageStackHeight(group.length, getMaxColumnCount(group))), 0);
  const nodeIdsWithIncoming = new Set(graph.edges.map((edge) => edge.toDatasetId));
  const nodeIdsWithOutgoing = new Set(graph.edges.map((edge) => edge.fromDatasetId));
  const selection = selectedColumnKey ? getLineageSelection(graph, selectedColumnKey) : null;
  const nodes: Node<LineageTableNodeData>[] = groupedDatasets.flatMap((group, groupIndex) => {
    const groupHeight = getLineageStackHeight(group.length, getMaxColumnCount(group));
    const groupStartY = (maxGroupHeight - groupHeight) / 2;
    return group.map((lineageDataset, itemIndex) => {
      const columns = buildLineageColumns(lineageDataset.columns);
      const hasIncoming = nodeIdsWithIncoming.has(lineageDataset.id);
      const hasOutgoing = nodeIdsWithOutgoing.has(lineageDataset.id);
      const isRelated = !selection || selection.nodeIds.has(lineageDataset.id);
      const relatedColumnKeys = selection?.columnKeysByNodeId.get(lineageDataset.id) ?? null;
      return {
        data: {
          activeColumnKey: selectedColumnKey,
          columns,
          dimmed: !isRelated,
          engine: lineageDataset.engine,
          handleMode: getLineageHandleMode(hasIncoming, hasOutgoing),
          highlighted: Boolean(selection && isRelated),
          layerLabel: getLineageLayerLabel(lineageDataset.layer),
          nodeId: lineageDataset.id,
          onColumnSelect,
          relatedColumnKeys: relatedColumnKeys ? Array.from(relatedColumnKeys) : null,
          tableName: lineageDataset.name,
          tone: getLayerTone(lineageDataset.layer),
        },
        id: lineageDataset.id,
        position: {
          x: groupIndex * 315 + 20,
          y: groupStartY + getLineageStackOffset(itemIndex, lineageDataset.columns.length),
        },
        type: "lineageTable",
      };
    });
  });
  const edges = graph.edges
    .filter((edge) => graphDatasets.some((dataset) => dataset.id === edge.fromDatasetId) && graphDatasets.some((dataset) => dataset.id === edge.toDatasetId))
    .map((edge) => {
      const sourceColumn = findLineageColumn(graphDatasets, edge.fromDatasetId, edge.fromColumnId);
      const targetColumn = findLineageColumn(graphDatasets, edge.toDatasetId, edge.toColumnId);
      return buildColumnEdge({
        active: !selection || selection.edgeIds.has(lineageEdgeId(edge)),
        selected: selectedColumnKey !== null,
        id: `${edge.fromDatasetId}-${edge.fromColumnId}-to-${edge.toDatasetId}-${edge.toColumnId}`,
        source: edge.fromDatasetId,
        sourceHandle: lineageHandleId(edge.fromDatasetId, sourceColumn?.name ?? edge.fromColumnId, "source"),
        target: edge.toDatasetId,
        targetHandle: lineageHandleId(edge.toDatasetId, targetColumn?.name ?? edge.toColumnId, "target"),
      });
    });

  return {
    edges,
    nodes,
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
  const updateNodeInternals = useUpdateNodeInternals();

  useEffect(() => {
    updateNodeInternals(data.nodeId);
  }, [data.nodeId, updateNodeInternals]);

  return (
    <article className={[
      "xflow-schema-node",
      data.tone,
      data.dimmed ? "dimmed" : "",
      data.highlighted ? "highlighted" : "",
    ].filter(Boolean).join(" ")}>
      <header className="xflow-schema-header">
        <div className="xflow-schema-icon">
          <Table2 size={18} />
        </div>
        <div className="xflow-schema-title">
          <strong title={data.tableName}>{data.tableName}</strong>
          <span>{data.layerLabel} · {data.engine}</span>
        </div>
      </header>
      <div className="xflow-column-head">
        <span>Column</span>
        <span>Type</span>
      </div>
      <div className="xflow-schema-columns">
        {data.columns.map((column) => (
          <LineageColumnRow column={column} data={data} key={column.id} />
        ))}
      </div>
    </article>
  );
}

function LineageColumnRow({ column, data }: { column: LineageColumn; data: LineageTableNodeData }) {
  const columnKey = lineageColumnKey(data.nodeId, column.id);
  const isActive = data.activeColumnKey === columnKey;
  const isRelated = !data.relatedColumnKeys || data.relatedColumnKeys.includes(columnKey);

  return (
    <button
      className={[
        "xflow-column-row",
        isActive ? "active" : "",
        data.relatedColumnKeys && !isRelated ? "dimmed" : "",
        data.relatedColumnKeys && isRelated ? "related" : "",
      ].filter(Boolean).join(" ")}
      onClick={(event) => {
        event.stopPropagation();
        data.onColumnSelect(isActive ? null : columnKey);
      }}
      type="button"
    >
      {(data.handleMode === "target" || data.handleMode === "both") && (
        <Handle
          className="xflow-column-handle left target-handle"
          id={lineageHandleId(data.nodeId, column.name, "target")}
          position={Position.Left}
          type="target"
        />
      )}
      <span>{column.name}</span>
      <b className={`lineage-type-pill ${getColumnTypeTone(column.type)}`}>{column.type}</b>
      {(data.handleMode === "source" || data.handleMode === "both") && (
        <Handle
          className="xflow-column-handle right source-handle"
          id={lineageHandleId(data.nodeId, column.name, "source")}
          position={Position.Right}
          type="source"
        />
      )}
    </button>
  );
}

function buildColumnEdge({
  active,
  id,
  selected,
  source,
  sourceHandle,
  target,
  targetHandle,
}: {
  active: boolean;
  id: string;
  selected: boolean;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}): Edge {
  return {
    animated: false,
    className: selected ? active ? "lineage-column-edge active" : "lineage-column-edge muted" : "lineage-column-edge",
    id,
    markerEnd: { color: "#fb923c", type: MarkerType.ArrowClosed },
    source,
    sourceHandle,
    style: {
      stroke: "#fb923c",
      strokeDasharray: "6 5",
      strokeWidth: selected && active ? 2.4 : 1.5,
    },
    target,
    targetHandle,
    type: "smoothstep",
  };
}

function buildLineageColumns(columns: LineageGraphDataset["columns"]): LineageColumn[] {
  return columns.slice(0, 7).map((column) => ({
    baseId: column.id,
    id: column.id,
    name: column.name,
    type: column.type,
  }));
}

function findLineageColumn(datasets: LineageGraphDataset[], datasetId: string, columnId: string) {
  return datasets.find((dataset) => dataset.id === datasetId)?.columns.find((column) => column.id === columnId);
}

function getLineageSelection(graph: LineageGraph, selectedColumnKey: string) {
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>();
  const columnKeys = new Set<string>([selectedColumnKey]);
  const columnKeysByNodeId = new Map<string, Set<string>>();
  const adjacency = new Map<string, Array<{ edgeId: string; key: string }>>();

  const registerColumnKey = (key: string) => {
    const [nodeId] = key.split("::");
    if (!nodeId) return;
    nodeIds.add(nodeId);
    if (!columnKeysByNodeId.has(nodeId)) columnKeysByNodeId.set(nodeId, new Set());
    columnKeysByNodeId.get(nodeId)?.add(key);
  };
  const addAdjacency = (from: string, to: string, edgeId: string) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)?.push({ edgeId, key: to });
  };

  graph.edges.forEach((edge) => {
    const edgeId = lineageEdgeId(edge);
    const sourceKey = lineageColumnKey(edge.fromDatasetId, edge.fromColumnId);
    const targetKey = lineageColumnKey(edge.toDatasetId, edge.toColumnId);
    addAdjacency(sourceKey, targetKey, edgeId);
    addAdjacency(targetKey, sourceKey, edgeId);
  });

  const queue = [selectedColumnKey];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    columnKeys.add(current);
    registerColumnKey(current);

    (adjacency.get(current) ?? []).forEach(({ edgeId, key }) => {
      edgeIds.add(edgeId);
      if (!visited.has(key)) queue.push(key);
    });
  }

  return { columnKeys, columnKeysByNodeId, edgeIds, nodeIds };
}

function getLineageDepths(graph: LineageGraph): Map<string, number> {
  const depths = new Map(graph.datasets.map((dataset) => [dataset.id, 0]));
  for (let pass = 0; pass < graph.datasets.length; pass += 1) {
    let changed = false;
    graph.edges.forEach((edge) => {
      const sourceDepth = depths.get(edge.fromDatasetId) ?? 0;
      const targetDepth = depths.get(edge.toDatasetId) ?? 0;
      if (sourceDepth + 1 > targetDepth) {
        depths.set(edge.toDatasetId, sourceDepth + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return depths;
}

function groupLineageDatasets(datasets: LineageGraphDataset[], depthByDatasetId: Map<string, number>): LineageGraphDataset[][] {
  const groups = new Map<number, LineageGraphDataset[]>();
  datasets.forEach((dataset) => {
    const depth = depthByDatasetId.get(dataset.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), dataset]);
  });
  return Array.from(groups.entries())
    .sort(([leftDepth], [rightDepth]) => leftDepth - rightDepth)
    .map(([, group]) => group);
}

function getMaxColumnCount(datasets: LineageGraphDataset[]): number {
  return Math.max(...datasets.map((dataset) => dataset.columns.length), 1);
}

function getLineageHandleMode(hasIncoming: boolean, hasOutgoing: boolean): LineageTableNodeData["handleMode"] {
  if (hasIncoming && hasOutgoing) return "both";
  if (hasIncoming) return "target";
  return "source";
}

function getLineageLayerLabel(layer: LineageLayer): string {
  if (layer === "SOURCE") return "SOURCE";
  if (layer === "CONSUMER") return "CONSUMER";
  return `${layer} LAYER`;
}

function getLayerTone(layer: LineageLayer): LineageTableNodeData["tone"] {
  if (layer === "GOLD") return "gold";
  if (layer === "SILVER") return "silver";
  if (layer === "BRONZE") return "bronze";
  if (layer === "CONSUMER") return "downstream";
  return "source";
}

function getColumnTypeTone(type: string): string {
  const normalized = type.toLowerCase();
  if (["int", "integer", "bigint"].includes(normalized)) return "integer";
  if (["decimal", "double", "float", "number"].includes(normalized)) return "double";
  if (["timestamp", "date", "datetime"].includes(normalized)) return "timestamp";
  if (normalized.includes("json")) return "json";
  return "string";
}

function lineageHandleId(datasetId: string, columnName: string, kind: "source" | "target"): string {
  return `${kind}-col:${datasetId}:${columnName}`;
}

function lineageColumnKey(datasetId: string, columnId: string): string {
  return `${datasetId}::${columnId}`;
}

function lineageEdgeId(edge: LineageGraph["edges"][number]): string {
  return `${edge.fromDatasetId}::${edge.fromColumnId}->${edge.toDatasetId}::${edge.toColumnId}`;
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
