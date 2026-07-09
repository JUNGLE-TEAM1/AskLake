import { useMemo, type ReactNode } from "react";
import { CalendarDays, Database, Hash, LetterText, Server, Table2 } from "lucide-react";
import Tooltip from "@mui/material/Tooltip";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
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
const datasetTreeRowHeight = 38;
const hoverTooltipSlotProps = {
  arrow: { className: "asklake-dataset-hover-arrow" },
  tooltip: { className: "asklake-dataset-hover-tooltip" },
};

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
  icon: ReactNode;
  meta?: string;
  selected?: boolean;
  title: string;
}) {
  const label = (
    <span className={selected ? "asklake-dataset-tree-label selected" : "asklake-dataset-tree-label"}>
      <span className="asklake-dataset-tree-icon" aria-hidden="true">{icon}</span>
      <span className="asklake-dataset-tree-copy">
        <strong>{title}</strong>
        {meta && <em>{meta}</em>}
      </span>
    </span>
  );

  if (!hoverCard) return label;

  return (
    <Tooltip
      arrow
      describeChild
      enterDelay={250}
      enterNextDelay={120}
      leaveDelay={80}
      placement="right-start"
      slotProps={hoverTooltipSlotProps}
      title={hoverCard}
    >
      {label}
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

function DatasetTreeNodeRow({ node, style }: NodeRendererProps<DatasetTreeNode>) {
  return (
    <div
      className={[
        "asklake-dataset-tree-row",
        node.isSelected ? "selected" : "",
        node.isInternal ? "branch" : "leaf",
      ].filter(Boolean).join(" ")}
      style={style}
    >
      <button
        aria-expanded={node.isInternal ? node.isOpen : undefined}
        className="asklake-dataset-tree-node"
        type="button"
        onClick={() => {
          if (node.isInternal) node.toggle();
          node.activate();
        }}
      >
        <span className="asklake-dataset-tree-toggle" aria-hidden="true">
          {node.isInternal ? (node.isOpen ? "v" : ">") : ""}
        </span>
        <DatasetTreeLabel
          hoverCard={node.data.hoverCard}
          icon={node.data.icon}
          meta={node.data.meta}
          selected={node.data.selected || node.isSelected}
          title={node.data.title}
        />
      </button>
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
  const treeHeight = Math.max(260, Math.min(760, 120 + (totalColumnCount + datasets.length) * datasetTreeRowHeight));

  const handleActivateTreeItem = (node: NodeApi<DatasetTreeNode>) => {
    const item = node.data;

    if (item.kind === "dataset" && item.datasetId) {
      onSelectDataset(item.datasetId);
      return;
    }

    if (item.kind !== "column" || !item.datasetId || !item.columnName) return;
    const dataset = datasets.find((entry) => entry.id === item.datasetId);
    const column = dataset?.columns.find((entry) => entry.name === item.columnName);
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
        <Tree<DatasetTreeNode>
          aria-label="Dashboard dataset tree"
          className="asklake-dataset-tree"
          data={treeData}
          disableDrag
          disableEdit
          height={treeHeight}
          idAccessor="id"
          indent={18}
          openByDefault
          overscanCount={6}
          rowHeight={datasetTreeRowHeight}
          selection={selectedDatasetId ? datasetTreeItemId(selectedDatasetId) : undefined}
          width="100%"
          onActivate={handleActivateTreeItem}
        >
          {DatasetTreeNodeRow}
        </Tree>
      </TreePanel>
    </aside>
  );
}
