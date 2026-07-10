import { Calendar, Database, Hash, Server, Table2, Type } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  TreeExpander,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
} from "@/components/kibo-ui/tree";
import { StatusBadge } from "@/components/ui/status-badge";
import { TreeHoverCard } from "@/components/ui/tree-hover-card";
import type { CatalogDataset } from "../../types";

type SqlDatasetTreeProps = {
  datasets: CatalogDataset[];
  expandedDatasetId: string | null;
  onSelect: (dataset: CatalogDataset) => void;
  onToggle: (dataset: CatalogDataset) => void;
  selectedDatasetIds: ReadonlySet<string>;
};

type HoverInfo =
  | { dataset: CatalogDataset; kind: "table"; position: { left: number; top: number } }
  | { columnName: string; columnType: string; dataset: CatalogDataset; kind: "column"; position: { left: number; top: number } };

const SYSTEM_NODE_ID = "sql-tree:system";
const DATASETS_NODE_ID = "sql-tree:datasets";
const TABLES_NODE_ID = "sql-tree:tables";
const STRUCTURAL_NODE_IDS = [SYSTEM_NODE_ID, DATASETS_NODE_ID, TABLES_NODE_ID];
const DATASET_NODE_PREFIX = "sql-tree:dataset:";

function getDatasetNodeId(datasetId: string) {
  return `${DATASET_NODE_PREFIX}${datasetId}`;
}

export function SqlDatasetTree({
  datasets,
  expandedDatasetId,
  onSelect,
  onToggle,
  selectedDatasetIds,
}: SqlDatasetTreeProps) {
  const [expandedStructureIds, setExpandedStructureIds] = useState<string[]>(STRUCTURAL_NODE_IDS);
  const expandedIds = useMemo(
    () => expandedDatasetId
      ? [...expandedStructureIds, getDatasetNodeId(expandedDatasetId)]
      : expandedStructureIds,
    [expandedDatasetId, expandedStructureIds],
  );
  const handleExpandedChange = useCallback((nextExpandedIds: string[], changedNodeId: string) => {
    if (changedNodeId.startsWith(DATASET_NODE_PREFIX)) {
      const datasetId = changedNodeId.slice(DATASET_NODE_PREFIX.length);
      const targetDataset = datasets.find((dataset) => dataset.id === datasetId);
      if (targetDataset) onToggle(targetDataset);
      return;
    }

    setExpandedStructureIds(nextExpandedIds.filter((nodeId) => STRUCTURAL_NODE_IDS.includes(nodeId)));
  }, [datasets, onToggle]);
  if (datasets.length === 0) return null;

  return (
    <TreeProvider
      className="min-w-0"
      expandedIds={expandedIds}
      indent={18}
      onExpandedChange={handleExpandedChange}
      selectable={false}
      showLines
    >
      <TreeView aria-label="분석 데이터셋 트리" className="p-2 pr-3">
        <TreeNode isLast level={0} nodeId={SYSTEM_NODE_ID}>
          <TreeNodeTrigger aria-expanded={expandedIds.includes(SYSTEM_NODE_ID)} aria-level={1} className="min-h-9">
            <TreeExpander hasChildren />
            <TreeIcon hasChildren icon={<Server />} />
            <TreeLabel>system</TreeLabel>
          </TreeNodeTrigger>
          <TreeNodeContent hasChildren>
            <TreeNode isLast level={1} nodeId={DATASETS_NODE_ID} parentPath={[true]}>
              <TreeNodeTrigger aria-expanded={expandedIds.includes(DATASETS_NODE_ID)} aria-level={2} className="min-h-9">
                <TreeExpander hasChildren />
                <TreeIcon hasChildren icon={<Database />} />
                <TreeLabel>datasets</TreeLabel>
              </TreeNodeTrigger>
              <TreeNodeContent hasChildren>
                <TreeNode isLast level={2} nodeId={TABLES_NODE_ID} parentPath={[true, true]}>
                  <TreeNodeTrigger aria-expanded={expandedIds.includes(TABLES_NODE_ID)} aria-level={3} className="min-h-9">
                    <TreeExpander hasChildren />
                    <TreeIcon hasChildren icon={<Table2 />} />
                    <TreeLabel>{`테이블(${datasets.length})`}</TreeLabel>
                  </TreeNodeTrigger>
                  <TreeNodeContent hasChildren>
                    {datasets.map((dataset, index) => (
                      <SqlDatasetTreeRow
                        dataset={dataset}
                        expanded={expandedDatasetId === dataset.id}
                        isLast={index === datasets.length - 1}
                        key={dataset.id}
                        onSelect={onSelect}
                        selected={selectedDatasetIds.has(dataset.id)}
                      />
                    ))}
                  </TreeNodeContent>
                </TreeNode>
              </TreeNodeContent>
            </TreeNode>
          </TreeNodeContent>
        </TreeNode>
      </TreeView>
    </TreeProvider>
  );
}

function SqlDatasetTreeRow({
  dataset,
  expanded,
  isLast,
  onSelect,
  selected,
}: {
  dataset: CatalogDataset;
  expanded: boolean;
  isLast: boolean;
  onSelect: (dataset: CatalogDataset) => void;
  selected: boolean;
}) {
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const showTableInfo = (target: HTMLElement) => setHoverInfo({
    dataset,
    kind: "table",
    position: getHoverPosition(target),
  });
  const showColumnInfo = (target: HTMLElement, columnName: string, columnType: string) => setHoverInfo({
    columnName,
    columnType,
    dataset,
    kind: "column",
    position: getHoverPosition(target),
  });

  return (
    <TreeNode
      data-sql-dataset-node=""
      isLast={isLast}
      level={3}
      nodeId={getDatasetNodeId(dataset.id)}
      parentPath={[true, true, isLast]}
    >
      <TreeNodeTrigger
        aria-expanded={expanded}
        aria-level={4}
        aria-pressed={selected}
        className="min-h-14 pr-2"
        data-sql-dataset-row=""
        data-sql-dataset-selected={selected ? "" : undefined}
        onBlur={() => setHoverInfo(null)}
        onFocus={(event) => showTableInfo(event.currentTarget)}
        onMouseEnter={(event) => showTableInfo(event.currentTarget)}
        onMouseLeave={() => setHoverInfo(null)}
        onClick={() => onSelect(dataset)}
      >
        <TreeExpander hasChildren />
        <TreeIcon hasChildren icon={<Table2 />} />
        <TreeLabel className="grid min-w-0 gap-1">
          <strong className="truncate text-sm font-black text-slate-950" title={dataset.name}>{dataset.name}</strong>
          <span className="text-xs font-semibold text-slate-500">{dataset.schema.length} columns</span>
        </TreeLabel>
        {selected && <StatusBadge className="ml-auto shrink-0" size="sm" tone="success">선택됨</StatusBadge>}
      </TreeNodeTrigger>
      <TreeNodeContent className="pb-2" hasChildren>
        {dataset.schema.map(([name, type], index) => {
          const Icon = getColumnIcon(type);
          const columnIsLast = index === dataset.schema.length - 1;
          return (
            <TreeNode
              isLast={columnIsLast}
              key={`${dataset.id}-${name}-${index}`}
              level={4}
              nodeId={`${getDatasetNodeId(dataset.id)}:column:${name}:${index}`}
              parentPath={[true, true, isLast, columnIsLast]}
            >
              <TreeNodeTrigger
                aria-level={5}
                className="min-h-10 py-1.5"
                onBlur={() => setHoverInfo(null)}
                onFocus={(event) => showColumnInfo(event.currentTarget, name, type)}
                onMouseEnter={(event) => showColumnInfo(event.currentTarget, name, type)}
                onMouseLeave={() => setHoverInfo(null)}
              >
                <TreeExpander />
                <TreeIcon icon={<Icon />} />
                <TreeLabel className="grid min-w-0 gap-0.5">
                  <strong className="truncate text-sm font-bold text-slate-900" title={name}>{name}</strong>
                  <span className="text-xs font-semibold text-slate-500">{formatColumnType(type)}</span>
                </TreeLabel>
              </TreeNodeTrigger>
            </TreeNode>
          );
        })}
      </TreeNodeContent>
      {hoverInfo && <SqlDatasetHoverCard info={hoverInfo} />}
    </TreeNode>
  );
}

function SqlDatasetHoverCard({ info }: { info: HoverInfo }) {
  const iconClassName = info.kind === "column" ? getColumnKind(info.columnType) : "table";
  const rows = info.kind === "table"
    ? [
      { label: "레이어", value: info.dataset.layer },
      { label: "컬럼", value: `${info.dataset.schema.length}개` },
      { label: "담당자", value: info.dataset.owner },
    ]
    : [
      { label: "유형", value: formatColumnType(info.columnType) },
      { label: "테이블", value: info.dataset.name },
    ];

  return (
    <TreeHoverCard
      as="aside"
      bodyClassName="sql-tree-hover-body"
      className="sql-tree-hover-card"
      description={info.kind === "table" ? info.dataset.description : getColumnDescription(info.columnType)}
      icon={info.kind === "table" ? <Table2 size={22} /> : renderColumnIcon(info.columnType)}
      iconClassName={`sql-tree-hover-icon ${iconClassName}`}
      rowLayout="flat"
      rows={rows}
      style={{ left: info.position.left, top: info.position.top }}
      subtitle={`system.datasets.${info.dataset.name}`}
      title={info.kind === "table" ? info.dataset.name : info.columnName}
    />
  );
}

function getHoverPosition(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const cardWidth = 360;
  const cardHeight = 210;
  const left = Math.min(rect.right + 16, window.innerWidth - cardWidth - 16);
  const top = Math.min(Math.max(16, rect.top - 8), window.innerHeight - cardHeight - 16);

  return { left, top };
}

function getColumnIcon(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return Hash;
  if (kind === "date") return Calendar;
  return Type;
}

function renderColumnIcon(type: string) {
  const Icon = getColumnIcon(type);
  return <Icon size={22} />;
}

function getColumnKind(type: string) {
  const normalized = type.toLowerCase();
  if (normalized.includes("int") || normalized.includes("decimal") || normalized.includes("number") || normalized.includes("float") || normalized.includes("double")) return "number";
  if (normalized.includes("date") || normalized.includes("time")) return "date";
  return "text";
}

function formatColumnType(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return "number";
  if (kind === "date") return "date";
  return "string";
}

function getColumnDescription(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return "집계, 지표, 차트 값으로 사용할 수 있는 숫자 필드입니다.";
  if (kind === "date") return "기간 필터와 시계열 분석 기준으로 사용할 수 있는 날짜/시간 필드입니다.";
  return "그룹화, 필터, 라벨 기준으로 사용할 수 있는 문자열 필드입니다.";
}
