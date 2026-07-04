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
  expanded: boolean;
  expandable: boolean;
  handleMode: "source" | "target" | "both";
  layerLabel: string;
  nodeId: string;
  onColumnSelect: (columnId: string | null) => void;
  onNodeExpand: (nodeId: string) => void;
  selectedColumnId: string | null;
  tableName: string;
  tone: "source" | "bronze" | "silver" | "gold" | "downstream";
};

type LineageGraphNode = {
  columns: LineageColumn[];
  engine: string;
  id: string;
  layerLabel: string;
  tableName: string;
  tone: LineageTableNodeData["tone"];
  upstream: string[];
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
          {activeModal === "schema" ? <CatalogSchema dataset={previewDataset} /> : <CatalogLineage dataset={previewDataset} datasets={datasets} />}
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
      {activeTab === "lineage" && <CatalogLineage dataset={dataset} datasets={[dataset]} />}
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

function CatalogLineage({ dataset, datasets = [dataset] }: { dataset: CatalogDataset; datasets?: CatalogDataset[] }) {
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const { edges, nodes } = buildLineageGraph(dataset, datasets, selectedColumnId, setSelectedColumnId, expandedNodeIds, (nodeId) => {
    setExpandedNodeIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  });
  const statusMeta = datasetStatusMeta[dataset.status];

  useEffect(() => {
    setSelectedColumnId(null);
    setExpandedNodeIds(new Set());
  }, [dataset.id]);

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
          defaultViewport={{ x: -90, y: 36, zoom: 0.86 }}
          edges={edges}
          maxZoom={1.1}
          minZoom={0.35}
          nodes={nodes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodeTypes={lineageNodeTypes}
          onPaneClick={() => setSelectedColumnId(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#d5dde8" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="catalog-lineage-footer">
        <span>Upstream <strong>{Math.max(0, nodes.length - 1)} Nodes</strong></span>
        <span>Layer <strong>{dataset.layer}</strong></span>
        <span>Status <strong>{statusMeta.label}</strong></span>
      </div>
    </section>
  );
}

function buildLineageGraph(
  dataset: CatalogDataset,
  datasets: CatalogDataset[],
  selectedColumnId: string | null,
  onColumnSelect: (columnId: string | null) => void,
  expandedNodeIds: Set<string>,
  onNodeExpand: (nodeId: string) => void,
): { edges: Edge[]; nodes: Node[] } {
  const primaryColumns = buildLineageColumns(dataset.schema);
  const mockGraph = buildMockLineageGraph(dataset, datasets, primaryColumns);
  const rootNode: LineageGraphNode = {
    columns: primaryColumns,
    engine: "ICEBERG",
    id: "current-dataset",
    layerLabel: `${dataset.layer} LAYER`,
    tableName: dataset.name,
    tone: getLayerTone(dataset.layer),
    upstream: mockGraph.rootUpstream,
  };
  const visibleLevels = getVisibleLineageLevels(rootNode, mockGraph.nodesById, expandedNodeIds);
  const levelHeights = visibleLevels.map((level) => getLineageStackHeight(level.length, primaryColumns.length));
  const currentHeight = getLineageTableHeight(primaryColumns.length);
  const graphHeight = Math.max(currentHeight, ...levelHeights);
  const levelGapX = 350;
  const rootX = 1090;
  const currentY = (graphHeight - currentHeight) / 2;

  const currentNode: Node<LineageTableNodeData> = {
    data: {
      columns: rootNode.columns,
      engine: rootNode.engine,
      expanded: true,
      expandable: rootNode.upstream.length > 0,
      handleMode: "target",
      layerLabel: rootNode.layerLabel,
      nodeId: rootNode.id,
      onColumnSelect,
      onNodeExpand,
      selectedColumnId,
      tableName: rootNode.tableName,
      tone: rootNode.tone,
    },
    id: rootNode.id,
    position: { x: rootX, y: currentY },
    type: "lineageTable",
  };

  const lineageNodes: Node<LineageTableNodeData>[] = visibleLevels.flatMap((level, levelIndex) => {
    const levelHeight = levelHeights[levelIndex];
    const levelStartY = (graphHeight - levelHeight) / 2;
    const x = rootX - (visibleLevels.length - levelIndex) * levelGapX;
    return level.map((lineageNode, nodeIndex) => ({
      data: {
        columns: lineageNode.columns,
        engine: lineageNode.engine,
        expanded: expandedNodeIds.has(lineageNode.id),
        expandable: lineageNode.upstream.length > 0,
        handleMode: lineageNode.upstream.length > 0 ? "both" : "source",
        layerLabel: lineageNode.layerLabel,
        nodeId: lineageNode.id,
        onColumnSelect,
        onNodeExpand,
        selectedColumnId,
        tableName: lineageNode.tableName,
        tone: lineageNode.tone,
      },
      id: lineageNode.id,
      position: { x, y: levelStartY + getLineageStackOffset(nodeIndex, lineageNode.columns.length) },
      type: "lineageTable",
    }));
  });

  const lineageEdges = [...lineageNodes, currentNode].flatMap((targetNode) => {
    const targetDefinition = targetNode.id === rootNode.id ? rootNode : mockGraph.nodesById[targetNode.id];
    if (!targetDefinition) return [];
    return targetDefinition.upstream.flatMap((sourceId) => {
      if (targetDefinition.id !== rootNode.id && !expandedNodeIds.has(targetDefinition.id)) return [];
      const sourceDefinition = mockGraph.nodesById[sourceId];
      if (!sourceDefinition) return [];
      return targetDefinition.columns.map((targetColumn, columnIndex) => {
        const sourceColumn = sourceDefinition.columns[columnIndex % sourceDefinition.columns.length];
        return buildColumnEdge({
          active: targetColumn.baseId === selectedColumnId,
          selected: selectedColumnId !== null,
          id: `${sourceDefinition.id}-${sourceColumn.id}-to-${targetDefinition.id}-${targetColumn.id}`,
          source: sourceDefinition.id,
          sourceHandle: lineageHandleId(sourceColumn.id, "right"),
          target: targetDefinition.id,
          targetHandle: lineageHandleId(targetColumn.id, "left"),
        });
      });
    });
  });

  return {
    edges: lineageEdges,
    nodes: [...lineageNodes, currentNode],
  };
}

function getLineageStackHeight(nodeCount: number, columnCount: number): number {
  if (nodeCount === 0) return 0;
  return nodeCount * getLineageTableHeight(columnCount) + (nodeCount - 1) * lineageGroupGap;
}

function getVisibleLineageLevels(
  rootNode: LineageGraphNode,
  nodesById: Record<string, LineageGraphNode>,
  expandedNodeIds: Set<string>,
): LineageGraphNode[][] {
  const levels: LineageGraphNode[][] = [];
  let currentLevel = rootNode.upstream.map((nodeId) => nodesById[nodeId]).filter(Boolean);
  const visited = new Set([rootNode.id]);

  while (currentLevel.length > 0) {
    levels.unshift(currentLevel);
    const nextLevel = currentLevel
      .filter((node) => expandedNodeIds.has(node.id))
      .flatMap((node) => node.upstream)
      .filter((nodeId) => !visited.has(nodeId))
      .map((nodeId) => nodesById[nodeId])
      .filter(Boolean);

    currentLevel.forEach((node) => visited.add(node.id));
    currentLevel = nextLevel;
  }

  return levels;
}

function buildMockLineageGraph(
  dataset: CatalogDataset,
  datasets: CatalogDataset[],
  columns: LineageColumn[],
): { nodesById: Record<string, LineageGraphNode>; rootUpstream: string[] } {
  if (dataset.id === "ds_customer_orders_gold") {
    const sourceColumns = buildSourceColumns(columns, "PostgreSQL commerce.orders", 0);
    const bronzeColumns = columns.map((column) => ({ ...column, id: normalizeLineageId(`bronze-${column.name}`) }));
    const silverColumns = columns.map((column) => ({ ...column, id: normalizeLineageId(`silver-${column.name}`) }));

    return {
      rootUpstream: ["silver-daily-order-ingestion"],
      nodesById: {
        "source-commerce-orders": {
          columns: sourceColumns,
          engine: "POSTGRESQL",
          id: "source-commerce-orders",
          layerLabel: "SOURCE",
          tableName: "commerce.orders",
          tone: "source",
          upstream: [],
        },
        "bronze-commerce-orders": {
          columns: bronzeColumns,
          engine: "ICEBERG",
          id: "bronze-commerce-orders",
          layerLabel: "BRONZE LAYER",
          tableName: "bronze_orders",
          tone: "bronze",
          upstream: ["source-commerce-orders"],
        },
        "silver-daily-order-ingestion": {
          columns: silverColumns,
          engine: "ICEBERG",
          id: "silver-daily-order-ingestion",
          layerLabel: "SILVER LAYER",
          tableName: "daily_order_ingestion",
          tone: "silver",
          upstream: ["bronze-commerce-orders"],
        },
      },
    };
  }

  const nodesById: Record<string, LineageGraphNode> = {};
  const rootUpstream = dataset.upstream.map((item, index) => {
    const linkedDataset = findCatalogDatasetForLineage(item, datasets);
    if (linkedDataset && linkedDataset.id !== dataset.id) {
      addCatalogDatasetLineageNode(linkedDataset, datasets, nodesById);
      return lineageDatasetNodeId(linkedDataset);
    }

    const sourceMeta = getLineageSourceMeta(item, dataset.layer, index);
    const nodeId = `upstream-${normalizeLineageId(item)}`;
    nodesById[nodeId] = {
      columns: buildSourceColumns(columns, item, index),
      engine: sourceMeta.engine,
      id: nodeId,
      layerLabel: sourceMeta.layerLabel,
      tableName: getLineageTableName(item),
      tone: sourceMeta.tone,
      upstream: [],
    };
    return nodeId;
  });

  return {
    nodesById,
    rootUpstream,
  };
}

function addCatalogDatasetLineageNode(
  dataset: CatalogDataset,
  allDatasets: CatalogDataset[],
  nodesById: Record<string, LineageGraphNode>,
) {
  const nodeId = lineageDatasetNodeId(dataset);
  if (nodesById[nodeId]) return;

  const columns = buildLineageColumns(dataset.schema).map((column) => ({
    ...column,
    id: normalizeLineageId(`${dataset.id}-${column.name}`),
  }));
  const upstreamIds = dataset.upstream.map((item, index) => {
    const linkedDataset = findCatalogDatasetForLineage(item, allDatasets);
    if (linkedDataset && linkedDataset.id !== dataset.id) {
      addCatalogDatasetLineageNode(linkedDataset, allDatasets, nodesById);
      return lineageDatasetNodeId(linkedDataset);
    }

    const sourceMeta = getLineageSourceMeta(item, dataset.layer, index);
    const sourceId = `${nodeId}-upstream-${normalizeLineageId(item)}`;
    nodesById[sourceId] = {
      columns: buildSourceColumns(columns, item, index),
      engine: sourceMeta.engine,
      id: sourceId,
      layerLabel: sourceMeta.layerLabel,
      tableName: getLineageTableName(item),
      tone: sourceMeta.tone,
      upstream: [],
    };
    return sourceId;
  });

  nodesById[nodeId] = {
    columns,
    engine: "ICEBERG",
    id: nodeId,
    layerLabel: `${dataset.layer} LAYER`,
    tableName: dataset.name,
    tone: getLayerTone(dataset.layer),
    upstream: upstreamIds,
  };
}

function findCatalogDatasetForLineage(value: string, datasets: CatalogDataset[]): CatalogDataset | undefined {
  const normalized = normalizeLineageId(value);
  return datasets.find((dataset) => normalized.includes(normalizeLineageId(dataset.name)));
}

function lineageDatasetNodeId(dataset: CatalogDataset): string {
  return `dataset-${dataset.id}`;
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
        <div className="lineage-table-actions">
          <em>{data.engine}</em>
          {data.expandable && data.handleMode !== "target" && (
            <button
              aria-label={data.expanded ? `${data.tableName} upstream 접기` : `${data.tableName} upstream 펼치기`}
              className="lineage-expand-button"
              onClick={(event) => {
                event.stopPropagation();
                data.onNodeExpand(data.nodeId);
              }}
              type="button"
            >
              {data.expanded ? <Minus size={14} /> : <Plus size={14} />}
            </button>
          )}
        </div>
      </header>
      <div className="lineage-table-columns">
        {data.columns.map((column) => (
          <button
            className={column.baseId === data.selectedColumnId ? "lineage-column-row active" : "lineage-column-row"}
            key={column.id}
            onClick={(event) => {
              event.stopPropagation();
              data.onColumnSelect(column.baseId);
            }}
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
    markerEnd: { color: selected && active ? "#2563eb" : "#94a3b8", type: MarkerType.ArrowClosed },
    source,
    sourceHandle,
    style: {
      stroke: selected && active ? "#2563eb" : "#94a3b8",
      strokeWidth: selected && active ? 2.4 : 1.5,
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
