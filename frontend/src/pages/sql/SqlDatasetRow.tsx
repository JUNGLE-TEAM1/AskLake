import { Calendar, Database, Hash, Server, Table2, Type } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import type { NodeApi } from "react-arborist";
import { ExplorerTree, type ExplorerTreeNode } from "@/components/ui/explorer-tree";
import { TreeHoverCard } from "@/components/ui/tree-hover-card";
import { cn } from "@/lib/utils";
import type { CatalogDataset } from "../../types";
import styles from "./SqlDatasetRow.module.css";

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
const DATASET_NODE_PREFIX = "sql-tree:dataset:";

type SqlDatasetNode = ExplorerTreeNode & {
  children?: SqlDatasetNode[];
  columnName?: string;
  columnType?: string;
  dataset?: CatalogDataset;
  kind: "column" | "dataset" | "group";
  selected?: boolean;
};

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
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const datasetsRef = useRef(datasets);
  datasetsRef.current = datasets;
  const getNodeIcon = useCallback((node: NodeApi<SqlDatasetNode>) => {
    if (node.data.kind === "dataset") return <Table2 className="text-blue-600" />;
    if (node.data.kind === "column") {
      const Icon = getColumnIcon(node.data.columnType ?? "");
      return <Icon className={getColumnIconClassName(node.data.columnType ?? "")} />;
    }
    if (node.id === SYSTEM_NODE_ID) return <Server className="text-blue-700" />;
    if (node.id === DATASETS_NODE_ID) return <Database className="text-cyan-600" />;
    return <Table2 className="text-indigo-600" />;
  }, []);
  const getNodeRowProps = useCallback((node: NodeApi<SqlDatasetNode>) => ({
    "aria-pressed": node.data.selected || undefined,
    "data-sql-dataset-node": node.data.kind === "dataset" ? "" : undefined,
    "data-sql-dataset-row": node.data.kind === "dataset" ? "" : undefined,
    "data-sql-dataset-selected": node.data.selected ? "" : undefined,
    onBlur: () => setHoverInfo(null),
    onFocus: (event: FocusEvent<HTMLButtonElement>) => showSqlNodeHover(node.data, event.currentTarget, setHoverInfo),
    onMouseEnter: (event: MouseEvent<HTMLButtonElement>) => showSqlNodeHover(node.data, event.currentTarget, setHoverInfo),
    onMouseLeave: () => setHoverInfo(null),
    onClick: node.data.kind === "dataset" && node.data.dataset
      ? (event: MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          onSelectRef.current(node.data.dataset as CatalogDataset);
        }
      : undefined,
    title: node.data.label,
  }), []);
  const treeData = useMemo<SqlDatasetNode[]>(() => [{
    children: [{
      children: [{
        children: datasets.map((dataset) => ({
          children: dataset.schema.map(([name, type], index) => ({
            columnName: name,
            columnType: type,
            dataset,
            id: `${getDatasetNodeId(dataset.id)}:column:${name}:${index}`,
            kind: "column" as const,
            label: name,
            meta: formatColumnType(type),
            selectable: false,
          })),
          dataset,
          id: getDatasetNodeId(dataset.id),
          kind: "dataset" as const,
          label: dataset.name,
          selected: selectedDatasetIds.has(dataset.id),
          selectable: false,
        })),
        id: TABLES_NODE_ID,
        kind: "group" as const,
        label: "테이블",
        meta: `${datasets.length}개`,
        selectable: false,
      }],
      id: DATASETS_NODE_ID,
      kind: "group" as const,
      label: "datasets",
      selectable: false,
    }],
    id: SYSTEM_NODE_ID,
    kind: "group" as const,
    label: "system",
    selectable: false,
  }], [datasets, selectedDatasetIds]);
  const initialOpenState = useMemo(() => ({
    [SYSTEM_NODE_ID]: true,
    [DATASETS_NODE_ID]: true,
    [TABLES_NODE_ID]: true,
    ...(expandedDatasetId ? { [getDatasetNodeId(expandedDatasetId)]: true } : {}),
  }), [expandedDatasetId]);
  const handleNodeToggle = useCallback((nodeId: string) => {
    if (!nodeId.startsWith(DATASET_NODE_PREFIX)) return;
    const datasetId = nodeId.slice(DATASET_NODE_PREFIX.length);
    const dataset = datasetsRef.current.find((entry) => entry.id === datasetId);
    if (dataset) onToggleRef.current(dataset);
  }, []);

  if (datasets.length === 0) return null;

  return (
    <>
      <ExplorerTree<SqlDatasetNode>
        key={expandedDatasetId ?? "closed"}
        ariaLabel="분석 데이터셋 트리"
        className="sql-dataset-tree mt-2 h-[calc(100%-0.5rem)] min-w-0"
        data={treeData}
        defaultHeight={520}
        disableMultiSelection
        disableSelect
        getIcon={getNodeIcon}
        getRowProps={getNodeRowProps}
        initialOpenState={initialOpenState}
        indent={12}
        minHeight={320}
        openByDefault={false}
        rowHeight={40}
        toggleOnRowPress={false}
        onToggle={handleNodeToggle}
      />
      {hoverInfo && <SqlDatasetHoverCard info={hoverInfo} />}
    </>
  );
}

function showSqlNodeHover(
  node: SqlDatasetNode,
  target: HTMLElement,
  setHoverInfo: (info: HoverInfo | null) => void,
) {
  if (!node.dataset) return;
  if (node.kind === "dataset") {
    setHoverInfo({ dataset: node.dataset, kind: "table", position: getHoverPosition(target) });
  } else if (node.kind === "column" && node.columnName && node.columnType) {
    setHoverInfo({
      columnName: node.columnName,
      columnType: node.columnType,
      dataset: node.dataset,
      kind: "column",
      position: getHoverPosition(target),
    });
  }
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
      bodyClassName={styles.hoverBody}
      className={styles.hoverCard}
      description={info.kind === "table" ? info.dataset.description : getColumnDescription(info.columnType)}
      icon={info.kind === "table" ? <Table2 size={22} /> : renderColumnIcon(info.columnType)}
      iconClassName={cn(styles.hoverIcon, styles[iconClassName])}
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

function getColumnIconClassName(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return "text-violet-600";
  if (kind === "date") return "text-emerald-600";
  return "text-sky-600";
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
