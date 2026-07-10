import { useMemo, type ReactNode } from "react";
import { AlertCircle, CalendarDays, Database, Hash, LetterText, Server, Table2 } from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TreeHoverCard } from "@/components/ui/tree-hover-card";
import { cn } from "@/lib/utils";
import type { DashboardDatasetColumn, DashboardDatasetOption } from "./dashboardRuntimeTypes";

type DatasetSidebarProps = {
  datasets: DashboardDatasetOption[];
  error?: Error | null;
  isOpen?: boolean;
  isLoading?: boolean;
  onSelectColumn?: (dataset: DashboardDatasetOption, column: DashboardDatasetColumn) => void;
  onSelectDataset: (datasetId: string) => void;
  selectedDatasetId: string | null;
};

type DatasetTreeNode = {
  children?: DatasetTreeNode[];
  columnName?: string;
  datasetId?: string;
  hoverCard?: ReactNode;
  icon: ReactNode;
  id: string;
  kind: "column" | "dataset" | "group";
  meta?: string;
  selected?: boolean;
  title: string;
};

const COLUMN_ITEM_PREFIX = "column:";
const DATASET_ITEM_PREFIX = "dataset:";
const systemItemId = "dataset-tree-system";
const schemaItemId = "dataset-tree-schema";
const tablesItemId = "dataset-tree-tables";

function datasetTreeItemId(datasetId: string) {
  return `${DATASET_ITEM_PREFIX}${datasetId}`;
}

function columnTreeItemId(datasetId: string, columnName: string) {
  return `${COLUMN_ITEM_PREFIX}${datasetId}:${columnName}`;
}

function columnTypeLabel(type: DashboardDatasetColumn["type"]) {
  if (type === "number") return "number";
  if (type === "date") return "date";
  return "string";
}

function ColumnTypeIcon({ type }: { type: DashboardDatasetColumn["type"] }) {
  if (type === "number") return <Hash />;
  if (type === "date") return <CalendarDays />;
  return <LetterText />;
}

function columnDescription(column: DashboardDatasetColumn) {
  if (column.type === "number") return "Numeric field available for metrics and chart values.";
  if (column.type === "date") return "Date field available for period filters and time axes.";
  return "Text field available for labels, groups, and status values.";
}

function metricCount(dataset: DashboardDatasetOption) {
  return dataset.columns.filter((column) => column.type === "number").length;
}

function DatasetHoverCard({
  description,
  icon,
  rows,
  subtitle,
  title,
}: {
  description: string;
  icon: ReactNode;
  rows: Array<{ label: string; value: string }>;
  subtitle?: string;
  title: string;
}) {
  return (
    <TreeHoverCard
      className="asklake-dataset-hover-card"
      description={description}
      headerClassName="asklake-dataset-hover-card-head"
      icon={icon}
      iconClassName="asklake-dataset-hover-card-icon"
      rows={rows}
      subtitle={subtitle}
      title={title}
    />
  );
}

function DatasetTreeLabel({
  hoverCard,
  meta,
  selected = false,
  title,
}: {
  hoverCard?: ReactNode;
  meta?: string;
  selected?: boolean;
  title: string;
}) {
  const label = (
    <span className={cn("grid min-w-0 gap-0.5", selected && "text-blue-700")}>
      <strong className="truncate text-sm font-semibold text-slate-950">{title}</strong>
      {meta && <span className="truncate text-xs font-medium text-slate-500">{meta}</span>}
    </span>
  );

  if (!hoverCard) return label;

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent align="start" className="asklake-dataset-hover-tooltip" side="right" sideOffset={12}>
        {hoverCard}
      </TooltipContent>
    </Tooltip>
  );
}

function DashboardDatasetTreeItems({
  datasets,
  items,
  level = 0,
  onSelectColumn,
  onSelectDataset,
  parentPath = [],
}: {
  datasets: DashboardDatasetOption[];
  items: DatasetTreeNode[];
  level?: number;
  onSelectColumn?: (dataset: DashboardDatasetOption, column: DashboardDatasetColumn) => void;
  onSelectDataset: (datasetId: string) => void;
  parentPath?: boolean[];
}) {
  const activateItem = (item: DatasetTreeNode) => {
    if (item.kind === "dataset" && item.datasetId) {
      onSelectDataset(item.datasetId);
      return;
    }

    if (item.kind !== "column" || !item.datasetId || !item.columnName) return;
    const dataset = datasets.find((entry) => entry.id === item.datasetId);
    const column = dataset?.columns.find((entry) => entry.name === item.columnName);
    if (dataset && column) onSelectColumn?.(dataset, column);
  };

  return items.map((item, index) => {
    const hasChildren = Boolean(item.children?.length);
    const isLast = index === items.length - 1;
    const nextParentPath = [...parentPath, isLast];

    return (
      <TreeNode isLast={isLast} key={item.id} level={level} nodeId={item.id} parentPath={parentPath}>
        <TreeNodeTrigger
          aria-selected={item.selected || undefined}
          aria-level={level + 1}
          className={cn("min-h-10", item.selected && "bg-blue-50")}
          data-dashboard-dataset-node={item.kind}
          onClick={() => activateItem(item)}
        >
          <TreeExpander hasChildren={hasChildren} />
          <TreeIcon hasChildren={hasChildren} icon={item.icon} />
          <TreeLabel className="min-w-0">
            <DatasetTreeLabel
              hoverCard={item.hoverCard}
              meta={item.meta}
              selected={item.selected}
              title={item.title}
            />
          </TreeLabel>
        </TreeNodeTrigger>
        <TreeNodeContent hasChildren={hasChildren}>
          {item.children && (
            <DashboardDatasetTreeItems
              datasets={datasets}
              items={item.children}
              level={level + 1}
              onSelectColumn={onSelectColumn}
              onSelectDataset={onSelectDataset}
              parentPath={nextParentPath}
            />
          )}
        </TreeNodeContent>
      </TreeNode>
    );
  });
}

function DatasetTreeSkeleton() {
  return (
    <div aria-label="Dataset tree loading" className="grid gap-3 p-3" role="status">
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="ml-5 h-9 w-3/4" />
      <Skeleton className="ml-10 h-9 w-4/5" />
      <Skeleton className="ml-14 h-12 w-3/4" />
    </div>
  );
}

export function DatasetSidebar({
  datasets,
  error = null,
  isOpen = true,
  isLoading = false,
  onSelectColumn,
  onSelectDataset,
  selectedDatasetId,
}: DatasetSidebarProps) {
  const totalColumnCount = useMemo(
    () => datasets.reduce((total, dataset) => total + dataset.columns.length, 0),
    [datasets],
  );
  const totalMetricCount = useMemo(
    () => datasets.reduce((total, dataset) => total + metricCount(dataset), 0),
    [datasets],
  );
  const treeData = useMemo<DatasetTreeNode[]>(() => [
    {
      children: [
        {
          children: [
            {
              children: datasets.map((dataset) => {
                const numericColumnCount = metricCount(dataset);
                return {
                  children: dataset.columns.map((column) => ({
                    columnName: column.name,
                    datasetId: dataset.id,
                    hoverCard: (
                      <DatasetHoverCard
                        description={columnDescription(column)}
                        icon={<ColumnTypeIcon type={column.type} />}
                        rows={[
                          { label: "type", value: columnTypeLabel(column.type) },
                          { label: "table", value: dataset.name },
                        ]}
                        subtitle={`system.datasets.${dataset.name}`}
                        title={column.name}
                      />
                    ),
                    icon: <ColumnTypeIcon type={column.type} />,
                    id: columnTreeItemId(dataset.id, column.name),
                    kind: "column" as const,
                    meta: columnTypeLabel(column.type),
                    title: column.name,
                  })),
                  datasetId: dataset.id,
                  hoverCard: (
                    <DatasetHoverCard
                      description={dataset.description ?? "Dataset available for dashboard widgets."}
                      icon={<Table2 />}
                      rows={[
                        { label: "owner", value: "System user" },
                        { label: "updated", value: dataset.updatedAt ?? "unknown" },
                        { label: "columns", value: `${dataset.columns.length}` },
                        { label: "metrics", value: `${numericColumnCount}` },
                      ]}
                      subtitle="system.datasets"
                      title={dataset.name}
                    />
                  ),
                  icon: <Table2 />,
                  id: datasetTreeItemId(dataset.id),
                  kind: "dataset" as const,
                  meta: `${dataset.columns.length} columns`,
                  selected: dataset.id === selectedDatasetId,
                  title: dataset.name,
                };
              }),
              hoverCard: (
                <DatasetHoverCard
                  description="Tables available as widget sources."
                  icon={<Table2 />}
                  rows={[
                    { label: "tables", value: `${datasets.length}` },
                    { label: "columns", value: `${totalColumnCount}` },
                    { label: "metrics", value: `${totalMetricCount}` },
                  ]}
                  subtitle="system.datasets"
                  title={`tables (${datasets.length})`}
                />
              ),
              icon: <Table2 />,
              id: tablesItemId,
              kind: "group",
              title: `tables (${datasets.length})`,
            },
          ],
          hoverCard: (
            <DatasetHoverCard
              description="Dataset group available for dashboard widget creation."
              icon={<Database />}
              rows={[
                { label: "owner", value: "System user" },
                { label: "tables", value: `${datasets.length}` },
                { label: "columns", value: `${totalColumnCount}` },
              ]}
              subtitle="system"
              title="datasets"
            />
          ),
          icon: <Database />,
          id: schemaItemId,
          kind: "group",
          title: "datasets",
        },
      ],
      hoverCard: (
        <DatasetHoverCard
          description="Dataset catalog available for dashboard widgets."
          icon={<Server />}
          rows={[
            { label: "owner", value: "System user" },
            { label: "updated", value: "1 hour ago" },
            { label: "tables", value: `${datasets.length}` },
          ]}
          title="system"
        />
      ),
      icon: <Server />,
      id: systemItemId,
      kind: "group",
      title: "system",
    },
  ], [datasets, selectedDatasetId, totalColumnCount, totalMetricCount]);

  return (
    <aside
      aria-hidden={!isOpen}
      aria-label="Dataset"
      className="asklake-dashboard-dataset-sidebar"
      id="asklake-dashboard-dataset-sidebar"
    >
      <PanelHeader className="min-h-0 border-b border-slate-200 p-4" icon={<Database />} title="Dataset" />

      {isLoading ? (
        <DatasetTreeSkeleton />
      ) : error ? (
        <Alert className="m-3 w-auto" variant="destructive">
          <AlertCircle />
          <AlertTitle>Dataset을 불러오지 못했습니다.</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : datasets.length === 0 ? (
        <Empty className="m-3" size="sm" variant="bordered">
          <EmptyHeader>
            <EmptyTitle>사용 가능한 Dataset이 없습니다.</EmptyTitle>
            <EmptyDescription>Catalog에서 Dataset을 준비한 뒤 다시 시도해 주세요.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <TooltipProvider delayDuration={250}>
          <ScrollArea className="h-[min(760px,calc(100vh-240px))] min-h-[260px]" type="always">
            <TreeProvider
              className="pr-3"
              defaultExpandedIds={[systemItemId, schemaItemId, tablesItemId]}
              indent={18}
              selectable={false}
              showLines
            >
              <TreeView aria-label="Dashboard dataset tree" className="p-2">
                <DashboardDatasetTreeItems
                  datasets={datasets}
                  items={treeData}
                  onSelectColumn={onSelectColumn}
                  onSelectDataset={onSelectDataset}
                />
              </TreeView>
            </TreeProvider>
          </ScrollArea>
        </TooltipProvider>
      )}
    </aside>
  );
}
