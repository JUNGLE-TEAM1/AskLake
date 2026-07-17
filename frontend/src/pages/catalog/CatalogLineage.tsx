import { useEffect, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import type { Edge, Node as FlowNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Share2, Table2 } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getDatasetLineageGraph } from "../../services/askLakeApi";
import type { CatalogDataset, LineageGraph, LineageGraphDataset, LineageLayer } from "../../types";
import { cn } from "@/lib/utils";
import { LineageColumn, LineageTableNodeData, escapeRegExp, lineageColumnRowHeight, lineageFitViewOptions, lineageGroupGap, lineageNodeHeaderHeight } from "./catalogModel";

const lineageNodeTypes = {
  lineageTable: LineageTableNode,
};
export function CatalogLineage({ compact = false, dataset }: { compact?: boolean; dataset: CatalogDataset }) {
  const [lineageGraph, setLineageGraph] = useState<LineageGraph | null>(dataset.lineageGraph ?? null);
  const [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const { edges, nodes } = lineageGraph
    ? buildLineageGraph(lineageGraph, selectedColumnKey, selectedDatasetId, setSelectedColumnKey)
    : { edges: [], nodes: [] };
  const selectedLineageDataset = lineageGraph?.datasets.find((item) => item.id === selectedDatasetId) ?? null;

  useEffect(() => {
    let isActive = true;
    setLineageGraph(dataset.lineageGraph ?? null);
    setSelectedColumnKey(null);
    setSelectedDatasetId(null);
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
    <>
      <Panel asChild className={compact ? "catalog-lineage-card compact" : "catalog-lineage-card"}>
        <section>
          {!compact && (
            <PanelHeader
              bordered={false}
              className="catalog-lineage-title min-h-0 p-0"
              description="리니지"
              icon={<Share2 size={18} />}
              iconVariant="outline"
              title={dataset.name}
            />
          )}
          {lineageGraph ? (
            <div className="catalog-lineage-flow" aria-label={`${dataset.name} 리니지 그래프`}>
              <ReactFlow
                edges={edges}
                fitView
                fitViewOptions={lineageFitViewOptions}
                maxZoom={1.4}
                minZoom={0.25}
                nodes={nodes}
                nodesConnectable={false}
                nodesDraggable={false}
                nodeTypes={lineageNodeTypes}
                onNodeClick={(_, node) => setSelectedDatasetId(node.id)}
                onPaneClick={() => {
                  setSelectedColumnKey(null);
                  setSelectedDatasetId(null);
                }}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#d5dde8" gap={22} />
                <Controls position="bottom-left" showInteractive={false} />
              </ReactFlow>
            </div>
          ) : (
            <div className="catalog-lineage-empty">
              <strong>리니지를 불러오지 못했습니다.</strong>
              <span>백엔드 응답 또는 예시 데이터를 확인해 주세요.</span>
            </div>
          )}
        </section>
      </Panel>

      <Sheet open={selectedLineageDataset !== null} onOpenChange={(open) => !open && setSelectedDatasetId(null)}>
        {lineageGraph && selectedLineageDataset ? (
          <SheetContent className="flex h-full flex-col gap-0 p-0" closeLabel="리니지 상세 닫기" side="right">
            <SheetHeader className="gap-3 p-6 pr-16">
              <Badge className="w-fit" shape="compact" variant={getLineageLayerBadgeVariant(selectedLineageDataset.layer)}>
                {getLineageLayerLabel(selectedLineageDataset.layer)}
              </Badge>
              <SheetTitle className="break-words">{selectedLineageDataset.name}</SheetTitle>
              <SheetDescription>{selectedLineageDataset.engine} 데이터셋의 컬럼과 연결 정보를 확인합니다.</SheetDescription>
            </SheetHeader>
            <Separator />
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-6 p-6">
                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-slate-950">연결 정보</h3>
                  <div className="flex flex-wrap gap-2">
                    <Badge shape="compact" variant="outline">상위 {countLineageConnections(lineageGraph, selectedLineageDataset.id, "upstream")}개</Badge>
                    <Badge shape="compact" variant="outline">하위 {countLineageConnections(lineageGraph, selectedLineageDataset.id, "downstream")}개</Badge>
                    <Badge shape="compact" variant="outline">컬럼 {selectedLineageDataset.columns.length}개</Badge>
                  </div>
                </section>
                <Separator />
                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-slate-950">컬럼</h3>
                  <Card className="overflow-hidden" size="none" variant="muted">
                    <CardContent className="divide-y divide-slate-200 p-0 pt-0">
                      {selectedLineageDataset.columns.map((column) => (
                        <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3" key={column.id}>
                          <span className="min-w-0 truncate text-sm font-medium text-slate-900" title={column.name}>{column.name}</span>
                          <Badge shape="compact" size="sm" variant={getColumnTypeBadgeVariant(column.type)}>{column.type}</Badge>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </section>
              </div>
            </ScrollArea>
          </SheetContent>
        ) : null}
      </Sheet>
    </>
  );
}

export function buildLineageGraph(
  graph: LineageGraph,
  selectedColumnKey: string | null,
  selectedDatasetId: string | null,
  onColumnSelect: (columnKey: string | null) => void,
): { edges: Edge[]; nodes: FlowNode[] } {
  const graphDatasets = graph.datasets;
  const depthByDatasetId = getLineageDepths(graph);
  const groupedDatasets = groupLineageDatasets(graphDatasets, depthByDatasetId);
  const maxGroupHeight = Math.max(...groupedDatasets.map((group) => getLineageStackHeight(group.length, getMaxColumnCount(group))), 0);
  const nodeIdsWithIncoming = new Set(graph.edges.map((edge) => edge.toDatasetId));
  const nodeIdsWithOutgoing = new Set(graph.edges.map((edge) => edge.fromDatasetId));
  const selection = selectedColumnKey ? getLineageSelection(graph, selectedColumnKey) : null;
  const nodes: FlowNode<LineageTableNodeData>[] = groupedDatasets.flatMap((group, groupIndex) => {
    const groupColumnCount = getMaxColumnCount(group);
    const groupHeight = getLineageStackHeight(group.length, groupColumnCount);
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
          dataset: lineageDataset,
          dimmed: !isRelated,
          handleMode: getLineageHandleMode(hasIncoming, hasOutgoing),
          highlighted: Boolean(selection && isRelated),
          nodeId: lineageDataset.id,
          onColumnSelect,
          relatedColumnKeys: relatedColumnKeys ? Array.from(relatedColumnKeys) : null,
          selected: selectedDatasetId === lineageDataset.id,
        },
        id: lineageDataset.id,
        position: {
          x: groupIndex * 315 + 20,
          y: groupStartY + getLineageStackOffset(itemIndex, groupColumnCount),
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

export function getLineageStackHeight(nodeCount: number, columnCount: number): number {
  if (nodeCount === 0) return 0;
  return nodeCount * getLineageTableHeight(columnCount) + (nodeCount - 1) * lineageGroupGap;
}

export function getLineageStackOffset(index: number, columnCount: number): number {
  return index * (getLineageTableHeight(columnCount) + lineageGroupGap);
}

export function getLineageTableHeight(columnCount: number): number {
  return lineageNodeHeaderHeight + columnCount * lineageColumnRowHeight + 16;
}

export function LineageTableNode({ data }: { data: LineageTableNodeData }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const layerVariant = getLineageLayerBadgeVariant(data.dataset.layer);
  const displayName = getLineageNodeDisplayName(data.dataset);

  useEffect(() => {
    updateNodeInternals(data.nodeId);
  }, [data.nodeId, updateNodeInternals]);

  return (
    <Card
      className={cn(
        "w-60 overflow-visible p-0 transition-[border-color,box-shadow,opacity]",
        data.dimmed && "opacity-35",
        data.highlighted && "border-orange-400 shadow-md",
        data.selected && "border-blue-500 ring-2 ring-blue-100",
      )}
      size="none"
    >
      <CardHeader className="flex min-h-16 flex-row items-center gap-3 border-b border-slate-200 p-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md border border-blue-100 bg-blue-50 text-blue-600">
          <Table2 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="break-words text-sm leading-5" title={displayName}>{displayName}</CardTitle>
          <CardDescription className="mt-1 flex flex-wrap items-center gap-1 text-xs leading-4">
            <Badge shape="compact" size="sm" variant={layerVariant}>{data.dataset.layer}</Badge>
            <span>{data.dataset.engine}</span>
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[10px] font-semibold text-slate-500">
        <span>컬럼</span>
        <span className="text-right">타입</span>
      </div>
      <div>
        {data.columns.map((column) => (
          <LineageColumnRow column={column} data={data} key={column.id} />
        ))}
      </div>
      </CardContent>
    </Card>
  );
}

export function getLineageNodeDisplayName(dataset: LineageGraphDataset): string {
  if (dataset.layer !== "SOURCE") return dataset.name;

  const enginePrefix = new RegExp(`^${escapeRegExp(dataset.engine)}\\s+`, "i");
  return dataset.name.replace(enginePrefix, "").trim() || dataset.name;
}

export function LineageColumnRow({ column, data }: { column: LineageColumn; data: LineageTableNodeData }) {
  const columnKey = lineageColumnKey(data.nodeId, column.id);
  const isActive = data.activeColumnKey === columnKey;
  const isRelated = !data.relatedColumnKeys || data.relatedColumnKeys.includes(columnKey);

  return (
    <Button
      className={cn(
        "nodrag relative grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-none border-b border-slate-100 px-4 text-left text-xs last:border-b-0",
        isActive && "bg-orange-100 ring-1 ring-inset ring-orange-300 hover:bg-orange-100",
        data.relatedColumnKeys && !isRelated && "opacity-30",
        data.relatedColumnKeys && isRelated && !isActive && "bg-orange-50 hover:bg-orange-50",
      )}
      onClick={(event) => {
        event.stopPropagation();
        data.onColumnSelect(isActive ? null : columnKey);
      }}
      shape="compact"
      size="content"
      type="button"
      variant="ghost"
    >
      {(data.handleMode === "target" || data.handleMode === "both") && (
        <Handle
          className="!size-3 !border-2 !border-white !bg-blue-500"
          id={lineageHandleId(data.nodeId, column.name, "target")}
          position={Position.Left}
          type="target"
        />
      )}
      <span className="min-w-0 truncate" title={column.name}>{column.name}</span>
      <Badge className="justify-self-end" shape="compact" size="sm" variant={getColumnTypeBadgeVariant(column.type)}>{column.type}</Badge>
      {(data.handleMode === "source" || data.handleMode === "both") && (
        <Handle
          className="!size-3 !border-2 !border-white !bg-blue-500"
          id={lineageHandleId(data.nodeId, column.name, "source")}
          position={Position.Right}
          type="source"
        />
      )}
    </Button>
  );
}

export function buildColumnEdge({
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
  const strokeColor = selected && active ? "#2563eb" : "#64748b";

  return {
    animated: false,
    id,
    markerEnd: { color: strokeColor, height: 16, type: MarkerType.ArrowClosed, width: 16 },
    source,
    sourceHandle,
    style: {
      opacity: selected && !active ? 0.28 : 1,
      stroke: strokeColor,
      strokeWidth: selected && active ? 2.4 : 1.5,
    },
    target,
    targetHandle,
    type: "smoothstep",
  };
}

export function buildLineageColumns(columns: LineageGraphDataset["columns"]): LineageColumn[] {
  return columns.slice(0, 7).map((column) => ({
    baseId: column.id,
    id: column.id,
    name: column.name,
    type: column.type,
  }));
}

export function findLineageColumn(datasets: LineageGraphDataset[], datasetId: string, columnId: string) {
  return datasets.find((dataset) => dataset.id === datasetId)?.columns.find((column) => column.id === columnId);
}

export function getLineageSelection(graph: LineageGraph, selectedColumnKey: string) {
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

export function getLineageDepths(graph: LineageGraph): Map<string, number> {
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

export function groupLineageDatasets(datasets: LineageGraphDataset[], depthByDatasetId: Map<string, number>): LineageGraphDataset[][] {
  const groups = new Map<number, LineageGraphDataset[]>();
  datasets.forEach((dataset) => {
    const depth = depthByDatasetId.get(dataset.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), dataset]);
  });
  return Array.from(groups.entries())
    .sort(([leftDepth], [rightDepth]) => leftDepth - rightDepth)
    .map(([, group]) => group);
}

export function getMaxColumnCount(datasets: LineageGraphDataset[]): number {
  return Math.max(...datasets.map((dataset) => dataset.columns.length), 1);
}

export function getLineageHandleMode(hasIncoming: boolean, hasOutgoing: boolean): LineageTableNodeData["handleMode"] {
  if (hasIncoming && hasOutgoing) return "both";
  if (hasIncoming) return "target";
  return "source";
}

export function getLineageLayerLabel(layer: LineageLayer): string {
  if (layer === "SOURCE") return "SOURCE";
  if (layer === "CONSUMER") return "CONSUMER";
  return `${layer} LAYER`;
}

export function getLineageLayerBadgeVariant(layer: LineageLayer): BadgeProps["variant"] {
  if (layer === "GOLD" || layer === "SILVER") return "default";
  if (layer === "BRONZE" || layer === "SOURCE") return "warning";
  return "success";
}

export function getColumnTypeBadgeVariant(type: string): BadgeProps["variant"] {
  const normalized = type.toLowerCase();
  if (["int", "integer", "bigint", "decimal", "double", "float", "number"].includes(normalized)) return "default";
  if (["timestamp", "date", "datetime"].includes(normalized)) return "warning";
  if (normalized.includes("json")) return "secondary";
  return "success";
}

export function countLineageConnections(graph: LineageGraph, datasetId: string, direction: "upstream" | "downstream"): number {
  const connectedDatasetIds = new Set(
    graph.edges
      .filter((edge) => direction === "upstream" ? edge.toDatasetId === datasetId : edge.fromDatasetId === datasetId)
      .map((edge) => direction === "upstream" ? edge.fromDatasetId : edge.toDatasetId),
  );
  return connectedDatasetIds.size;
}

export function lineageHandleId(datasetId: string, columnName: string, kind: "source" | "target"): string {
  return `${kind}-col:${datasetId}:${columnName}`;
}

export function lineageColumnKey(datasetId: string, columnId: string): string {
  return `${datasetId}::${columnId}`;
}

export function lineageEdgeId(edge: LineageGraph["edges"][number]): string {
  return `${edge.fromDatasetId}::${edge.fromColumnId}->${edge.toDatasetId}::${edge.toColumnId}`;
}

export function CatalogLineageMini({ dataset }: { dataset: CatalogDataset }) {
  return (
    <div className="catalog-lineage-mini">
      <div>{dataset.upstream.map((item) => <span key={item}>{item}</span>)}</div>
      <strong>{dataset.name}</strong>
      <div>{dataset.downstream.slice(0, 2).map((item) => <span key={item}>{item}</span>)}</div>
    </div>
  );
}
