import { useMemo, type ReactNode } from "react";
import { CalendarDays, Database, Hash, LetterText, Server, Table2 } from "lucide-react";
import {
  TreeExpander,
  TreeIcon,
  TreeNode,
  TreeNodeContent,
  TreeNodeTrigger,
  TreeProvider,
  TreeView,
} from "@/components/kibo-ui/tree";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TreeHoverCard } from "@/components/ui/tree-hover-card";
import { TreePanel } from "@/components/ui/tree-panel";
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
  if (type === "number") return <Hash size={15} />;
  if (type === "date") return <CalendarDays size={15} />;
  return <LetterText size={15} />;
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
  icon,
  meta,
  selected = false,
  title,
}: {
  hoverCard?: ReactNode;
  icon?: ReactNode;
  meta?: string;
  selected?: boolean;
  title: string;
}) {
  const label = (
    <span className={selected ? "flex min-w-0 flex-1 items-center gap-2 text-blue-700" : "flex min-w-0 flex-1 items-center gap-2"}>
      {icon ? <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">{icon}</span> : null}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
        {meta ? <em className="truncate text-xs not-italic text-muted-foreground">{meta}</em> : null}
      </span>
    </span>
  );

  if (!hoverCard) return label;

  return (
    <Tooltip
      delayDuration={250}
    >
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent align="start" className="asklake-dataset-hover-tooltip" side="right" sideOffset={12}>
        {hoverCard}
      </TooltipContent>
    </Tooltip>
  );
}

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

function DatasetTreeBranch({
  level = 0,
  node,
  parentPath = [],
  position,
  siblingCount,
}: {
  level?: number;
  node: DatasetTreeNode;
  parentPath?: boolean[];
  position: number;
  siblingCount: number;
}) {
  const hasChildren = Boolean(node.children?.length);
  const isLast = position === siblingCount - 1;
  const nextParentPath = [...parentPath, isLast];

  return (
    <TreeNode isLast={isLast} level={level} nodeId={node.id} parentPath={parentPath}>
      <TreeNodeTrigger className="min-h-9">
        <TreeExpander hasChildren={hasChildren} />
        <TreeIcon hasChildren={hasChildren} icon={node.icon} />
        <DatasetTreeLabel
          hoverCard={node.hoverCard}
          meta={node.meta}
          selected={node.selected}
          title={node.title}
        />
      </TreeNodeTrigger>
      <TreeNodeContent hasChildren={hasChildren}>
        {node.children?.map((child, index) => (
          <DatasetTreeBranch
            key={child.id}
            level={level + 1}
            node={child}
            parentPath={nextParentPath}
            position={index}
            siblingCount={node.children?.length ?? 0}
          />
        ))}
      </TreeNodeContent>
    </TreeNode>
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
                const isSelected = dataset.id === selectedDatasetId;
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
                    kind: "column",
                    meta: columnTypeLabel(column.type),
                    title: column.name,
                  })),
                  datasetId: dataset.id,
                  hoverCard: (
                    <DatasetHoverCard
                      description={dataset.description ?? "Dataset available for dashboard widgets."}
                      icon={<Table2 size={18} />}
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
                  icon: <Table2 size={15} />,
                  id: datasetTreeItemId(dataset.id),
                  kind: "dataset",
                  meta: `${dataset.columns.length} columns`,
                  selected: isSelected,
                  title: dataset.name,
                };
              }),
              hoverCard: (
                <DatasetHoverCard
                  description="Tables available as widget sources."
                  icon={<Table2 size={18} />}
                  rows={[
                    { label: "tables", value: `${datasets.length}` },
                    { label: "columns", value: `${totalColumnCount}` },
                    { label: "metrics", value: `${totalMetricCount}` },
                  ]}
                  subtitle="system.datasets"
                  title={`tables (${datasets.length})`}
                />
              ),
              icon: <Table2 size={15} />,
              id: tablesItemId,
              kind: "group",
              title: `tables (${datasets.length})`,
            },
          ],
          hoverCard: (
            <DatasetHoverCard
              description="Dataset group available for dashboard widget creation."
              icon={<Database size={18} />}
              rows={[
                { label: "owner", value: "System user" },
                { label: "tables", value: `${datasets.length}` },
                { label: "columns", value: `${totalColumnCount}` },
              ]}
              subtitle="system"
              title="datasets"
            />
          ),
          icon: <Database size={15} />,
          id: schemaItemId,
          kind: "group",
          title: "datasets",
        },
      ],
      hoverCard: (
        <DatasetHoverCard
          description="Dataset catalog available for dashboard widgets."
          icon={<Server size={18} />}
          rows={[
            { label: "owner", value: "System user" },
            { label: "updated", value: "1 hour ago" },
            { label: "tables", value: `${datasets.length}` },
          ]}
          title="system"
        />
      ),
      icon: <Server size={15} />,
      id: systemItemId,
      kind: "group",
      title: "system",
    },
  ], [datasets, selectedDatasetId, totalColumnCount, totalMetricCount]);
  const handleTreeSelection = (selectedIds: string[]) => {
    const selectedId = selectedIds.at(-1);
    if (!selectedId) return;
    const datasetId = selectedId.startsWith(DATASET_ITEM_PREFIX)
      ? selectedId.slice(DATASET_ITEM_PREFIX.length)
      : selectedId.startsWith(COLUMN_ITEM_PREFIX)
        ? selectedId.slice(COLUMN_ITEM_PREFIX.length).split(":")[0]
        : null;
    if (!datasetId) return;

    if (selectedId.startsWith(DATASET_ITEM_PREFIX)) {
      onSelectDataset(datasetId);
      return;
    }

    const columnName = selectedId.slice(COLUMN_ITEM_PREFIX.length + datasetId.length + 1);
    const dataset = datasets.find((entry) => entry.id === datasetId);
    const column = dataset?.columns.find((entry) => entry.name === columnName);
    if (!dataset || !column) return;
    onSelectColumn?.(dataset, column);
  };

  return (
    <aside
      aria-hidden={!isOpen}
      aria-label="Dataset"
      className="asklake-dashboard-dataset-sidebar"
      id="asklake-dashboard-dataset-sidebar"
    >
      <div className="asklake-dataset-sidebar-header">
        <h2>Dataset</h2>
      </div>

      <TooltipProvider delayDuration={250}>
        <TreePanel
          bodyClassName="asklake-dataset-tree-wrap"
          emptyState="No datasets available."
          errorState="Failed to load datasets. Please try again."
          isEmpty={datasets.length === 0}
          isError={Boolean(error)}
          isLoading={isLoading}
          loadingState="Loading datasets..."
          stateClassName={error && !isLoading ? "asklake-dataset-sidebar-state error" : "asklake-dataset-sidebar-state"}
        >
          <ScrollArea className="asklake-dataset-tree-wrap">
            <TreeProvider
              animateExpand={false}
              defaultExpandedIds={[
                systemItemId,
                schemaItemId,
                tablesItemId,
                ...datasets.map((dataset) => datasetTreeItemId(dataset.id)),
              ]}
              indent={18}
              selectedIds={selectedDatasetId ? [datasetTreeItemId(selectedDatasetId)] : []}
              onSelectionChange={handleTreeSelection}
            >
              <TreeView aria-label="Dashboard dataset tree" className="asklake-dataset-tree">
                {treeData.map((node, index) => (
                  <DatasetTreeBranch
                    key={node.id}
                    node={node}
                    position={index}
                    siblingCount={treeData.length}
                  />
                ))}
              </TreeView>
            </TreeProvider>
          </ScrollArea>
        </TreePanel>
      </TooltipProvider>
    </aside>
  );
}
