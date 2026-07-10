import { Calendar, Database, Hash, Plus, Server, Table2, Type } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type { CatalogDataset } from "../../types";

type SqlDatasetTreeProps = {
  datasets: CatalogDataset[];
  expandedDatasetId: string | null;
  onSelect: (dataset: CatalogDataset) => void;
  onToggle: (dataset: CatalogDataset) => void;
};

type HoverInfo =
  | { dataset: CatalogDataset; kind: "table" }
  | { columnName: string; columnType: string; dataset: CatalogDataset; kind: "column" };

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
}: {
  dataset: CatalogDataset;
  expanded: boolean;
  isLast: boolean;
  onSelect: (dataset: CatalogDataset) => void;
}) {
  return (
    <TreeNode
      data-sql-dataset-node=""
      isLast={isLast}
      level={3}
      nodeId={getDatasetNodeId(dataset.id)}
      parentPath={[true, true, isLast]}
    >
      <HoverCard closeDelay={100} openDelay={250}>
        <HoverCardTrigger asChild>
          <TreeNodeTrigger
            aria-expanded={expanded}
            aria-level={4}
            className="min-h-14 pr-2"
            data-sql-dataset-row=""
          >
            <TreeExpander hasChildren />
            <TreeIcon hasChildren icon={<Table2 />} />
            <TreeLabel className="grid min-w-0 gap-1">
              <strong className="truncate text-sm font-black text-slate-950" title={dataset.name}>{dataset.name}</strong>
              <span className="text-xs font-semibold text-slate-500">{dataset.schema.length} columns</span>
            </TreeLabel>
            <Button
              aria-label={`${dataset.name} 선택 테이블에 추가`}
              className="ml-auto size-8"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(dataset);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Plus data-icon="inline-start" />
            </Button>
          </TreeNodeTrigger>
        </HoverCardTrigger>
        <SqlDatasetHoverCard info={{ dataset, kind: "table" }} />
      </HoverCard>
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
              <HoverCard closeDelay={100} openDelay={250}>
                <HoverCardTrigger asChild>
                  <TreeNodeTrigger aria-level={5} className="min-h-10 py-1.5">
                    <TreeExpander />
                    <TreeIcon icon={<Icon />} />
                    <TreeLabel className="grid min-w-0 gap-0.5">
                      <strong className="truncate text-sm font-bold text-slate-900" title={name}>{name}</strong>
                      <span className="text-xs font-semibold text-slate-500">{formatColumnType(type)}</span>
                    </TreeLabel>
                  </TreeNodeTrigger>
                </HoverCardTrigger>
                <SqlDatasetHoverCard info={{ columnName: name, columnType: type, dataset, kind: "column" }} />
              </HoverCard>
            </TreeNode>
          );
        })}
      </TreeNodeContent>
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
    <HoverCardContent align="start" className="grid w-[360px] grid-cols-[48px_minmax(0,1fr)] gap-3" side="right" sideOffset={12}>
      <div
        aria-hidden="true"
        className={cn(
          "grid size-12 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600",
          iconClassName === "date" && "text-blue-600",
          iconClassName === "number" && "text-slate-700",
        )}
      >
        {info.kind === "table" ? <Table2 size={22} /> : renderColumnIcon(info.columnType)}
      </div>
      <div className="grid min-w-0 gap-2.5">
        <div className="grid min-w-0 gap-1">
          <strong className="truncate text-base font-black">{info.kind === "table" ? info.dataset.name : info.columnName}</strong>
          <span className="truncate text-xs font-semibold text-slate-500">{`system.datasets.${info.dataset.name}`}</span>
        </div>
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-xs">
          {rows.map((row) => (
            <div className="contents" key={row.label}>
              <dt className="font-bold text-slate-500">{row.label}</dt>
              <dd className="m-0 truncate font-bold text-slate-900">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-xs font-semibold leading-relaxed text-slate-500">
          {info.kind === "table" ? info.dataset.description : getColumnDescription(info.columnType)}
        </p>
      </div>
    </HoverCardContent>
  );
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
